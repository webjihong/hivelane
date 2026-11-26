import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AccountSwitchView, AiAccountView, AuthLoginView, Provider, StateSnapshot } from '../../shared/types.ts';
import { act, api, refreshState } from './store.ts';
import { Section } from './ui.tsx';
import { t, tn, locale, weekdays } from './i18n.ts';

/** 템플릿 편집 등에서 고를 계정 목록(이름·종류) */
export function useAccountList(): { id: string; name: string; provider: Provider }[] {
  const [list, setList] = useState<{ id: string; name: string; provider: Provider }[]>([]);
  useEffect(() => { void api<{ accounts: AiAccountView[] }>('/api/accounts').then((r) => setList(r.accounts.map((a) => ({ id: a.id, name: a.name, provider: a.provider })))).catch(() => {}); }, []);
  return list;
}

/** 설정 › AI 계정: Claude 계정 여러 개 · 계정별 로그인·사용량 · 기본 계정·총괄 계정 */
export function AccountsSection({ snap, ro }: { snap: StateSnapshot; ro: boolean }) {
  const [list, setList] = useState<AiAccountView[] | null>(null);
  const [sw, setSw] = useState<AccountSwitchView>({ overrides: [], suggestions: [] });
  const [name, setName] = useState('');
  const [prov, setProv] = useState<Provider>('claude');
  const [hiddenDefault, setHiddenDefault] = useState(false);
  const load = useCallback(() => api<{ accounts: AiAccountView[]; switch: AccountSwitchView; hiddenDefault?: boolean }>('/api/accounts').then((r) => { setList(r.accounts); setSw(r.switch); setHiddenDefault(!!r.hiddenDefault); }).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, snap.settings.defaultAccount, snap.settings.poAccount]);
  // 로그인 중이면 1초마다, 아니면 30초마다 새로 읽는다
  const waiting = list?.some((a) => a.loginFlow.phase === 'waiting') ?? false;
  useEffect(() => { const timer = setInterval(() => void load(), waiting ? 1000 : 30_000); return () => clearInterval(timer); }, [load, waiting]);

  const save = (patch: Record<string, unknown>, ok: string) => act(async () => { await api('/api/settings', 'PUT', patch); await refreshState(); await load(); }, ok);
  // 탭: 'set'(기본·전환) · 계정 id · 'add'(계정 추가)
  const [tab, setTab] = useState<string>('set');
  const add = () => act(async () => { const r = await api<{ account: { id: string } }>('/api/accounts', 'POST', { name: name.trim(), provider: prov }); setName(''); await load(); setTab(r.account.id); }, t('계정을 추가했습니다. 「로그인」을 눌러 {p} 계정에 연결하세요', { p: prov === 'codex' ? 'ChatGPT(Codex)' : 'Claude' }));
  const accounts = list ?? [];
  const claudeAccounts = accounts.filter((a) => a.provider === 'claude');
  // 지운 계정 탭에 머물러 있으면 설정 탭으로
  const cur = tab === 'set' || tab === 'add' || accounts.some((a) => a.id === tab) ? tab : 'set';
  const peak = (a: AiAccountView) => Math.max(0, ...(a.usage?.windows ?? []).map((w) => w.pct));
  const tabBtn = (id: string, body: ReactNode) => (
    <button key={id} type="button" role="tab" aria-selected={cur === id} className={cur === id ? 'on' : ''} onClick={() => setTab(id)}>{body}</button>
  );

  return (
    <Section title={t('AI 계정')} sub={t('팀·총괄이 쓸 Claude·Codex 계정을 여러 개 두고 역할마다 고릅니다')}>
      <div className="acc-tabs" role="tablist" aria-label={t('AI 계정')}>
        {tabBtn('set', t('기본·전환'))}
        {accounts.map((a) => tabBtn(a.id, <>
          <span className="acc-dot" style={{ background: a.usage?.login?.loggedIn ? pctTone(peak(a)) : 'var(--line)' }} aria-hidden />
          {a.name}{a.isDefault && <span className="acc-tag">{t('기본')}</span>}
          {a.usage?.windows.length ? <span className="mono acc-pct">{Math.round(peak(a))}%</span> : null}
        </>))}
        {!ro && tabBtn('add', t('+ 계정 추가'))}
      </div>

      <div className="acc-list">
      {cur === 'set' && <>
      <HowItWorks snap={snap} list={accounts} sw={sw} hiddenDefault={hiddenDefault} />
      <div className="panel stack-s">
        <div className="set-row">
          <label htmlFor="acc-default">{t('기본 계정')}<small>{t('템플릿 역할에 계정을 고르지 않으면 평소 이 계정을 씁니다 · 사용량 기준 전환이 켜져 있으면 이 계정이 기준을 넘는 동안만 다음 계정을 빌려 씁니다')}</small></label>
          <span className="set-v">
            <select id="acc-default" disabled={ro || !list} value={snap.settings.defaultAccount} onChange={(e) => void save({ defaultAccount: e.target.value }, t('기본 계정을 바꿨습니다'))}>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
        <div className="set-row">
          <label htmlFor="acc-po">{t('총괄 계정')}<small>{t('총괄이 평소 쓸 계정 · 사용량 기준 전환도 같은 규칙 · 바꿔도 하던 대화를 그대로 이어 갑니다')}</small></label>
          <span className="set-v">
            <select id="acc-po" disabled={ro || !list} value={snap.settings.poAccount ?? ''} onChange={(e) => void save({ poAccount: e.target.value || null }, t('총괄 계정을 바꿨습니다'))}>
              <option value="">{t('기본 계정 따라감')}</option>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
      </div>

      <SwitchPanel snap={snap} ro={ro} list={accounts} sw={sw} reload={load} />
      </>}

      {accounts.filter((a) => a.id === cur).map((a) => <AccountCard key={a.id} a={a} ro={ro} reload={load} onDefault={() => void save({ defaultAccount: a.id }, t('{name} 을(를) 기본 계정으로 정했습니다', { name: a.name }))} />)}

      {cur === 'add' && !ro && (
        <div className="panel stack-s">
          <div className="acc-kind-h">{t('어떤 계정을 추가할까요?')}</div>
          <div className="acc-kinds" role="radiogroup" aria-label={t('계정 종류')}>
            {([
              ['claude', 'Claude', t('Anthropic · claude.ai 로그인'), t('총괄·PM·모든 팀원이 쓸 수 있습니다')],
              ['codex', 'Codex', t('OpenAI · ChatGPT 로그인 또는 API 키'), t('PM 이 일을 맡기는 「독립 세션」 팀원만 · 작업 폴더 샌드박스·네트워크 끔')],
            ] as const).map(([v, title, sub, note]) => (
              <button key={v} type="button" role="radio" aria-checked={prov === v} className={`acc-kind${prov === v ? ' on' : ''}`} onClick={() => setProv(v)}>
                <span className="acc-kind-t">{title}</span>
                <span className="acc-kind-s">{sub}</span>
                <span className="acc-kind-n">{note}</span>
              </button>
            ))}
          </div>
          <div className="acc-name">
            <label htmlFor="acc-new" className="acc-kind-h">{t('이름')}</label>
            <div className="acc-name-row">
              <input id="acc-new" className="acc-name-in" value={name} maxLength={40} placeholder={prov === 'codex' ? t('예: 회사 Codex') : t('예: 회사 계정')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add(); }} />
              <button className="btn primary acc-name-btn" type="button" disabled={!name.trim()} onClick={() => void add()}>{t('{p} 계정 추가', { p: prov === 'codex' ? 'Codex' : 'Claude' })}</button>
            </div>
            <small className="muted">{t('회사·개인처럼 구분할 이름입니다. 추가하면 그 계정 탭으로 옮겨 가니 「로그인」을 누르세요.')}</small>
          </div>
          <div className="small muted">
            {tn('계정마다 로그인 정보를 따로 둡니다({code}). 역할에 쓸 계정은 {a}에서 고릅니다.', { code: <code className="mono">~/.hivelane/accounts/…</code>, a: <a href="#templates">{t('팀 템플릿')}</a> })}{' '}
            {t('Agent 도구로 부르는 팀원은 PM 과 같은 계정을 씁니다. 같은 사람이 구독을 여러 개 만들어 사용 한도를 피하는 것은 서비스 약관에 어긋날 수 있습니다.')}
          </div>
        </div>
      )}
      </div>
    </Section>
  );
}

