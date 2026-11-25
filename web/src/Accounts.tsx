import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AccountSwitchView, AiAccountView, AuthLoginView, Provider, StateSnapshot } from '../../shared/types.ts';
import { act, api, refreshState } from './store.ts';
import { Section } from './ui.tsx';

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
  const load = useCallback(() => api<{ accounts: AiAccountView[]; switch: AccountSwitchView }>('/api/accounts').then((r) => { setList(r.accounts); setSw(r.switch); }).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, snap.settings.defaultAccount, snap.settings.poAccount]);
  // 로그인 중이면 1초마다, 아니면 30초마다 새로 읽는다
  const waiting = list?.some((a) => a.loginFlow.phase === 'waiting') ?? false;
  useEffect(() => { const t = setInterval(() => void load(), waiting ? 1000 : 30_000); return () => clearInterval(t); }, [load, waiting]);

  const save = (patch: Record<string, unknown>, ok: string) => act(async () => { await api('/api/settings', 'PUT', patch); await refreshState(); await load(); }, ok);
  // 탭: 'set'(기본·전환) · 계정 id · 'add'(계정 추가)
  const [tab, setTab] = useState<string>('set');
  const add = () => act(async () => { const r = await api<{ account: { id: string } }>('/api/accounts', 'POST', { name: name.trim(), provider: prov }); setName(''); await load(); setTab(r.account.id); }, `계정을 추가했습니다. 「로그인」을 눌러 ${prov === 'codex' ? 'ChatGPT(Codex)' : 'Claude'} 계정에 연결하세요`);
  const accounts = list ?? [];
  const claudeAccounts = accounts.filter((a) => a.provider === 'claude');
  // 지운 계정 탭에 머물러 있으면 설정 탭으로
  const cur = tab === 'set' || tab === 'add' || accounts.some((a) => a.id === tab) ? tab : 'set';
  const peak = (a: AiAccountView) => Math.max(0, ...(a.usage?.windows ?? []).map((w) => w.pct));
  const tabBtn = (id: string, body: ReactNode) => (
    <button key={id} type="button" role="tab" aria-selected={cur === id} className={cur === id ? 'on' : ''} onClick={() => setTab(id)}>{body}</button>
  );

  return (
    <Section title="AI 계정" sub="팀·총괄이 쓸 Claude·Codex 계정을 여러 개 두고 역할마다 고릅니다">
      <div className="acc-tabs" role="tablist" aria-label="AI 계정">
        {tabBtn('set', '기본·전환')}
        {accounts.map((a) => tabBtn(a.id, <>
          <span className="acc-dot" style={{ background: a.usage?.login?.loggedIn ? pctTone(peak(a)) : 'var(--line)' }} aria-hidden />
          {a.name}{a.isDefault && <span className="acc-tag">기본</span>}
          {a.usage?.windows.length ? <span className="mono acc-pct">{Math.round(peak(a))}%</span> : null}
        </>))}
        {!ro && tabBtn('add', '+ 계정 추가')}
      </div>

      <div className="acc-list">
      {cur === 'set' && <>
      <div className="panel stack-s">
        <div className="set-row">
          <label htmlFor="acc-default">기본 계정<small>템플릿 역할에 계정을 고르지 않으면 평소 이 계정을 씁니다 · 사용량 기준 전환이 켜져 있으면 이 계정이 기준을 넘는 동안만 다음 계정을 빌려 씁니다</small></label>
          <span className="set-v">
            <select id="acc-default" disabled={ro || !list} value={snap.settings.defaultAccount} onChange={(e) => void save({ defaultAccount: e.target.value }, '기본 계정을 바꿨습니다')}>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
        <div className="set-row">
          <label htmlFor="acc-po">총괄 계정<small>총괄이 평소 쓸 계정 · 사용량 기준 전환도 같은 규칙 · 바꿔도 하던 대화를 그대로 이어 갑니다</small></label>
          <span className="set-v">
            <select id="acc-po" disabled={ro || !list} value={snap.settings.poAccount ?? ''} onChange={(e) => void save({ poAccount: e.target.value || null }, '총괄 계정을 바꿨습니다')}>
              <option value="">기본 계정 따라감</option>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
      </div>

      <SwitchPanel snap={snap} ro={ro} list={accounts} sw={sw} reload={load} />
      </>}

      {accounts.filter((a) => a.id === cur).map((a) => <AccountCard key={a.id} a={a} ro={ro} reload={load} onDefault={() => void save({ defaultAccount: a.id }, `${a.name} 을(를) 기본 계정으로 정했습니다`)} />)}

      {cur === 'add' && !ro && (
        <div className="panel stack-s">
          <div className="acc-kind-h">어떤 계정을 추가할까요?</div>
          <div className="acc-kinds" role="radiogroup" aria-label="계정 종류">
            {([
              ['claude', 'Claude', 'Anthropic · claude.ai 로그인', '총괄·PM·모든 팀원이 쓸 수 있습니다'],
              ['codex', 'Codex', 'OpenAI · ChatGPT 로그인 또는 API 키', 'PM 이 일을 맡기는 「독립 세션」 팀원만 · 작업 폴더 샌드박스·네트워크 끔'],
            ] as const).map(([v, title, sub, note]) => (
              <button key={v} type="button" role="radio" aria-checked={prov === v} className={`acc-kind${prov === v ? ' on' : ''}`} onClick={() => setProv(v)}>
                <span className="acc-kind-t">{title}</span>
                <span className="acc-kind-s">{sub}</span>
                <span className="acc-kind-n">{note}</span>
              </button>
            ))}
          </div>
          <div className="set-row">
            <label htmlFor="acc-new">이름<small>회사·개인처럼 구분할 이름 · 추가하면 그 계정 탭으로 옮겨 가니 「로그인」을 누르세요</small></label>
            <span className="set-v row">
              <input id="acc-new" value={name} maxLength={40} placeholder={prov === 'codex' ? '예: 회사 Codex' : '예: 회사 계정'} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add(); }} />
              <button className="btn primary" type="button" disabled={!name.trim()} onClick={() => void add()}>추가</button>
            </span>
          </div>
          <div className="small muted">
            계정마다 로그인 정보를 따로 둡니다(<code className="mono">~/.hivelane/accounts/…</code>). 역할에 쓸 계정은 <a href="#templates">팀 템플릿</a>에서 고릅니다.
            Agent 도구로 부르는 팀원은 PM 과 같은 계정을 씁니다. 같은 사람이 구독을 여러 개 만들어 사용 한도를 피하는 것은 서비스 약관에 어긋날 수 있습니다.
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
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
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
  const send = () => act(async () => { await api(`${base}/login/code`, 'POST', { code }); setCode(''); await reload(); }, '코드를 보냈습니다');
  const cancel = () => act(async () => { await api(`${base}/login/cancel`, 'POST', {}); await reload(); });
  const refresh = () => act(async () => { await api(`${base}/refresh`, 'POST', {}); await reload(); }, '사용량을 새로 읽었습니다');
  const remove = () => { if (confirm(`${a.name} 계정을 지울까요? 이 계정을 쓰던 역할·총괄은 기본 계정으로 돌아갑니다.`)) void act(async () => { await api(base, 'DELETE'); await refreshState(); await reload(); }, '계정을 지웠습니다'); };
  const rename = () => act(async () => { await api(base, 'PATCH', { name: renaming }); setRenaming(null); await reload(); }, '이름을 바꿨습니다');
  const sendKey = () => act(async () => { await api(`${base}/apikey`, 'POST', { key }); setKey(''); await reload(); }, 'API 키로 로그인했습니다');

  return (
    <div className="panel stack-s">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          {renaming !== null
            ? <span className="row"><input value={renaming} maxLength={40} onChange={(e) => setRenaming(e.target.value)} aria-label="계정 이름" /><button className="btn" type="button" onClick={() => void rename()}>저장</button><button className="btn ghost" type="button" onClick={() => setRenaming(null)}>취소</button></span>
            : <b>{a.name}</b>}
          {a.isDefault && <span className="chip" style={{ marginLeft: 6 }}>기본</span>}
          <span className="chip" style={{ marginLeft: 6 }}>{codex ? 'Codex' : 'Claude'}</span>
          <div className="small muted">
            {login?.loggedIn ? <>로그인됨{login.method && codex ? ` · ${login.method === 'chatgpt' ? 'ChatGPT' : login.method}` : ''}{login.email ? ` · ${login.email}` : ''}{a.usage?.plan ? ` · ${a.usage.plan}` : ''}{login.expiresAt ? ` · ${new Date(login.expiresAt).toLocaleDateString('ko-KR')} 만료` : ''}</> : <span style={{ color: 'var(--crit)' }}>로그인 필요</span>}
            {a.id === 'default' && ' · 이 맥의 Claude Code 로그인(~/.claude)과 같습니다'}
            {a.id === 'codex' && ' · 이 맥의 Codex 로그인(~/.codex)과 같습니다'}
          </div>
        </div>
        {!ro && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {flow.phase !== 'waiting' && <button className="btn primary" type="button" onClick={() => void start()}>{login?.loggedIn ? '다시 로그인' : '로그인'}</button>}
            <button className="btn" type="button" onClick={() => void refresh()}>사용량 새로 읽기</button>
            {!codex && !a.isDefault && <button className="btn" type="button" onClick={onDefault}>기본으로</button>}
            {!builtin && renaming === null && <button className="btn ghost" type="button" onClick={() => setRenaming(a.name)}>이름 바꾸기</button>}
            {!builtin && <button className="btn ghost" type="button" onClick={remove}>지우기</button>}
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
              <span className="muted acc-reset">{w.resets_at ? `${resetText(w.resets_at)} 초기화` : ''}</span>
            </div>
          ))}
        </div>
      ) : <div className="small muted">{a.usage?.error ? `사용량을 읽지 못했습니다: ${a.usage.error}` : login?.loggedIn ? '플랜 사용량이 없습니다(API 키 로그인 등)' : '로그인하면 사용량이 보입니다'}</div>}

      {codex && flow.phase === 'waiting' && (
        <ol className="au-steps">
          <li>{flow.url ? <a className="btn primary" href={flow.url} target="_blank" rel="noreferrer">로그인 페이지 열기</a> : <span className="muted">로그인 주소 받는 중…</span>} <span className="muted small">이 계정으로 쓸 ChatGPT 계정으로 로그인하세요</span></li>
          <li>페이지에 이 일회용 코드를 넣습니다: {flow.userCode ? <b className="mono" style={{ fontSize: 16, letterSpacing: 1 }}>{flow.userCode}</b> : <span className="muted">코드 받는 중…</span>}
            {flow.userCode && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => void navigator.clipboard?.writeText(flow.userCode!)}>복사</button>}</li>
          <li className="muted small">승인하면 저절로 로그인됩니다 · 15분 안에 끝내지 않으면 멈춥니다 · <button type="button" className="link-btn" onClick={() => void cancel()}>취소</button></li>
        </ol>
      )}
      {codex && !ro && flow.phase !== 'waiting' && (
        <div className="au-code"><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="또는 OpenAI API 키(sk-…)로 로그인" aria-label="OpenAI API 키" autoComplete="off" /><button className="btn" type="button" disabled={key.trim().length < 10} onClick={() => void sendKey()}>API 키로 로그인</button></div>
      )}
      {!codex && flow.phase === 'waiting' && (
        <ol className="au-steps">
          <li>{flow.url ? <a className="btn primary" href={flow.url} target="_blank" rel="noreferrer">로그인 페이지 열기</a> : <span className="muted">로그인 주소 받는 중…</span>} <span className="muted small">이 계정으로 쓸 Claude 계정으로 로그인하세요</span></li>
          <li>열린 페이지에서 로그인하고 「승인」을 누릅니다. <b>인증 코드</b>가 보이면 복사해 붙여 넣으세요.
            <div className="au-code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="인증 코드 붙여 넣기" aria-label="인증 코드" autoComplete="off" /><button className="btn" type="button" disabled={code.trim().length < 4} onClick={() => void send()}>보내기</button></div>
          </li>
          <li className="muted small">10분 안에 끝내지 않으면 저절로 멈춥니다 · <button type="button" className="link-btn" onClick={() => void cancel()}>취소</button></li>
        </ol>
      )}
      {flow.phase === 'done' && <p className="au-ok small">로그인했습니다.</p>}
      {flow.phase === 'failed' && <p className="crit-t small">로그인이 끝나지 않았습니다: {flow.error}</p>}
      {a.usedBy.length > 0 && <div className="small muted">쓰는 곳: {a.usedBy.join(', ')}</div>}
    </div>
  );
}

