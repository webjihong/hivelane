import { useCallback, useEffect, useState } from 'react';
import type { AiAccountView, AuthLoginView, StateSnapshot } from '../../shared/types.ts';
import { act, api, refreshState } from './store.ts';
import { Section } from './ui.tsx';

/** 템플릿 편집 등에서 고를 계정 목록(이름만) */
export function useAccountList(): { id: string; name: string }[] {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { void api<{ accounts: AiAccountView[] }>('/api/accounts').then((r) => setList(r.accounts.map((a) => ({ id: a.id, name: a.name })))).catch(() => {}); }, []);
  return list;
}

/** 설정 › AI 계정: Claude 계정 여러 개 · 계정별 로그인·사용량 · 기본 계정·총괄 계정 */
export function AccountsSection({ snap, ro }: { snap: StateSnapshot; ro: boolean }) {
  const [list, setList] = useState<AiAccountView[] | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => api<{ accounts: AiAccountView[] }>('/api/accounts').then((r) => setList(r.accounts)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, snap.settings.defaultAccount, snap.settings.poAccount]);
  // 로그인 중이면 1초마다, 아니면 30초마다 새로 읽는다
  const waiting = list?.some((a) => a.loginFlow.phase === 'waiting') ?? false;
  useEffect(() => { const t = setInterval(() => void load(), waiting ? 1000 : 30_000); return () => clearInterval(t); }, [load, waiting]);

  const save = (patch: Record<string, unknown>, ok: string) => act(async () => { await api('/api/settings', 'PUT', patch); await refreshState(); await load(); }, ok);
  const add = () => act(async () => { await api('/api/accounts', 'POST', { name: name.trim() }); setName(''); await load(); }, '계정을 추가했습니다. 「로그인」을 눌러 Claude 계정에 연결하세요');

  return (
    <Section title="AI 계정" sub="팀·총괄이 쓸 Claude 계정을 여러 개 두고 역할마다 고릅니다">
      <div className="panel stack-s">
        <div className="set-row">
          <label htmlFor="acc-default">기본 계정<small>템플릿 역할에 계정을 고르지 않으면 이 계정을 씁니다</small></label>
          <span className="set-v">
            <select id="acc-default" disabled={ro || !list} value={snap.settings.defaultAccount} onChange={(e) => void save({ defaultAccount: e.target.value }, '기본 계정을 바꿨습니다')}>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
        <div className="set-row">
          <label htmlFor="acc-po">총괄 계정<small>총괄이 쓸 계정 · 바꾸면 총괄은 요약을 넘겨받아 새 대화로 이어 갑니다</small></label>
          <span className="set-v">
            <select id="acc-po" disabled={ro || !list} value={snap.settings.poAccount ?? ''} onChange={(e) => void save({ poAccount: e.target.value || null }, '총괄 계정을 바꿨습니다')}>
              <option value="">기본 계정 따라감</option>
              {(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </span>
        </div>
      </div>

      {(list ?? []).map((a) => <AccountCard key={a.id} a={a} ro={ro} reload={load} onDefault={() => void save({ defaultAccount: a.id }, `${a.name} 을(를) 기본 계정으로 정했습니다`)} />)}

      {!ro && (
        <div className="panel stack-s">
          <div className="set-row">
            <label htmlFor="acc-new">Claude 계정 추가<small>회사·개인처럼 다른 Claude 계정을 하나 더 연결합니다. 추가한 뒤 「로그인」</small></label>
            <span className="set-v row">
              <input id="acc-new" value={name} maxLength={40} placeholder="예: 회사 계정" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add(); }} />
              <button className="btn primary" type="button" disabled={!name.trim()} onClick={() => void add()}>추가</button>
            </span>
          </div>
          <div className="small muted">
            계정마다 로그인 정보를 따로 둡니다(<code className="mono">~/.hivelane/accounts/…</code>). 역할에 쓸 계정은 <a href="#templates">팀 템플릿</a>에서 고릅니다.
            Agent 도구로 부르는 팀원은 PM 과 같은 계정을 씁니다. 같은 사람이 구독을 여러 개 만들어 사용 한도를 피하는 것은 서비스 약관에 어긋날 수 있습니다.
          </div>
        </div>
      )}
    </Section>
  );
}

