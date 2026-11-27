/**
 * 새 버전 확인 — GitHub 최신 릴리스를 서버 시작 때와 6시간마다 본다.
 * 새 버전이 있으면 화면(지금 볼 것·설정·메뉴 막대)에 업데이트 방법과 함께 알리고, 버전마다 한 번 알림을 보낸다.
 * 업데이트 자체는 사람이 한다(brew upgrade · DMG 교체 · git pull). 깔리고 나면 서버가 한가할 때 스스로 새 버전으로 다시 뜬다(server/index.ts).
 */
import { existsSync } from 'node:fs';
import type { InstallKind, UpdateView } from '../shared/types.ts';
import { st } from './i18n.ts';
import { logger } from './log.ts';
import type { Store } from './store.ts';
import { VERSION } from './version.ts';

const log = logger('update');
export const RELEASES_API = 'https://api.github.com/repos/webjihong/hivelane/releases/latest';
export const RELEASES_PAGE = 'https://github.com/webjihong/hivelane/releases/latest';
const EVERY_MS = 6 * 3600_000;

/** 1.2.10 > 1.2.9 처럼 숫자로 비교(앞의 v·뒤의 -beta 같은 꼬리는 무시) */
export function isNewer(latest: string, current: string): boolean {
  const n = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const a = n(latest), b = n(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** 어떻게 설치했는지: brew(Homebrew cask) · app(DMG 로 옮긴 맥 앱) · source(저장소에서 직접) */
export function installKind(exists: (p: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): InstallKind {
  if (exists('/opt/homebrew/Caskroom/hivelane') || exists('/usr/local/Caskroom/hivelane')) return 'brew';
  if (env.ELECTRON_RUN_AS_NODE) return 'app';
  return 'source';
}

type Saved = { latest: string | null; url: string | null; publishedAt: string | null; notes: string | null; checkedAt: string | null; error: string | null };

export class UpdateChecker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<UpdateView> | null = null;
  private readonly kind: InstallKind;

  constructor(private readonly d: {
    store: Store;
    notify: (title: string, body: string, url: string) => void;
    onChange: () => void;
    fetch?: typeof fetch;
    kind?: InstallKind;
    current?: string;
  }) {
    this.kind = d.kind ?? installKind();
  }

  private get current(): string { return this.d.current ?? VERSION; }

  view(): UpdateView {
    const s = this.d.store.getKv<Saved>('update_check', { latest: null, url: null, publishedAt: null, notes: null, checkedAt: null, error: null });
    return { current: this.current, ...s, hasUpdate: !!s.latest && isNewer(s.latest, this.current), install: this.kind };
  }

  start(): void {
    if (process.env.HIVELANE_NO_UPDATE_CHECK) return;
    setTimeout(() => void this.check(), 20_000).unref();
    this.timer = setInterval(() => void this.check(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 지금 확인(동시에 여러 번 눌러도 한 번만) */
  check(): Promise<UpdateView> {
    this.running ??= this.doCheck().finally(() => { this.running = null; });
    return this.running;
  }

  private async doCheck(): Promise<UpdateView> {
    const prev = this.view();
    const now = new Date().toISOString();
    try {
      const r = await (this.d.fetch ?? fetch)(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'hivelane-update-check' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = (await r.json()) as { tag_name?: string; html_url?: string; published_at?: string; body?: string; draft?: boolean; prerelease?: boolean };
      if (!j.tag_name) throw new Error('no tag');
      const latest = j.tag_name.replace(/^v/i, '');
      this.d.store.setKv('update_check', { latest, url: j.html_url ?? RELEASES_PAGE, publishedAt: j.published_at ?? null, notes: (j.body ?? '').slice(0, 4000) || null, checkedAt: now, error: null } satisfies Saved);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`새 버전 확인 실패: ${msg}`);
      this.d.store.setKv('update_check', { latest: prev.latest, url: prev.url, publishedAt: prev.publishedAt, notes: prev.notes, checkedAt: now, error: msg } satisfies Saved);
    }
    const v = this.view();
    if (v.hasUpdate && v.latest && this.d.store.getKv<string | null>('update_notified', null) !== v.latest) {
      this.d.store.setKv('update_notified', v.latest);
      this.d.notify(st('새 버전 {v} 이 나왔습니다', { v: v.latest }), howTo(v.install), v.url ?? RELEASES_PAGE);
    }
    this.d.onChange();
    return v;
  }
}

/** 설치 방식에 맞는 업데이트 방법 한 줄 */
export function howTo(kind: InstallKind): string {
  if (kind === 'brew') return st('터미널에서 brew upgrade --cask hivelane — 일하는 팀이 없을 때 서버가 새 버전으로 저절로 다시 시작합니다.');
  if (kind === 'app') return st('릴리스 페이지에서 새 DMG 를 받아 응용 프로그램 폴더의 Hivelane 을 바꾸세요. 일하는 팀이 없을 때 서버가 새 버전으로 저절로 다시 시작합니다.');
  return st('저장소에서 git pull 후 npm run service:restart 를 실행하세요.');
}
