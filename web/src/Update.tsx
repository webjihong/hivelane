/**
 * 새 버전 안내: 「지금 볼 것」 맨 위 띠(버전마다 닫을 수 있음) + 설정 맨 아래 버전 줄(현재·최신·지금 확인).
 * 업데이트 방법은 설치 방식(brew · DMG 앱 · 저장소)에 맞춰 보여 준다. 깔고 나면 서버가 한가할 때 새 버전으로 저절로 다시 시작한다.
 */
import { useState } from 'react';
import type { StateSnapshot, UpdateView } from '../../shared/types.ts';
import { locale, t } from './i18n.ts';
import { act, api, refreshState, toast } from './store.ts';

const DISMISS = 'hl-update-dismissed';
const BREW = 'brew upgrade --cask hivelane';

function Command({ cmd }: { cmd: string }) {
  return (
    <span className="upd-cmd">
      <code>{cmd}</code>
      <button type="button" className="link-btn" onClick={() => { void navigator.clipboard?.writeText(cmd); toast(t('복사했습니다')); }}>{t('복사')}</button>
    </span>
  );
}

/** 설치 방식에 맞는 업데이트 방법 */
function HowTo({ u }: { u: UpdateView }) {
  if (u.install === 'brew') return <>{t('터미널에서')} <Command cmd={BREW} /></>;
  if (u.install === 'app') return <>{t('새 DMG 를 받아 응용 프로그램 폴더의 Hivelane 을 바꾸세요.')} <a href={u.url ?? '#'} target="_blank" rel="noreferrer">{t('DMG 받기')}</a></>;
  return <>{t('저장소에서')} <Command cmd="git pull && npm run service:restart" /></>;
}

export function UpdateBanner({ snap }: { snap: StateSnapshot }) {
  const u = snap.update;
  const [closed, setClosed] = useState(() => { try { return localStorage.getItem(DISMISS); } catch { return null; } });
  if (!u?.hasUpdate || !u.latest || closed === u.latest) return null;
  const close = () => { try { localStorage.setItem(DISMISS, u.latest!); } catch { /* 저장 안 됨 */ } setClosed(u.latest); };
  return (
    <article className="nw-card upd" role="status">
      <div className="nw-meta"><b>{t('새 버전 {v} 이 나왔습니다', { v: u.latest })}</b> · {t('지금 {v}', { v: u.current })}{u.url && <> · <a href={u.url} target="_blank" rel="noreferrer">{t('바뀐 점')}</a></>}</div>
      <div className="nw-q"><HowTo u={u} /></div>
      <div className="muted small">{t('깔고 나면 일하는 팀이 없을 때 서버가 새 버전으로 저절로 다시 시작합니다.')}</div>
      <div className="nw-acts"><button type="button" className="btn" onClick={close}>{t('이 버전은 그만 보기')}</button></div>
    </article>
  );
}

export function VersionRow({ snap, ro }: { snap: StateSnapshot; ro: boolean }) {
  const u = snap.update;
  const check = () => act(async () => {
    const v = await api<UpdateView>('/api/update/check', 'POST', {});
    await refreshState();
    if (v.error) toast(t('확인하지 못했습니다: {e}', { e: v.error }), 'crit');
    else toast(v.hasUpdate ? t('새 버전 {v} 이 있습니다', { v: v.latest ?? '' }) : t('최신 버전입니다'));
  });
  const when = u?.checkedAt ? new Date(u.checkedAt).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="note-sample upd-row">
      <span>Hivelane {snap.version}</span>
      {u && (u.hasUpdate && u.latest
        ? <span className="upd-new"> · {t('새 버전 {v}', { v: u.latest })} — <HowTo u={u} /></span>
        : u.latest ? <span> · {t('최신 버전입니다')}</span> : null)}
      {u && when && <span className="muted"> · {t('{when} 확인', { when })}{u.error ? ` (${t('실패')})` : ''}</span>}
      {u && <> · <button type="button" className="link-btn" onClick={() => void check()}>{t('지금 확인')}</button></>}
      <span className="muted"> · {ro ? t('원격 접속') : t('로컬 접속')}</span>
    </div>
  );
}