/** 초기화 시각: 「11/26 (수) 06:00」 처럼 짧게 한 줄로 */
function resetText(iso: string): string {
  const d = new Date(iso);
  const wd = weekdays()[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} (${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pctTone(p: number): string { return p >= 90 ? 'var(--crit)' : p >= 70 ? 'var(--warn)' : 'var(--good)'; }

function AccountCard({ a, ro, reload, onDefault }: { a: AiAccountView; ro: boolean; reload: () => Promise<unknown>; onDefault: () => void }) {
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const codex = a.provider === 'codex';
  const builtin = a.id === 'default' || a.id === 'codex';
  const login = a.usage?.login ?? null;
  const flow: AuthLoginView = a.loginFlow;
  const base = `/api/accounts/${encodeURIComponent(a.id)}`;
  const start = () => act(async () => { await api(`${base}/login`, 'POST', {}); await reload(); });
  const send = () => act(async () => { await api(`${base}/login/code`, 'POST', { code }); setCode(''); await reload(); }, t('코드를 보냈습니다'));
  const cancel = () => act(async () => { await api(`${base}/login/cancel`, 'POST', {}); await reload(); });
  const refresh = () => act(async () => { await api(`${base}/refresh`, 'POST', {}); await reload(); }, t('사용량을 새로 읽었습니다'));
  const remove = () => { if (confirm(t('{name} 계정을 지울까요? 이 계정을 쓰던 역할·총괄은 기본 계정으로 돌아갑니다.', { name: a.name }))) void act(async () => { await api(base, 'DELETE'); await refreshState(); await reload(); }, t('계정을 지웠습니다')); };
  const rename = () => act(async () => { await api(base, 'PATCH', { name: renaming }); setRenaming(null); await reload(); }, t('이름을 바꿨습니다'));
  const sendKey = () => act(async () => { await api(`${base}/apikey`, 'POST', { key }); setKey(''); await reload(); }, t('API 키로 로그인했습니다'));

  return (
    <div className="panel stack-s">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          {renaming !== null
            ? <span className="row"><input value={renaming} maxLength={40} onChange={(e) => setRenaming(e.target.value)} aria-label={t('계정 이름')} /><button className="btn" type="button" onClick={() => void rename()}>{t('저장')}</button><button className="btn ghost" type="button" onClick={() => setRenaming(null)}>{t('취소')}</button></span>
            : <b>{a.name}</b>}
          {a.isDefault && <span className="chip" style={{ marginLeft: 6 }}>{t('기본')}</span>}
          <span className="chip" style={{ marginLeft: 6 }}>{codex ? 'Codex' : 'Claude'}</span>
          <div className="small muted">
            {login?.loggedIn ? <>{t('로그인됨')}{login.method && codex ? ` · ${login.method === 'chatgpt' ? 'ChatGPT' : login.method}` : ''}{login.email ? ` · ${login.email}` : ''}{a.usage?.plan ? ` · ${a.usage.plan}` : ''}{login.expiresAt ? ` · ${t('{date} 만료', { date: new Date(login.expiresAt).toLocaleDateString(locale()) })}` : ''}</> : <span style={{ color: 'var(--crit)' }}>{t('로그인 필요')}</span>}
            {a.id === 'default' && ` · ${t('이 맥의 Claude Code 로그인(~/.claude)과 같습니다')}`}
            {a.id === 'codex' && ` · ${t('이 맥의 Codex 로그인(~/.codex)과 같습니다')}`}
          </div>
        </div>
        {!ro && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {flow.phase !== 'waiting' && <button className="btn primary" type="button" onClick={() => void start()}>{login?.loggedIn ? t('다시 로그인') : t('로그인')}</button>}
            <button className="btn" type="button" onClick={() => void refresh()}>{t('사용량 새로 읽기')}</button>
            {!codex && !a.isDefault && <button className="btn" type="button" onClick={onDefault}>{t('기본으로')}</button>}
            {!builtin && renaming === null && <button className="btn ghost" type="button" onClick={() => setRenaming(a.name)}>{t('이름 바꾸기')}</button>}
            {!builtin && <button className="btn ghost" type="button" onClick={remove}>{t('지우기')}</button>}
          </div>
        )}
      </div>

      {a.usage?.windows.length ? (
        <div className="stack-s">
          {a.usage.windows.map((w) => (
            <div key={w.key} className="row small" style={{ alignItems: 'center', gap: 8 }}>
              <span style={{ width: 72 }}>{w.label}</span>
              <span style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}><span style={{ display: 'block', width: `${w.pct}%`, height: '100%', background: pctTone(w.pct) }} /></span>
              <span className="mono" style={{ width: 40, textAlign: 'right' }}>{Math.round(w.pct)}%</span>
              <span className="muted acc-reset">{w.resets_at ? t('{time} 초기화', { time: resetText(w.resets_at) }) : ''}</span>
            </div>
          ))}
        </div>
      ) : <div className="small muted">{a.usage?.error ? t('사용량을 읽지 못했습니다: {err}', { err: a.usage.error }) : login?.loggedIn ? t('플랜 사용량이 없습니다(API 키 로그인 등)') : t('로그인하면 사용량이 보입니다')}</div>}

      {codex && flow.phase === 'waiting' && (
        <ol className="au-steps">
          <li>{flow.url ? <a className="btn primary" href={flow.url} target="_blank" rel="noreferrer">{t('로그인 페이지 열기')}</a> : <span className="muted">{t('로그인 주소 받는 중…')}</span>} <span className="muted small">{t('이 계정으로 쓸 ChatGPT 계정으로 로그인하세요')}</span></li>
          <li>{t('페이지에 이 일회용 코드를 넣습니다:')} {flow.userCode ? <b className="mono" style={{ fontSize: 16, letterSpacing: 1 }}>{flow.userCode}</b> : <span className="muted">{t('코드 받는 중…')}</span>}
            {flow.userCode && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => void navigator.clipboard?.writeText(flow.userCode!)}>{t('복사')}</button>}</li>
          <li className="muted small">{t('승인하면 저절로 로그인됩니다 · 15분 안에 끝내지 않으면 멈춥니다')} · <button type="button" className="link-btn" onClick={() => void cancel()}>{t('취소')}</button></li>
        </ol>
      )}
      {codex && !ro && flow.phase !== 'waiting' && (
        <div className="au-code"><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('또는 OpenAI API 키(sk-…)로 로그인')} aria-label={t('OpenAI API 키')} autoComplete="off" /><button className="btn" type="button" disabled={key.trim().length < 10} onClick={() => void sendKey()}>{t('API 키로 로그인')}</button></div>
      )}
      {!codex && flow.phase === 'waiting' && (
        <ol className="au-steps">
          <li>{flow.url ? <a className="btn primary" href={flow.url} target="_blank" rel="noreferrer">{t('로그인 페이지 열기')}</a> : <span className="muted">{t('로그인 주소 받는 중…')}</span>} <span className="muted small">{t('이 계정으로 쓸 Claude 계정으로 로그인하세요')}</span></li>
          <li>{tn('열린 페이지에서 로그인하고 「승인」을 누릅니다. {b}가 보이면 복사해 붙여 넣으세요.', { b: <b>{t('인증 코드')}</b> })}
            <div className="au-code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('인증 코드 붙여 넣기')} aria-label={t('인증 코드')} autoComplete="off" /><button className="btn" type="button" disabled={code.trim().length < 4} onClick={() => void send()}>{t('보내기')}</button></div>
          </li>
          <li className="muted small">{t('10분 안에 끝내지 않으면 저절로 멈춥니다')} · <button type="button" className="link-btn" onClick={() => void cancel()}>{t('취소')}</button></li>
        </ol>
      )}
      {flow.phase === 'done' && <p className="au-ok small">{t('로그인했습니다.')}</p>}
      {flow.phase === 'failed' && <p className="crit-t small">{t('로그인이 끝나지 않았습니다:')} {flow.error}</p>}
      {a.usedBy.length > 0 && <div className="small muted">{t('쓰는 곳:')} {a.usedBy.join(', ')}</div>}
    </div>
  );
}

