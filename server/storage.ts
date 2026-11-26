import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import type { StorageView } from '../shared/types.ts';
import type { Store } from './store.ts';
import { run } from './util.ts';
import { serverLang, st } from './i18n.ts';

/** 표 이름 → 화면 묶음(이름·설명은 보고서를 만들 때 그 언어로) */
const GROUPS = (): [RegExp, string, string][] => [
  [/^agent_events/, st('팀원 진행 기록'), st('끝난 지 14일 지난 팀 것은 자동 삭제')],
  [/^runs/, st('명령 실행 기록'), st('끝난 지 14일 지난 팀 것은 자동 삭제')],
  [/^search_vec/, st('벡터 색인'), st('임베딩을 끄고 다시 색인하지 않으면 그대로')],
  [/^(search_fts|fts_map)/, st('전문 검색 색인'), st('기록과 함께 늘어남')],
  [/^messages/, st('팀 대화'), st('계속 보관')],
  [/^po_chat/, st('총괄 대화'), st('계속 보관')],
  [/^(work_summaries|file_changes|checklist)/, st('요약·바뀐 파일·할 일'), st('계속 보관')],
  [/^(po_events|po_decisions)/, st('총괄 사건·결정'), st('처리된 사건은 14일 뒤 삭제')],
  [/^resource_samples/, st('리소스 측정'), st('하루치만')],
  [/^(script_runs|scripts)/, st('스크립트·실행 기록'), st('실행 출력 최대 40만 자씩')],
];

const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };

async function du(path: string): Promise<number | null> {
  if (!existsSync(path)) return 0;
  const r = await run('du', ['-sk', path], { timeoutMs: 30_000 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

let cache: { at: number; lang: string; v: StorageView } | null = null;

/** Hivelane 이 쓰는 저장 공간: DB(표 묶음별)·폴더·Ollama 모델 */
export async function storageReport(cfg: AppConfig, store: Store, fresh = false): Promise<StorageView> {
  if (!fresh && cache && cache.lang === serverLang() && Date.now() - cache.at < 60_000) return cache.v;
  const db = store.db;
  const owner = new Map((db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string; tbl_name: string }[]).map((r) => [r.name, r.tbl_name]));
  let byTable: { name: string; bytes: number }[] = [];
  try { byTable = db.prepare('SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name').all() as { name: string; bytes: number }[]; } catch { /* dbstat 없음 */ }
  const groups = new Map<string, { label: string; note: string; bytes: number }>();
  const defs = GROUPS();
  for (const t of byTable) {
    const tbl = owner.get(t.name) ?? t.name;
    const g = defs.find(([re]) => re.test(tbl));
    const key = g ? g[1] : st('기타(설정·팀·프로젝트 등)');
    const cur = groups.get(key) ?? { label: key, note: g ? g[2] : '', bytes: 0 };
    cur.bytes += t.bytes;
    groups.set(key, cur);
  }
  const pageSize = (db.pragma('page_size', { simple: true }) as number) || 4096;
  const free = ((db.pragma('freelist_count', { simple: true }) as number) || 0) * pageSize;
  const count = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
  const archiveDir = join(cfg.home, 'archive');
  const [worktrees, archive, logs, uploads, po, standing, ollama] = await Promise.all([
    du(cfg.worktreesDir), du(archiveDir), du(cfg.logsDir), du(cfg.uploadsDir), du(cfg.poDir), du(cfg.standingDir), du(join(homedir(), '.ollama', 'models')),
  ]);
  const v: StorageView = {
    takenAt: new Date().toISOString(),
    home: cfg.home,
    db: { file: size(cfg.dbPath), wal: size(`${cfg.dbPath}-wal`), shm: size(`${cfg.dbPath}-shm`), free },
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
    counts: {
      teams: count('SELECT count(*) n FROM teams'), messages: count('SELECT count(*) n FROM messages'), events: count('SELECT count(*) n FROM agent_events'),
      chat: count('SELECT count(*) n FROM po_chat'), docs: count('SELECT count(*) n FROM search_fts'), patches: count('SELECT count(*) n FROM cleanup_log WHERE patch_path IS NOT NULL'),
    },
    dirs: [
      { key: 'worktrees', label: st('worktree(팀 작업 폴더)'), path: cfg.worktreesDir, bytes: worktrees, note: st('끝난 지 7일(설정) 지나면 자동 정리 · node_modules 는 링크라 대부분 안 셈') },
      { key: 'archive', label: st('정리한 변경 패치'), path: archiveDir, bytes: archive, note: st('계속 보관') },
      { key: 'logs', label: st('로그'), path: cfg.logsDir, bytes: logs, note: '' },
      { key: 'uploads', label: st('올린 이미지'), path: cfg.uploadsDir, bytes: uploads, note: '' },
      { key: 'po', label: st('총괄 작업 폴더'), path: cfg.poDir, bytes: po, note: '' },
      { key: 'standing', label: st('직속 팀 폴더'), path: cfg.standingDir, bytes: standing, note: '' },
      { key: 'ollama', label: st('Ollama 모델'), path: join(homedir(), '.ollama', 'models'), bytes: ollama, note: st('Hivelane 밖(~/.ollama) · 다른 앱과 함께 씀') },
    ],
  };
  cache = { at: Date.now(), lang: serverLang(), v };
  return v;
}

/** DB 압축: WAL 비우고 VACUUM(빈 공간 돌려받기). 잠깐 쓰기가 멈춘다 */
export function compactDb(store: Store): { before: number; after: number } {
  const db = store.db;
  const pages = () => ((db.pragma('page_count', { simple: true }) as number) || 0) * ((db.pragma('page_size', { simple: true }) as number) || 4096);
  const before = pages();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  cache = null;
  return { before, after: pages() };
}
