import * as sqliteVec from 'sqlite-vec';
import { bus } from '../bus.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';

const log = logger('search');

export interface Hit { source_type: string; source_id: string; project_id: string | null; task_id: string | null; team_id: string | null; created_at: string; text: string; score: number; via: 'fts' | 'like' | 'vector' }

interface IndexedEvent { sourceType: string; sourceId: string; text: string; teamId: string | null; projectId: string | null }

/** 검색: FTS5(trigram) 기본 + 설정 시 벡터(sqlite-vec). */
export class Search {
  private vecReady = false;
  private dim = 0;
  private queue: IndexedEvent[] = [];
  private draining = false;

  constructor(private store: Store) {
    try { sqliteVec.load(store.db); this.vecReady = true; } catch (e) { log.warn('sqlite-vec 로드 실패, 벡터 검색 꺼짐', e); }
    const meta = store.getKv<{ dim: number } | null>('vec_meta', null);
    if (meta && this.vecReady) this.dim = meta.dim;
    bus.on('indexed', (e: IndexedEvent) => { if (this.enabled()) { this.queue.push(e); void this.drain(); } });
  }

  enabled(): boolean { return this.vecReady && this.store.getSettings().embedding.provider !== 'off'; }

  async embed(texts: string[]): Promise<number[][]> {
    const e = this.store.getSettings().embedding;
    if (e.provider === 'ollama') {
      const r = await fetch(`${e.url.replace(/\/$/, '')}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: e.model, input: texts }), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Ollama 임베딩 실패 ${r.status}`);
      return ((await r.json()) as { embeddings: number[][] }).embeddings;
    }
    if (e.provider === 'voyage') {
      const key = process.env.VOYAGE_API_KEY;
      if (!key) throw new Error('VOYAGE_API_KEY 환경 변수가 없습니다');
      const r = await fetch('https://api.voyageai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: e.model || 'voyage-3.5', input: texts }), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Voyage 임베딩 실패 ${r.status}`);
      return ((await r.json()) as { data: { embedding: number[] }[] }).data.map((d) => d.embedding);
    }
    throw new Error('임베딩이 꺼져 있습니다');
  }

  private ensureVecTable(dim: number): void {
    if (this.dim === dim) return;
    if (this.dim && this.dim !== dim) this.store.db.exec('DROP TABLE IF EXISTS search_vec');
    this.store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_vec USING vec0(embedding float[${dim}])`);
    this.dim = dim;
    this.store.setKv('vec_meta', { dim });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.enabled()) {
        const batch = this.queue.splice(0, 16);
        const rows = batch.map((b) => this.store.db.prepare('SELECT rowid FROM fts_map WHERE source_type = ? AND source_id = ? ORDER BY rowid DESC LIMIT 1').get(b.sourceType, b.sourceId) as { rowid: number } | undefined);
        const vecs = await this.embed(batch.map((b) => b.text.slice(0, 4000)));
        if (!vecs[0]) continue;
        this.ensureVecTable(vecs[0].length);
        const ins = this.store.db.prepare('INSERT OR REPLACE INTO search_vec(rowid, embedding) VALUES (?, ?)');
        vecs.forEach((v, i) => { const r = rows[i]; if (r) ins.run(BigInt(r.rowid), new Float32Array(v)); });
      }
    } catch (e) {
      log.warn('벡터 색인 실패(나중에 「다시 색인」으로 채울 수 있음)', e);
      this.queue = [];
    } finally { this.draining = false; }
  }

  /** 지금까지의 FTS 기록 전체를 벡터로 다시 색인. */
  async reindexAll(): Promise<number> {
    if (!this.enabled()) throw new Error('임베딩이 꺼져 있습니다');
    const rows = this.store.db.prepare('SELECT rowid, text FROM search_fts').all() as { rowid: number; text: string }[];
    let n = 0;
    for (let i = 0; i < rows.length; i += 32) {
      const batch = rows.slice(i, i + 32);
      const vecs = await this.embed(batch.map((r) => r.text.slice(0, 4000)));
      if (!vecs[0]) continue;
      this.ensureVecTable(vecs[0].length);
      const ins = this.store.db.prepare('INSERT OR REPLACE INTO search_vec(rowid, embedding) VALUES (?, ?)');
      vecs.forEach((v, j) => ins.run(BigInt(batch[j]!.rowid), new Float32Array(v)));
      n += batch.length;
    }
    return n;
  }

  async search(q: string, opts: { projectId?: string | null; teamIds?: string[] | null; limit?: number } = {}): Promise<Hit[]> {
    const limit = opts.limit ?? 20;
    const term = q.trim();
    if (!term) return [];
    const filters: string[] = [];
    const args: unknown[] = [];
    if (opts.projectId) { filters.push('project_id = ?'); args.push(opts.projectId); }
    if (opts.teamIds) { filters.push(`team_id IN (${opts.teamIds.map(() => '?').join(',') || "''"})`); args.push(...opts.teamIds); }
    const where = filters.length ? ' AND ' + filters.join(' AND ') : '';
    const hits: (Hit & { rowid?: number })[] = [];
    const words = term.split(/\s+/).filter(Boolean);
    if (words.every((w) => [...w].length >= 3)) {
      const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
      const rows = this.store.db.prepare(`SELECT rowid, *, bm25(search_fts) AS score FROM search_fts WHERE search_fts MATCH ?${where} ORDER BY score LIMIT ?`).all(match, ...args, limit) as (Hit & { rowid: number })[];
      hits.push(...rows.map((r) => ({ ...r, via: 'fts' as const })));
    } else {
      const like = words.map(() => 'text LIKE ?').join(' AND ');
      const rows = this.store.db.prepare(`SELECT rowid, *, 0 AS score FROM search_fts WHERE ${like}${where} ORDER BY rowid DESC LIMIT ?`).all(...words.map((w) => `%${w}%`), ...args, limit) as (Hit & { rowid: number })[];
      hits.push(...rows.map((r) => ({ ...r, via: 'like' as const })));
    }
    if (this.enabled() && this.dim) {
      try {
        const [v] = await this.embed([term]);
        if (v && v.length === this.dim) {
          const near = this.store.db.prepare('SELECT rowid, distance FROM search_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?').all(new Float32Array(v), limit * 2) as { rowid: number; distance: number }[];
          const seen = new Set(hits.map((h) => `${h.source_type}:${h.source_id}`));
          for (const n of near) {
            const r = this.store.db.prepare(`SELECT rowid, * FROM search_fts WHERE rowid = ?${where}`).get(n.rowid, ...args) as (Hit & { rowid: number }) | undefined;
            if (!r || seen.has(`${r.source_type}:${r.source_id}`)) continue;
            seen.add(`${r.source_type}:${r.source_id}`);
            hits.push({ ...r, score: n.distance, via: 'vector' });
            if (hits.length >= limit * 2) break;
          }
        }
      } catch (e) { log.warn('벡터 검색 실패, 전문 검색 결과만', e); }
    }
    return hits.slice(0, limit * 2).map(({ rowid: _r, ...h }) => ({ ...h, text: h.text.slice(0, 600) }) as Hit);
  }
}
