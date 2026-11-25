/**
 * AI 계정 여러 개.
 * - claude: 계정마다 로그인 폴더(CLAUDE_CONFIG_DIR)를 따로 둔다. 'default' 는 이 맥의 기본 로그인(~/.claude)을 그대로 쓴다.
 * - 역할(템플릿)·총괄마다 계정을 고르고, 안 고르면 설정의 기본 계정을 쓴다.
 * - 계정별 로그인(claude auth login 대행)과 플랜 사용량을 따로 본다.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AiAccount, AiAccountView, AuthLoginView, Provider, UsageView } from '../shared/types.ts';
import type { AppConfig } from './config.ts';
import { AuthLogin } from './po/auth.ts';
import { PlanUsage } from './po/usage.ts';
import type { Store } from './store.ts';
import { newId, nowIso } from './util.ts';

const KEY = 'ai_accounts';
export const DEFAULT_ACCOUNT: AiAccount = { id: 'default', provider: 'claude', name: '이 맥 기본 계정', configDir: null, created_at: '1970-01-01T00:00:00.000Z' };

export class AccountManager {
  private usages = new Map<string, PlanUsage>();
  private logins = new Map<string, AuthLogin>();

  constructor(private deps: { cfg: AppConfig; store: Store; onChange: () => void; defaultUsage?: PlanUsage; defaultLogin?: AuthLogin; makeUsage?: (env: Record<string, string>) => PlanUsage }) {
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
    }));
  }

  /**
   * 에이전트가 이번 턴에 쓸 계정을 정하고, 지난번과 계정이 바뀌었으면 이어 쓰던 대화(세션)를 끊는다.
   * 대화 기록은 계정의 로그인 폴더 안에 있어서 다른 계정으로는 이어 쓸 수 없다(대신 요약을 넘겨받아 새로 시작).
   * 돌려주는 값: 쓸 환경 변수와 세션을 끊었는지.
   */
  bind(agentId: string, accountId: string | null | undefined): { env: Record<string, string>; account: AiAccount; reset: boolean } {
    const acc = this.resolve(accountId);
    const key = `acct:${agentId}`;
    const prev = this.deps.store.getKv<string | null>(key, null);
    // 처음 보는 에이전트: 예전 세션은 모두 기본 로그인(~/.claude)으로 만든 것
    const was = prev ?? 'default';
    const reset = was !== acc.id;
    if (prev !== acc.id) this.deps.store.setKv(key, acc.id);
    if (reset) this.deps.store.updateAgent(agentId, { session_id: null });
    return { env: this.env(acc), account: acc, reset };
  }

  private save(list: AiAccount[]): void {
    this.deps.store.setKv(KEY, list.filter((a) => a.id !== 'default'));
  }
}
