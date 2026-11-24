import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { OllamaView } from '../../shared/types.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';

const log = logger('ollama');

const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const OLLAMA = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
const first = (ps: string[]) => ps.find((p) => existsSync(p)) ?? null;

/** 주소가 이 맥(127.0.0.1·localhost)일 때만 Hivelane 이 직접 켠다 */
export function localHostPort(url: string): string | null {
  try { const u = new URL(url); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? `${u.hostname === 'localhost' ? '127.0.0.1' : u.hostname}:${u.port || '11434'}` : null; } catch { return null; }
}

/**
 * 벡터 검색용 Ollama 를 Hivelane 생애주기에 맞춰 관리한다.
 * - 설치 확인(brew·ollama) · brew install ollama · 모델 받기(ollama pull)
 * - 검색 방식이 Ollama 면 Hivelane 이 켤 때 `ollama serve` 를 자식으로 띄우고, 끌 때 같이 끈다
 * - 이미 다른 데서(앱·brew services) 돌고 있으면 그것을 쓰고 건드리지 않는다
 */
export class OllamaManager {
  private child: ChildProcess | null = null;
  private job: { kind: 'install' | 'pull'; model?: string; pct: number | null; line: string; error: string | null; done: boolean } | null = null;
  private logFile: WriteStream | null = null;

  constructor(private deps: { store: Store; logsDir: string; onChange: () => void }) {}

  private url(): string { return this.deps.store.getSettings().embedding.url || 'http://127.0.0.1:11434'; }

  private async api<T>(path: string, init?: RequestInit, ms = 3000): Promise<T | null> {
    try { const r = await fetch(`${this.url().replace(/\/$/, '')}${path}`, { ...init, signal: AbortSignal.timeout(ms) }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
  }

  async status(): Promise<OllamaView> {
    const e = this.deps.store.getSettings().embedding;
    const version = await this.api<{ version: string }>('/api/version');
    const tags = version ? await this.api<{ models: { name: string }[] }>('/api/tags') : null;
    const models = tags?.models.map((m) => m.name) ?? [];
    const want = e.model || 'bge-m3';
    return {
      brew: !!first(BREW), installed: !!first(OLLAMA), running: !!version, version: version?.version ?? null,
      managed: !!this.child, local: !!localHostPort(this.url()), model: want,
      hasModel: models.some((m) => m === want || m === `${want}:latest` || m.split(':')[0] === want), models,
      job: this.job ? { ...this.job } : null,
    };
  }

  /** 검색 방식이 Ollama 이면 켜 둔다(부팅·설정 변경 때). 아니면 우리가 띄운 것만 끈다 */
  async ensure(): Promise<void> {
    if (this.deps.store.getSettings().embedding.provider === 'ollama') await this.start().catch((e) => log.warn('켜기 실패', e instanceof Error ? e.message : e));
    else this.stop();
  }

  async start(): Promise<string> {
    if (await this.api('/api/version')) return '이미 돌고 있습니다';
    if (this.child) return '켜는 중입니다';
    const hp = localHostPort(this.url());
    if (!hp) throw new Error('주소가 이 맥(127.0.0.1)이 아니라서 Hivelane 이 켤 수 없습니다');
    const bin = first(OLLAMA);
    if (!bin) throw new Error('ollama 가 설치돼 있지 않습니다');
    mkdirSync(this.deps.logsDir, { recursive: true });
    const out = createWriteStream(join(this.deps.logsDir, 'ollama.log'), { flags: 'a' });
    const child = spawn(bin, ['serve'], { env: { ...process.env, OLLAMA_HOST: hp }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(out); child.stderr?.pipe(out);
    this.child = child;
    child.on('exit', (code) => { if (this.child === child) this.child = null; log.info(`ollama serve 종료(${code})`); out.end(); this.deps.onChange(); });
    child.on('error', (e) => { log.warn('ollama serve 실행 실패', e.message); });
    for (let i = 0; i < 40 && !(await this.api('/api/version', undefined, 1000)); i++) await new Promise((r) => setTimeout(r, 250));
    this.deps.onChange();
    return (await this.api('/api/version')) ? '켰습니다' : '켜는 중입니다(로그: logs/ollama.log)';
  }

  /** 우리가 띄운 ollama serve 만 끈다 */
  stop(): void {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = null;
    this.deps.onChange();
  }

  private begin(kind: 'install' | 'pull', model?: string) {
    if (this.job && !this.job.done) throw new Error('다른 작업이 진행 중입니다');
    this.job = { kind, model, pct: null, line: '', error: null, done: false };
    mkdirSync(this.deps.logsDir, { recursive: true });
    this.logFile = createWriteStream(join(this.deps.logsDir, 'ollama-setup.log'), { flags: 'a' });
    this.deps.onChange();
  }
  private end(error: string | null) {
    if (!this.job) return;
    this.job = { ...this.job, done: true, error, pct: error ? this.job.pct : 100 };
    this.logFile?.end(); this.logFile = null;
    this.deps.onChange();
  }

  /** brew install ollama (Homebrew 는 관리자 비밀번호가 필요해 사람이 직접 설치) */
  install(): void {
    const brew = first(BREW);
    if (!brew) throw new Error('Homebrew 가 없습니다. 먼저 Homebrew 를 설치하세요');
    if (first(OLLAMA)) throw new Error('이미 설치돼 있습니다');
    this.begin('install');
    const p = spawn(brew, ['install', 'ollama'], { env: { ...process.env, HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b: Buffer) => { const s = b.toString(); this.logFile?.write(s); const last = s.trim().split('\n').pop(); if (last && this.job) { this.job.line = last.slice(0, 200); this.deps.onChange(); } };
    p.stdout?.on('data', add); p.stderr?.on('data', add);
    p.on('error', (e) => this.end(e.message));
    p.on('exit', (code) => { this.end(code === 0 ? null : `brew install 실패(종료 코드 ${code}) · logs/ollama-setup.log`); if (code === 0) void this.ensure(); });
  }

  /** 모델 받기(ollama pull) — 진행률을 보여 준다 */
  pull(model: string): void {
    if (!/^[\w.:/-]{1,100}$/.test(model)) throw new Error('모델 이름이 이상합니다');
    this.begin('pull', model);
    void (async () => {
      try {
        const r = await fetch(`${this.url().replace(/\/$/, '')}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
        if (!r.ok || !r.body) throw new Error(`받기 실패(${r.status})`);
        const dec = new TextDecoder(); let buf = ''; let last = 0;
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
            if (j.error) throw new Error(j.error);
            if (this.job) { this.job.line = j.status ?? ''; if (j.total && j.completed != null) this.job.pct = Math.round((j.completed / j.total) * 100); }
            if (Date.now() - last > 500) { last = Date.now(); this.deps.onChange(); }
          }
        }
        this.end(null);
      } catch (e) { this.end(e instanceof Error ? e.message : String(e)); }
    })();
  }
}