const nameOf = (list: AiAccountView[], id: string) => list.find((a) => a.id === id)?.name ?? id;

/** 기본·총괄 계정과 사용량 기준 전환이 어떻게 맞물리는지 · 지금 실제로 쓰는 계정 */
function HowItWorks({ snap, list, sw, hiddenDefault }: { snap: StateSnapshot; list: AiAccountView[]; sw: AccountSwitchView; hiddenDefault: boolean }) {
  const cfg = snap.settings.accountSwitch;
  const claude = list.filter((a) => a.provider === 'claude');
  const base = claude.find((a) => a.isDefault) ?? claude[0];
  const po = list.find((a) => a.id === snap.settings.poAccount && a.provider === 'claude') ?? base;
  const order = [...cfg.order.filter((id) => claude.some((a) => a.id === id)), ...claude.map((a) => a.id).filter((id) => !cfg.order.includes(id))];
  const nextOf = (id: string | undefined) => order.find((x) => x !== id);
  const now = (id: string | undefined) => { const o = sw.overrides.find((x) => x.from === id); return o ? nameOf(list, o.to) : null; };
  const row = (who: string, a: AiAccountView | undefined) => {
    if (!a) return null;
    const lent = now(a.id);
    return (
      <li key={who}>{tn('{who}: 평소 {name}', { who: <b>{who}</b>, name: <b>{a.name}</b> })}{lent ? <> → {tn('지금 {lent} 을(를) 빌려 쓰는 중(사용량 기준 넘음)', { lent: <b className="acc-lent">{lent}</b> })}</> : <> · {t('지금도 이 계정')}{a.peakPct !== null ? `(${Math.round(a.peakPct)}%)` : ''}</>}</li>
    );
  };
  const nx = base ? nextOf(base.id) : undefined;
  return (
    <div className="panel stack-s acc-how">
      <div className="acc-how-h">{t('계정은 이렇게 쓰입니다')}</div>
      <ol className="acc-how-steps">
        <li><b>{t('평소 계정')}</b> — {t('역할·총괄은 아래에서 고른 계정(안 고르면 기본 계정)을 씁니다. 템플릿의 역할마다 따로 고를 수도 있습니다.')}</li>
        <li><b>{t('사용량 기준 전환')}</b> — {cfg.mode === 'off'
          ? tn('지금은 {b} 사용량이 차도 평소 계정을 그대로 씁니다.', { b: <b>{t('꺼져 있어')}</b> })
          : tn('평소 계정의 사용량이 {pct}를 넘으면, 설정은 그대로 둔 채 그 계정을 쓰던 곳만 「바꿀 순서」의 다음 계정을 {how} 빌려 씁니다{ex}.', {
            pct: <b>{cfg.thresholdPct}%</b>,
            how: cfg.mode === 'auto' ? <b>{t('자동으로')}</b> : tn('알림을 받고 {b}', { b: <b>{t('「전환」을 눌렀을 때')}</b> }),
            ex: base && nx ? ` ${t('(예: {a} {pct}% 초과 → {b})', { a: base.name, pct: cfg.thresholdPct, b: nameOf(list, nx) })}` : null,
          })}</li>
        <li><b>{t('되돌아오기')}</b> — {t('한도가 초기화돼 평소 계정이 기준 아래로 내려오면 저절로 평소 계정으로 돌아옵니다. 계정이 바뀌어도 하던 대화는 그대로 이어집니다.')}</li>
      </ol>
      <div className="acc-how-now">
        <div className="small muted">{t('지금 상태')}</div>
        <ul>{row(t('기본 계정'), base)}{row(t('총괄'), po)}</ul>
      </div>
      {hiddenDefault && <div className="small muted">{t('「이 맥 기본 계정」(~/.claude, 터미널 Claude Code 와 같은 로그인)은 내 Claude 계정이 있어 숨겼습니다. 터미널에서 계정을 바꿔도 팀 계정은 바뀌지 않습니다. 추가한 Claude 계정이 모두 로그아웃되면 다시 보입니다.')}</div>}
      <div className="small muted">{t('Codex 계정은 PM 이 일을 맡기는 「독립 세션」 팀원만 쓰며, 전환도 Codex 계정끼리만 합니다.')}</div>
    </div>
  );
}

