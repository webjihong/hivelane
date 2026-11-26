import { useEffect, useState } from 'react';
import type { KnowledgeView } from '../../shared/types.ts';
import { act, api } from './store.ts';
import { ConfirmButton, RichText, hhmm } from './ui.tsx';
import { t } from './i18n.ts';

function Item({ k, onChanged }: { k: KnowledgeView; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const [d, setD] = useState({ name: k.name, when_to_use: k.when_to_use, body: k.body, kind: k.kind });
  const [open, setOpen] = useState(false);
  const save = async () => {
    const r = await act(() => api(`/api/knowledge/${encodeURIComponent(k.id)}`, 'PATCH', d), t('저장했습니다'));
    if (r !== undefined) { setEdit(false); onChanged(); }
  };
  const del = async () => { const r = await act(() => api(`/api/knowledge/${encodeURIComponent(k.id)}`, 'DELETE'), t('지웠습니다')); if (r !== undefined) onChanged(); };
  return (
    <div className="kn-item">
      <div className="kn-head" onClick={() => !edit && setOpen(!open)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && !edit) setOpen(!open); }}>
        <span className={`kn-kind ${k.kind}`}>{k.kind === 'skill' ? t('스킬') : t('메모')}</span>
        <div className="kn-title">
          <b>{k.name}</b>
          <div className="muted small">{k.when_to_use || (k.kind === 'note' ? k.body.slice(0, 90) : '')}</div>
        </div>
        <span className="muted small kn-meta">{k.uses ? `${t('{n}회 사용', { n: k.uses })} · ` : ''}{hhmm(k.updated_at)}</span>
      </div>
      {(open || edit) && (
        edit ? (
          <div className="form-grid kn-edit">
            <label>{t('종류')}<select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as KnowledgeView['kind'] })}><option value="skill">{t('스킬 (절차)')}</option><option value="note">{t('메모 (늘 기억)')}</option></select></label>
            <label>{t('이름')}<input className="txt" value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
            <label className="wide">{t('언제 쓰나')}<input className="txt" value={d.when_to_use} maxLength={500} onChange={(e) => setD({ ...d, when_to_use: e.target.value })} /></label>
            <label className="wide">{t('본문@지식')}<textarea className="txt area mono" rows={12} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></label>
            <div className="row"><button className="btn primary" type="button" onClick={() => void save()} disabled={!d.name.trim() || !d.body.trim()}>{t('저장')}</button><button className="btn" type="button" onClick={() => { setEdit(false); setD({ name: k.name, when_to_use: k.when_to_use, body: k.body, kind: k.kind }); }}>{t('취소')}</button></div>
          </div>
        ) : (
          <div className="kn-body">
            <RichText text={k.body} />
            {k.source && <div className="muted small">{t('출처:')} {k.source}</div>}
            <div className="row"><button className="btn" type="button" onClick={() => setEdit(true)}>{t('고치기')}</button><ConfirmButton label={t('지우기')} confirmLabel={t('정말 지우기')} onConfirm={() => void del()} /></div>
          </div>
        )
      )}
    </div>
  );
}

export function KnowledgeDrawer({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<KnowledgeView[] | null>(null);
  const load = async () => { const r = await act(() => api<KnowledgeView[]>('/api/knowledge')); if (r) setRows(r); };
  useEffect(() => { void load(); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', h); return () => removeEventListener('keydown', h); }, [onClose]);
  const skills = rows?.filter((k) => k.kind === 'skill') ?? [];
  const notes = rows?.filter((k) => k.kind === 'note') ?? [];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={t('총괄이 배운 것')}>
        <div className="drawer-h">
          <div>
            <h2>{t('총괄이 배운 것')}</h2>
            <div className="drawer-sub muted">{t('총괄에게 「이렇게 하는 법 배워둬」, 「기억해」, 「잊어」라고 말하면 여기에 쌓입니다. 스킬은 해당 상황에 꺼내 쓰고, 메모는 늘 기억합니다.')}</div>
          </div>
          <button className="btn" type="button" onClick={onClose}>{t('닫기')}</button>
        </div>
        <div className="drawer-b">
          {rows === null ? <div className="muted">{t('불러오는 중…')}</div> : rows.length === 0 ? <div className="muted">{t('아직 배운 것이 없습니다.')}</div> : (
            <>
              <h4 className="kn-h">{t('스킬 {n}', { n: skills.length })}</h4>
              {skills.map((k) => <Item key={`${k.id}:${k.updated_at}`} k={k} onChanged={() => void load()} />)}
              <h4 className="kn-h">{t('메모 {n}', { n: notes.length })}</h4>
              {notes.map((k) => <Item key={`${k.id}:${k.updated_at}`} k={k} onChanged={() => void load()} />)}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