const nameOf = (list: AiAccountView[], id: string) => list.find((a) => a.id === id)?.name ?? id;

/** 사용량 기준 전환: 끄기 · 알림 후 한 번 눌러 전환 · 자동 + 기준 % + 바꿀 순서 + 지금 돌려쓰는 것 */
function SwitchPanel({ snap, ro, list, sw, reload }: { snap: StateSnapshot; ro: boolean; list: AiAccountView[]; sw: AccountSwitchView; reload: () => Promise<unknown> }) {
  const cfg = snap.settings.accountSwitch;
  const save = (patch: Partial<typeof cfg>, ok: string) => act(async () => { await api('/api/settings', 'PUT', { accountSwitch: patch }); await refreshState(); await reload(); }, ok);
  const order = [...cfg.order.filter((id) => list.some((a) => a.id === id)), ...list.map((a) => a.id).filter((id) => !cfg.order.includes(id))];
  const move = (i: number, d: -1 | 1) => { const o = [...order]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j]!, o[i]!]; void save({ order: o }, '순서를 바꿨습니다'); };
  const switchNow = (from: string, to?: string) => act(async () => { await api('/api/accounts/switch', 'POST', { from, to }); await reload(); }, '바꿔 씁니다');
  const revert = (from: string) => act(async () => { await api('/api/accounts/revert', 'POST', { from }); await reload(); }, '원래 계정으로 돌렸습니다');
  return (
    <div className="panel stack-s">
      <div className="set-row">
        <label htmlFor="acc-sw">사용량 기준 전환<small>위에서 고른 계정(기본·총괄·역할별 계정)은 그대로 두고, 그 계정의 사용량(5시간·주간 중 큰 값)이 기준을 넘는 동안만 같은 종류(Claude끼리·Codex끼리)의 다음 계정으로 바꿔 씁니다. 한도가 초기화돼 기준 아래로 내려오면 원래 계정으로 돌아옵니다. 바꿔 쓰는 중이면 아래에 「돌려쓰는 중」으로 보입니다</small></label>
        <span className="set-v row">
          <select id="acc-sw" disabled={ro} value={cfg.mode} onChange={(e) => void save({ mode: e.target.value as typeof cfg.mode }, '전환 방식을 바꿨습니다')}>
            <option value="off">끄기</option>
            <option value="ask">알림 후 한 번 눌러 전환</option>
            <option value="auto">자동 전환</option>
          </select>
          <input type="number" min={10} max={100} step={5} disabled={ro || cfg.mode === 'off'} defaultValue={cfg.thresholdPct} key={cfg.thresholdPct} aria-label="기준 %" style={{ width: 64 }}
            onBlur={(e) => { const v = Math.max(10, Math.min(100, Math.round(Number(e.target.value)))); if (v !== cfg.thresholdPct) void save({ thresholdPct: v }, `기준을 ${v}% 로 바꿨습니다`); }} />
          <span className="small muted">% 이상</span>
        </span>
      </div>
      {cfg.mode !== 'off' && list.length > 1 && (
        <div className="set-row">
          <label>바꿀 순서<small>위에서부터 로그인돼 있고 사용량이 기준 아래인 계정을 씁니다</small></label>
          <span className="set-v">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {order.map((id, i) => <li key={id} className="small">{nameOf(list, id)} {!ro && <><button className="link-btn" type="button" disabled={i === 0} onClick={() => move(i, -1)}>▲</button> <button className="link-btn" type="button" disabled={i === order.length - 1} onClick={() => move(i, 1)}>▼</button></>}</li>)}
            </ol>
          </span>
        </div>
      )}
      {sw.overrides.map((o) => (
        <div key={o.from} className="row small" style={{ gap: 8, alignItems: 'center' }}>
          <span className="chip">돌려쓰는 중</span>
          <span><b>{nameOf(list, o.from)}</b> 대신 <b>{nameOf(list, o.to)}</b> 을(를) 씁니다 · {o.auto ? '자동' : '직접'} · {new Date(o.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <button className="btn ghost" type="button" onClick={() => void revert(o.from)}>원래대로</button>
        </div>
      ))}
      {sw.suggestions.map((g) => (
        <div key={g.from} className="row small" style={{ gap: 8, alignItems: 'center' }}>
          <span className="chip" style={{ color: 'var(--warn)' }}>전환 권함</span>
          <span><b>{nameOf(list, g.from)}</b> 사용량 {Math.round(g.pct)}%</span>
          <button className="btn primary" type="button" onClick={() => void switchNow(g.from, g.to)}>{nameOf(list, g.to)} 으로 전환</button>
        </div>
      ))}
      {cfg.mode !== 'off' && list.length < 2 && <div className="small muted">바꿔 쓸 계정이 없습니다. 「+ 계정 추가」 탭에서 계정을 하나 더 추가하세요.</div>}
      <div className="small muted">계정을 바꿔도 그 팀원은 하던 대화를 그대로 이어 갑니다(대화 기록 파일을 새 계정 쪽으로 옮겨 씀). 기록 파일을 찾지 못할 때만 요약을 넘겨받아 새 대화로 시작합니다.</div>
    </div>
  );
}
