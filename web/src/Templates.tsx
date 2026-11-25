import { MODEL_LABEL } from './art.ts';
import { useState } from 'react';
import { isSolo, SOLO_TOOLS_LABEL, TOOL_PRESET_LABEL, type Model, type RunMode, type StateSnapshot, type TeamTemplate, type TemplateRole, type ToolPreset } from '../../shared/types.ts';
import { act, api, refreshState } from './store.ts';
import { ConfirmButton, Section } from './ui.tsx';
import { useAccountList } from './Accounts.tsx';

const PRESETS = Object.keys(TOOL_PRESET_LABEL) as ToolPreset[];
const KEY_RE = /^[a-z0-9_-]+$/;

function slug(s: string): string {
  const a = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return a || 'custom';
}
function makeId(name: string, existing: string[]): string {
  const base = `tpl-${slug(name)}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}
function uniqueKey(roles: TemplateRole[], base: string): string {
  if (!roles.some((r) => r.key === base)) return base;
  for (let i = 2; ; i++) if (!roles.some((r) => r.key === `${base}${i}`)) return `${base}${i}`;
}

function TemplateEditor({ tpl, readOnly, isNew, existing = [], onDone }: { tpl: TeamTemplate; readOnly: boolean; isNew?: boolean; existing?: string[]; onDone?: () => void }) {
  const [d, setD] = useState<TeamTemplate>(() => structuredClone(tpl));
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = isNew ? makeId(d.name, existing) : d.id;
  const dirty = isNew || JSON.stringify(d) !== JSON.stringify(tpl);
  const sessions = d.roles.filter((r) => r.mode === 'session' || r.key === 'pm').length;
  const solo = isSolo(d.roles);
  const accounts = useAccountList();

  const setRole = (i: number, patch: Partial<TemplateRole>) => setD((t) => ({ ...t, roles: t.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const keyErr = d.roles.map((r, i) => !KEY_RE.test(r.key) ? '소문자·숫자·-·_ 만' : d.roles.findIndex((x) => x.key === r.key) !== i ? '중복' : r.key.length > 20 ? '20자 이하' : '');
  const invalid = !d.name.trim() || keyErr.some(Boolean) || d.roles.some((r) => !r.name.trim());

  const save = async () => {
    setSaving(true);
    const roles = d.roles.map((r) => {
      const base: TemplateRole = { key: r.key, name: r.name.trim(), model: r.model, mode: r.key === 'pm' ? 'session' : r.mode, tools: r.tools, ...(r.account ? { account: r.account } : {}) };
      return r.prompt?.trim() ? { ...base, prompt: r.prompt } : base;
    });
    const r = await act(() => api(`/api/templates/${encodeURIComponent(id)}`, 'PUT', { name: d.name.trim(), description: d.description, roles }), '템플릿을 저장했습니다');
    setSaving(false);
    if (r !== undefined) { await refreshState(); onDone?.(); }
  };
  const del = async () => {
    const r = await act(() => api(`/api/templates/${encodeURIComponent(d.id)}`, 'DELETE'), '템플릿을 지웠습니다');
    if (r !== undefined) await refreshState();
  };

  return (
    <div className="panel">
      <div className="tpl-h">
        {readOnly ? <div><b>{d.name}</b> <span className="muted small">{d.description}</span></div> : (
          <div className="tpl-name">
            <input className="txt" value={d.name} maxLength={40} onChange={(e) => setD({ ...d, name: e.target.value })} aria-label="템플릿 이름" placeholder="템플릿 이름" />
            <input className="txt grow" value={d.description} maxLength={200} onChange={(e) => setD({ ...d, description: e.target.value })} aria-label="설명" placeholder="설명" />
          </div>
        )}
        <span className="chip">세션 {sessions}개 · 약 {(0.5 * sessions).toFixed(1)}GB</span>
      </div>
      <div className="muted small mono">{id}{d.builtin ? ' · 기본 제공' : ''}</div>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>키</th><th>역할</th><th>모델</th><th title="이 역할이 쓸 AI 계정(설정 › AI 계정)">계정</th><th>실행 방식</th><th>허용 도구</th><th /></tr></thead>
        <tbody>
          {d.roles.map((r, i) => {
            const pm = r.key === 'pm';
            return [
              <tr key={`${i}-row`}>
                <td>{readOnly || pm ? <span className="mono">{r.key}</span> : <><input className="txt key" value={r.key} maxLength={20} onChange={(e) => setRole(i, { key: e.target.value.toLowerCase() })} aria-label="역할 키" />{keyErr[i] && <small className="crit-t"> {keyErr[i]}</small>}</>}</td>
                <td>{readOnly ? <b>{r.name}</b> : <input className="txt short" value={r.name} maxLength={20} onChange={(e) => setRole(i, { name: e.target.value })} aria-label="역할 이름" />}</td>
                <td><select disabled={readOnly} value={r.model} onChange={(e) => setRole(i, { model: e.target.value as Model })} aria-label={`${r.name} 모델`}>
                  <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                </select></td>
                <td>{!pm && r.mode === 'subagent' ? <span className="muted small" title="Agent 도구로 부르는 팀원은 PM 과 같은 계정을 씁니다">PM 계정</span> : (
                  <select disabled={readOnly} value={r.account ?? ''} onChange={(e) => setRole(i, { account: e.target.value || null })} aria-label={`${r.name} 계정`}>
                    <option value="">기본 계정</option>
                    {/* Codex 는 PM 이 맡기는 독립 세션 팀원만(PM 은 Claude 도구로 팀을 움직여야 해서) */}
                    {accounts.filter((a) => !pm || a.provider === 'claude').map((a) => <option key={a.id} value={a.id}>{a.provider === 'codex' ? `${a.name} (Codex)` : a.name}</option>)}
                    {r.account && !accounts.some((a) => a.id === r.account && (!pm || a.provider === 'claude')) && <option value={r.account}>(쓸 수 없는 계정 → 기본)</option>}
                  </select>
                )}</td>
                <td>{pm ? <span className="muted small">독립 세션 (고정)</span> : (
                  <select disabled={readOnly} value={r.mode} onChange={(e) => setRole(i, { mode: e.target.value as RunMode })} aria-label={`${r.name} 실행 방식`}>
                    <option value="session">독립 세션</option><option value="subagent">서브에이전트</option>
                  </select>
                )}</td>
                <td>{pm && solo ? <span className="small" title="역할이 하나면 1인 팀으로 동작">{SOLO_TOOLS_LABEL}</span> : (
                  <select disabled={readOnly || pm} value={r.tools} onChange={(e) => setRole(i, { tools: e.target.value as ToolPreset })} aria-label={`${r.name} 허용 도구`} title={TOOL_PRESET_LABEL[r.tools]}>
                    {PRESETS.map((p) => <option key={p} value={p}>{TOOL_PRESET_LABEL[p]}</option>)}
                  </select>
                )}</td>
                <td className="nowrap">
                  <button className="btn" type="button" onClick={() => setOpenPrompt(openPrompt === `${i}` ? null : `${i}`)}>{r.prompt ? '프롬프트 ✎' : '프롬프트'}</button>
                  {!readOnly && !pm && <button className="btn" type="button" onClick={() => setD({ ...d, roles: d.roles.filter((_, j) => j !== i) })}>빼기</button>}
                </td>
              </tr>,
              openPrompt === `${i}` ? (
                <tr key={`${i}-prompt`}><td colSpan={7}>
                  <textarea className="txt area" rows={5} readOnly={readOnly} maxLength={4000} value={r.prompt ?? ''} placeholder="비우면 역할 기본 프롬프트를 씁니다" onChange={(e) => setRole(i, { prompt: e.target.value })} aria-label={`${r.name} 프롬프트`} />
                </td></tr>
              ) : null,
            ];
          })}
        </tbody>
      </table></div>
      {solo && <div className="muted small" style={{ marginTop: 6 }}>역할이 하나면 1인 팀으로 동작: 혼자 수정·테스트·배포까지 함</div>}
      {!readOnly && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" type="button" disabled={d.roles.length >= 8} onClick={() => setD({ ...d, roles: [...d.roles, { key: uniqueKey(d.roles, 'review'), name: '리뷰어', model: 'opus', mode: 'subagent', tools: 'read' }] })}>역할 추가</button>
          <span className="grow" />
          {isNew && <button className="btn" type="button" onClick={onDone}>취소</button>}
          {!isNew && dirty && <button className="btn" type="button" onClick={() => setD(structuredClone(tpl))}>되돌리기</button>}
          {!isNew && !d.builtin && <ConfirmButton label="삭제" confirmLabel="이 템플릿을 지울까요?" onConfirm={() => void del()} />}
          <button className="btn primary" type="button" disabled={!dirty || invalid || saving} onClick={() => void save()}>{isNew ? '만들기' : '저장'}</button>
        </div>
      )}
    </div>
  );
}

/** 프로젝트 기본 템플릿만 펼쳐 두고, 나머지는 한 줄 요약으로 접는다(펼친 상태는 이 기기에 기억). */
function TemplateItem({ tpl, readOnly, defaultFor }: { tpl: TeamTemplate; readOnly: boolean; defaultFor: string[] }) {
  const accounts = useAccountList();
  const key = `hl.tpl.${tpl.id}`;
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? defaultFor.length > 0 : v === '1'; } catch { return defaultFor.length > 0; } });
  const toggle = () => { setOpen(!open); try { localStorage.setItem(key, open ? '0' : '1'); } catch { /* 저장 안 됨 */ } };
  const sessions = tpl.roles.filter((r) => r.mode === 'session' || r.key === 'pm').length;
  if (open) return (
    <div className="tpl-open">
      <button type="button" className="tpl-fold" onClick={toggle} aria-expanded="true">접기 ▴</button>
      <TemplateEditor tpl={tpl} readOnly={readOnly} />
    </div>
  );
  return (
    <button type="button" className="tpl-row" onClick={toggle} aria-expanded="false">
      <span className="tpl-row-t"><b>{tpl.name}</b>{defaultFor.length > 0 && <span className="chip">기본 · {defaultFor.join(', ')}</span>}{tpl.builtin && <span className="muted small">기본 제공</span>}</span>
      <span className="tpl-row-d muted">{tpl.description}</span>
      <span className="tpl-row-r">{tpl.roles.map((r) => <span key={r.key} className="chip">{r.name} · {MODEL_LABEL[r.model]}{r.key !== 'pm' && r.mode === 'session' ? ' · 세션' : ''}{r.account && (r.key === 'pm' || r.mode === 'session') ? ` · ${accounts.find((x) => x.id === r.account)?.name ?? '기본 계정'}` : ''}</span>)}</span>
      <span className="muted small">세션 {sessions}개 · 펼치기 ▾</span>
    </button>
  );
}

export function Templates({ snap }: { snap: StateSnapshot }) {
  const readOnly = snap.access === 'remote';
  const [draft, setDraft] = useState<TeamTemplate | null>(null);
  const startNew = () => {
    setDraft({ id: 'new', name: '새 팀', description: '', builtin: false, roles: [
      { key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' },
      { key: 'dev', name: '개발', model: 'sonnet', mode: 'subagent', tools: 'write' },
    ] });
  };
  return (
    <>
      <Section title="팀 템플릿" right={<span>총괄이 팀을 구성할 때 고르는 틀 · 바꾸면 다음 팀부터 적용{!readOnly && !draft && <> · <button className="back" type="button" onClick={startNew}>새 템플릿</button></>}</span>}>
        {readOnly && <div className="ro-note">원격 접속에서는 보기만 할 수 있습니다. 템플릿은 맥에서 바꾸세요.</div>}
        <div className="stack">
          {draft && <TemplateEditor key="new" tpl={draft} readOnly={false} isNew existing={snap.templates.map((t) => t.id)} onDone={() => setDraft(null)} />}
          {snap.templates.map((t) => <TemplateItem key={`${t.id}:${JSON.stringify(t)}`} tpl={t} readOnly={readOnly} defaultFor={snap.projects.filter((p) => p.default_template_id === t.id).map((p) => p.name)} />)}
        </div>
      </Section>
      <p className="note-sample">세션 수와 메모리는 「독립 세션 1개 ≈ 0.5GB」 기준으로 바로 다시 계산됩니다.</p>
    </>
  );
}