/** 사용량 기준 전환: 끄기 · 알림 후 한 번 눌러 전환 · 자동 + 기준 % + 바꿀 순서 + 지금 돌려쓰는 것 */
function SwitchPanel({ snap, ro, list, sw, reload }: { snap: StateSnapshot; ro: boolean; list: AiAccountView[]; sw: AccountSwitchView; reload: () => Promise<unknown> }) {
  const cfg = snap.settings.accountSwitch;
  const save = (patch: Partial<typeof cfg>, ok: string) => act(async () => { await api('/api/settings', 'PUT', { accountSwitch: patch }); await refreshState(); await reload(); }, ok);
  const order = [...cfg.order.filter((id) => list.some((a) => a.id === id)), ...list.map((a) => a.id).filter((id) => !cfg.order.includes(id))];
  /** 같은 종류 안에서 두 계정 자리 바꾸기(사이에 다른 종류가 있어도) */
  const swap = (i: number, j: number) => { const o = [...order]; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j]!, o[i]!]; void save({ order: o }, t('순서를 바꿨습니다')); };
  const switchNow = (from: string, to?: string) => act(async () => { await api('/api/accounts/switch', 'POST', { from, to }); await reload(); }, t('바꿔 씁니다'));
  const revert = (from: string) => act(async () => { await api('/api/accounts/revert', 'POST', { from }); await reload(); }, t('원래 계정으로 돌렸습니다'));
  return (
    <div className="panel stack-s">
      <div className="set-row">
        <label htmlFor="acc-sw">{t('사용량 기준 전환')}<small>{t('위에서 고른 계정(기본·총괄·역할별 계정)은 그대로 두고, 그 계정의 사용량(5시간·주간 중 큰 값)이 기준을 넘는 동안만 같은 종류(Claude끼리·Codex끼리)의 다음 계정으로 바꿔 씁니다. 한도가 초기화돼 기준 아래로 내려오면 원래 계정으로 돌아옵니다. 바꿔 쓰는 중이면 아래에 「돌려쓰는 중」으로 보입니다')}</small></label>
        <span className="set-v row">
          <select id="acc-sw" disabled={ro} value={cfg.mode} onChange={(e) => void save({ mode: e.target.value as typeof cfg.mode }, t('전환 방식을 바꿨습니다'))}>
            <option value="off">{t('끄기')}</option>
            <option value="ask">{t('알림 후 한 번 눌러 전환')}</option>
            <option value="auto">{t('자동 전환')}</option>
          </select>
          <input type="number" min={10} max={100} step={5} disabled={ro || cfg.mode === 'off'} defaultValue={cfg.thresholdPct} key={cfg.thresholdPct} aria-label={t('기준 %')} style={{ width: 64 }}
            onBlur={(e) => { const v = Math.max(10, Math.min(100, Math.round(Number(e.target.value)))); if (v !== cfg.thresholdPct) void save({ thresholdPct: v }, t('기준을 {v}% 로 바꿨습니다', { v })); }} />
          <span className="small muted">{t('% 이상')}</span>
        </span>
      </div>
      {cfg.mode !== 'off' && list.length > 1 && (
        <div className="sw-order">
          <div className="sw-order-h"><b>{t('바꿀 순서')}</b> <span className="small muted">{t('위에서부터 로그인돼 있고 사용량이 기준 아래인 계정을 씁니다 · 같은 종류끼리만 바꿉니다')}</span></div>
          <div className="sw-groups">
            {(['claude', 'codex'] as const).map((kind) => {
              const ids = order.filter((id) => list.find((a) => a.id === id)?.provider === kind);
              if (ids.length < 1) return null;
              return (
                <div key={kind} className="sw-group">
                  <div className="sw-group-h">{kind === 'claude' ? 'Claude' : 'Codex'}</div>
                  <ol className="sw-list">
                    {ids.map((id, k) => {
                      const a = list.find((x) => x.id === id)!;
                      const i = order.indexOf(id);
                      const prev = ids[k - 1], next = ids[k + 1];
                      const pct = a.peakPct;
                      return (
                        <li key={id} className="sw-item">
                          <span className="sw-num">{k + 1}</span>
                          <span className="sw-name">
                            <b className="ellipsis">{a.name}</b>
                            <span className="small muted">{a.usage?.login?.loggedIn ? (pct === null ? t('사용량 모름') : t('{pct}% 사용', { pct: Math.round(pct) })) : t('로그인 필요')}</span>
                          </span>
                          {pct !== null && <span className="sw-bar" aria-hidden><span style={{ width: `${Math.min(100, pct)}%`, background: pctTone(pct) }} /></span>}
                          {!ro && (
                            <span className="sw-move">
                              <button className="icon-btn" type="button" aria-label={t('위로')} title={t('위로')} disabled={!prev} onClick={() => prev && swap(i, order.indexOf(prev))}>↑</button>
                              <button className="icon-btn" type="button" aria-label={t('아래로')} title={t('아래로')} disabled={!next} onClick={() => next && swap(i, order.indexOf(next))}>↓</button>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {sw.overrides.map((o) => (
        <div key={o.from} className="row small" style={{ gap: 8, alignItems: 'center' }}>
          <span className="chip">{t('돌려쓰는 중')}</span>
          <span>{tn('{from} 대신 {to} 을(를) 씁니다', { from: <b>{nameOf(list, o.from)}</b>, to: <b>{nameOf(list, o.to)}</b> })} · {o.auto ? t('자동') : t('직접')} · {new Date(o.at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <button className="btn ghost" type="button" onClick={() => void revert(o.from)}>{t('원래대로')}</button>
        </div>
      ))}
      {sw.suggestions.map((g) => (
        <div key={g.from} className="row small" style={{ gap: 8, alignItems: 'center' }}>
          <span className="chip" style={{ color: 'var(--warn)' }}>{t('전환 권함')}</span>
          <span>{tn('{name} 사용량 {pct}%', { name: <b>{nameOf(list, g.from)}</b>, pct: Math.round(g.pct) })}</span>
          <button className="btn primary" type="button" onClick={() => void switchNow(g.from, g.to)}>{t('{name} 으로 전환', { name: nameOf(list, g.to) })}</button>
        </div>
      ))}
      {cfg.mode !== 'off' && list.length < 2 && <div className="small muted">{t('바꿔 쓸 계정이 없습니다. 「+ 계정 추가」 탭에서 계정을 하나 더 추가하세요.')}</div>}
      <div className="small muted">{t('계정을 바꿔도 그 팀원은 하던 대화를 그대로 이어 갑니다(대화 기록 파일을 새 계정 쪽으로 옮겨 씀). 기록 파일을 찾지 못할 때만 요약을 넘겨받아 새 대화로 시작합니다.')}</div>
    </div>
  );
}
