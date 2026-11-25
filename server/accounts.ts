/**
 * AI 계정 여러 개.
 * - claude: 계정마다 로그인 폴더(CLAUDE_CONFIG_DIR)를 따로 둔다. 'default' 는 이 맥의 기본 로그인(~/.claude)을 그대로 쓴다.
 * - 역할(템플릿)·총괄마다 계정을 고르고, 안 고르면 설정의 기본 계정을 쓴다.
 * - 계정별 로그인(claude auth login 대행)과 플랜 사용량을 따로 본다.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSwitchView, AiAccount, AiAccountView, AuthLoginView, Provider, UsageView } from '../shared/types.ts';
import type { AppConfig } from './config.ts';
import { AuthLogin } from './po/auth.ts';
import { PlanUsage } from './po/usage.ts';
import type { Store } from './store.ts';
import { newId, nowIso } from './util.ts';

const KEY = 'ai_accounts';
const OVERRIDE_KEY = 'acct_override';
type Override = { to: string; at: string; auto: boolean };
export const DEFAULT_ACCOUNT: AiAccount = { id: 'default', provider: 'claude', name: '이 맥 기본 계정', configDir: null, created_at: '1970-01-01T00:00:00.000Z' };

export class AccountManager {
  private usages = new Map<string, PlanUsage>();
  private logins = new Map<string, AuthLogin>();

  constructor(private deps: { cfg: AppConfig; store: Store; onChange: () => void; defaultUsage?: PlanUsage; defaultLogin?: AuthLogin; makeUsage?: (env: Record<string, string>) => PlanUsage; /** 전환을 권하거나 자동으로 바꿨을 때 알림 */ notify?: (title: string, body: string) => void }) {
    if (deps.defaultUsage) this.usages.set('default', deps.defaultUsage);
    if (deps.defaultLogin) this.logins.set('default', deps.defaultLogin);
  }

  list(): AiAccount[] {
    const saved = this.deps.store.getKv<AiAccount[]>(KEY, []).filter((a) => a.id !== 'default');
    return [DEFAULT_ACCOUNT, ...saved];
  }

  get(id: string | null | undefined): AiAccount | null {
    return id ? this.list().find((a) => a.id === id) ?? null : null;
  }

  /** 역할·총괄이 고른 계정 → 실제로 쓸 계정(없거나 지워졌으면 기본 계정 → 이 맥 기본) */
  resolve(id: string | null | undefined): AiAccount {
    return this.get(id) ?? this.get(this.deps.store.getSettings().defaultAccount) ?? DEFAULT_ACCOUNT;
  }

  /** 이 계정으로 claude 를 띄울 때 붙일 환경 변수 */
  env(acc: AiAccount): Record<string, string> {
    return acc.provider === 'claude' && acc.configDir ? { CLAUDE_CONFIG_DIR: acc.configDir } : {};
  }

  add(name: string, provider: Provider = 'claude'): AiAccount {
    const id = newId('acc');
    const configDir = join(this.deps.cfg.home, 'accounts', id, provider);
    mkdirSync(configDir, { recursive: true });
    const acc: AiAccount = { id, provider, name: name.trim() || '새 계정', configDir, created_at: nowIso() };
    this.save([...this.list().filter((a) => a.id !== 'default'), acc]);
    this.deps.onChange();
    return acc;
  }

  rename(id: string, name: string): AiAccount {
    if (id === 'default') throw new Error('이 맥 기본 계정은 이름을 바꿀 수 없습니다');
    const list = this.list().filter((a) => a.id !== 'default');
    const acc = list.find((a) => a.id === id);
    if (!acc) throw new Error('없는 계정입니다');
    acc.name = name.trim() || acc.name;
    this.save(list);
    this.deps.onChange();
    return acc;
  }

  /** 지운 계정을 쓰던 역할·총괄은 기본 계정으로 돌아간다(resolve). 로그인 폴더도 지운다. */
  remove(id: string): void {
    if (id === 'default') throw new Error('이 맥 기본 계정은 지울 수 없습니다');
    const acc = this.get(id);
    if (!acc) return;
    this.logins.get(id)?.cancel('계정을 지웠습니다');
    this.logins.delete(id);
    this.usages.delete(id);
    this.save(this.list().filter((a) => a.id !== 'default' && a.id !== id));
    const s = this.deps.store.getSettings();
    if (s.defaultAccount === id) this.deps.store.saveSettings({ defaultAccount: 'default' });
    if (s.poAccount === id) this.deps.store.saveSettings({ poAccount: null });
    if (acc.configDir && acc.configDir.startsWith(join(this.deps.cfg.home, 'accounts'))) rmSync(join(acc.configDir, '..'), { recursive: true, force: true });
    this.deps.onChange();
  }

  usage(id: string): PlanUsage {
    let u = this.usages.get(id);
    if (!u) {
      const acc = this.resolve(id);
      u = this.deps.makeUsage ? this.deps.makeUsage(this.env(acc)) : new PlanUsage({ env: this.env(acc), onChange: () => this.deps.onChange() });
      this.usages.set(id, u);
    }
    return u;
  }

  login(id: string): AuthLogin {
    let l = this.logins.get(id);
    if (!l) {
      const acc = this.get(id);
      if (!acc) throw new Error('없는 계정입니다');
      l = new AuthLogin({ env: this.env(acc), onDone: () => { void this.usage(id).refresh(); this.deps.onChange(); } });
      this.logins.set(id, l);
    }
    return l;
  }

  /** 계정 사용량을 모두 새로 읽는다(기본 계정은 서버가 따로 주기적으로 읽음) */
  async refreshAll(): Promise<void> {
    await Promise.allSettled(this.list().map((a) => this.usage(a.id).refresh()));
  }

  views(usedBy: (id: string) => string[]): AiAccountView[] {
    const def = this.deps.store.getSettings().defaultAccount;
    const idle: AuthLoginView = { phase: 'idle', url: null, output: '', startedAt: null, error: null };
    return this.list().map((a) => ({
      ...a,
      usage: (this.usages.get(a.id)?.last as UsageView | undefined) ?? null,
      loginFlow: this.logins.get(a.id)?.view ?? idle,
      isDefault: a.id === (this.get(def) ? def : 'default'),
      usedBy: usedBy(a.id),
      peakPct: this.peak(a.id),
    }));
  }

  /**
   * 에이전트가 이번 턴에 쓸 계정을 정하고, 지난번과 계정이 바뀌었으면 이어 쓰던 대화(세션)를 끊는다.
   * 대화 기록은 계정의 로그인 폴더 안에 있어서 다른 계정으로는 이어 쓸 수 없다(대신 요약을 넘겨받아 새로 시작).
   * 돌려주는 값: 쓸 환경 변수와 세션을 끊었는지.
   */
  bind(agentId: string, accountId: string | null | undefined): { env: Record<string, string>; account: AiAccount; reset: boolean } {
    const acc = this.effective(this.resolve(accountId));
    const key = `acct:${agentId}`;
    const prev = this.deps.store.getKv<string | null>(key, null);
    // 처음 보는 에이전트: 예전 세션은 모두 기본 로그인(~/.claude)으로 만든 것
    const was = prev ?? 'default';
    const reset = was !== acc.id;
    if (prev !== acc.id) this.deps.store.setKv(key, acc.id);
    if (reset) this.deps.store.updateAgent(agentId, { session_id: null });
    return { env: this.env(acc), account: acc, reset };
  }

  /* ---------- 사용량 기준 전환 ---------- */

  /** 가장 많이 쓴 한도 창의 %(5시간·주간 등). 모르면 null */
  peak(id: string): number | null {
    const w = this.usages.get(id)?.last?.windows ?? [];
    return w.length ? Math.max(...w.map((x) => x.pct)) : null;
  }

  private overrides(): Record<string, Override> { return this.deps.store.getKv<Record<string, Override>>(OVERRIDE_KEY, {}); }
  private setOverrides(o: Record<string, Override>): void { this.deps.store.setKv(OVERRIDE_KEY, o); }
  private loggedIn(id: string): boolean { return !!this.usages.get(id)?.last?.login?.loggedIn; }

  /** 기준 아래이고 로그인된 다음 계정(정한 순서 → 나머지) */
  private next(from: string): AiAccount | null {
    const { order, thresholdPct } = this.deps.store.getSettings().accountSwitch;
    const ids = [...order.filter((x) => this.get(x)), ...this.list().map((a) => a.id).filter((x) => !order.includes(x))];
    for (const id of ids) {
      if (id === from) continue;
      const p = this.peak(id);
      if (this.loggedIn(id) && p !== null && p < thresholdPct) return this.get(id);
    }
    return null;
  }

  /**
   * 역할이 고른 계정 → 이번 턴에 실제로 쓸 계정.
   * 돌려쓰기 중(override)이면 그 계정. 원래 계정이 기준 아래로 내려오면(한도 초기화) 돌려쓰기를 풀고 원래 계정으로.
   * 자동 모드면 기준을 넘는 순간 다음 계정으로 돌린다. 알림 모드면 권하기만 한다(사람이 「전환」을 눌러야 함).
   */
  effective(acc: AiAccount): AiAccount {
    const sw = this.deps.store.getSettings().accountSwitch;
    const o = this.overrides();
    const cur = o[acc.id];
    const p = this.peak(acc.id);
    if (cur) {
      if (sw.mode === 'off' || (p !== null && p < sw.thresholdPct)) {
        delete o[acc.id]; this.setOverrides(o);
        this.deps.notify?.('AI 계정 원래대로', `${acc.name} 사용량이 기준 아래로 내려와 다시 씁니다.`);
        this.deps.onChange();
        return acc;
      }
      return this.get(cur.to) ?? acc;
    }
    if (p !== null && p < sw.thresholdPct) {
      // 기준 아래로 내려오면 다음에 넘을 때 다시 알릴 수 있게
      const asked = this.deps.store.getKv<Record<string, string>>('acct_asked', {});
      if (asked[acc.id]) { delete asked[acc.id]; this.deps.store.setKv('acct_asked', asked); }
    }
    if (sw.mode === 'off' || p === null || p < sw.thresholdPct) return acc;
    const to = this.next(acc.id);
    if (!to) return acc;
    if (sw.mode === 'auto') {
      o[acc.id] = { to: to.id, at: nowIso(), auto: true }; this.setOverrides(o);
      this.deps.notify?.('AI 계정 자동 전환', `${acc.name} 사용량 ${Math.round(p)}% → ${to.name} 으로 바꿔 씁니다. 한도가 초기화되면 저절로 돌아옵니다.`);
      this.deps.onChange();
      return to;
    }
    // ask: 계정마다 한 번만 알린다(전환하거나 기준 아래로 내려오면 다시 알릴 수 있음)
    const asked = this.deps.store.getKv<Record<string, string>>('acct_asked', {});
    if (!asked[acc.id]) {
      asked[acc.id] = nowIso(); this.deps.store.setKv('acct_asked', asked);
      this.deps.notify?.('AI 계정 전환을 권합니다', `${acc.name} 사용량 ${Math.round(p)}% — 설정 › AI 계정에서 「${to.name} 으로 전환」을 누르면 바꿔 씁니다.`);
      this.deps.onChange();
    }
    return acc;
  }

  /** 사람이 「전환」을 눌렀을 때 · to 를 비우면 다음 계정 */
  switchNow(from: string, to?: string): AiAccount {
    const target = to ? this.get(to) : this.next(from);
    if (!target || target.id === from) throw new Error('바꿔 쓸 계정이 없습니다(로그인돼 있고 사용량이 기준 아래인 계정)');
    const o = this.overrides(); o[from] = { to: target.id, at: nowIso(), auto: false }; this.setOverrides(o);
    const asked = this.deps.store.getKv<Record<string, string>>('acct_asked', {}); delete asked[from]; this.deps.store.setKv('acct_asked', asked);
    this.deps.onChange();
    return target;
  }

  /** 돌려쓰기를 풀고 원래 계정으로 */
  revert(from: string): void {
    const o = this.overrides(); delete o[from]; this.setOverrides(o);
    this.deps.onChange();
  }

  switchView(): AccountSwitchView {
    const sw = this.deps.store.getSettings().accountSwitch;
    const o = this.overrides();
    const overrides = Object.entries(o).map(([from, v]) => ({ from, to: v.to, at: v.at, auto: v.auto }));
    const suggestions: AccountSwitchView['suggestions'] = [];
    if (sw.mode !== 'off') for (const a of this.list()) {
      if (o[a.id]) continue;
      const p = this.peak(a.id);
      if (p === null || p < sw.thresholdPct) continue;
      const to = this.next(a.id);
      if (to) suggestions.push({ from: a.id, to: to.id, pct: p });
    }
    return { overrides, suggestions };
  }

  private save(list: AiAccount[]): void {
    this.deps.store.setKv(KEY, list.filter((a) => a.id !== 'default'));
  }
}