function pctTone(p: number): string { return p >= 90 ? 'var(--crit)' : p >= 70 ? 'var(--warn)' : 'var(--good)'; }

function AccountCard({ a, ro, reload, onDefault }: { a: AiAccountView; ro: boolean; reload: () => Promise<unknown>; onDefault: () => void }) {
  const [code, setCode] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const login = a.usage?.login ?? null;
  const flow: AuthLoginView = a.loginFlow;
  const base = `/api/accounts/${encodeURIComponent(a.id)}`;
  const start = () => act(async () => { await api(`${base}/login`, 'POST', {}); await reload(); });
  const send = () => act(async () => { await api(`${base}/login/code`, 'POST', { code }); setCode(''); await reload(); }, '코드를 보냈습니다');
  const cancel = () => act(async () => { await api(`${base}/login/cancel`, 'POST', {}); await reload(); });
  const refresh = () => act(async () => { await api(`${base}/refresh`, 'POST', {}); await reload(); }, '사용량을 새로 읽었습니다');
  const remove = () => { if (confirm(`${a.name} 계정을 지울까요? 이 계정을 쓰던 역할·총괄은 기본 계정으로 돌아갑니다.`)) void act(async () => { await api(base, 'DELETE'); await refreshState(); await reload(); }, '계정을 지웠습니다'); };
  const rename = () => act(async () => { await api(base, 'PATCH', { name: renaming }); setRenaming(null); await reload(); }, '이름을 바꿨습니다');

  return (
    <div className="panel stack-s">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          {renaming !== null
            ? <span className="row"><input value={renaming} maxLength={40} onChange={(e) => setRenaming(e.target.value)} aria-label="계정 이름" /><button className="btn" type="button" onClick={() => void rename()}>저장</button><button className="btn ghost" type="button" onClick={() => setRenaming(null)}>취소</button></span>
            : <b>{a.name}</b>}
          {a.isDefault && <span className="chip" style={{ marginLeft: 6 }}>기본</span>}
          <span className="chip" style={{ marginLeft: 6 }}>Claude</span>
          <div className="small muted">
            {login?.loggedIn ? <>로그인됨{login.email ? ` · ${login.email}` : ''}{a.usage?.plan ? ` · ${a.usage.plan}` : ''}{login.expiresAt ? ` · ${new Date(login.expiresAt).toLocaleDateString('ko-KR')} 만료` : ''}</> : <span style={{ color: 'var(--crit)' }}>로그인 필요</span>}
            {a.id === 'default' && ' · 이 맥의 Claude Code 로그인(~/.claude)과 같습니다'}
          </div>
        </div>
        {!ro && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {flow.phase !== 'waiting' && <button className="btn primary" type="button" onClick={() => void start()}>{login?.loggedIn ? '다시 로그인' : '로그인'}</button>}
            <button className="btn" type="button" onClick={() => void refresh()}>사용량 새로 읽기</button>
            {!a.isDefault && <button className="btn" type="button" onClick={onDefault}>기본으로</button>}
            {a.id !== 'default' && renaming === null && <button className="btn ghost" type="button" onClick={() => setRenaming(a.name)}>이름 바꾸기</button>}
            {a.id !== 'default' && <button className="btn ghost" type="button" onClick={remove}>지우기</button>}
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
              <span className="muted" style={{ width: 110 }}>{w.resets_at ? `${new Date(w.resets_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 초기화` : ''}</span>
            </div>
          ))}
        </div>
      ) : <div className="small muted">{a.usage?.error ? `사용량을 읽지 못했습니다: ${a.usage.error}` : login?.loggedIn ? '플랜 사용량이 없습니다(API 키 로그인 등)' : '로그인하면 사용량이 보입니다'}</div>}

      {flow.phase === 'waiting' && (
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
