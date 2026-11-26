import type { StateSnapshot, TeamView } from '../../shared/types.ts';
import { t } from './i18n.ts';

/** 채널 상태 점: 일하는 중 · 내 결정 · 멈춤 · 대기열 · 대기 */
export type Dot = 'run' | 'ask' | 'pause' | 'queue' | 'idle';
/** 사람의 답을 기다리는 질문이 걸려 있나(직속 팀은 상태가 「대기」여도 질문이 걸릴 수 있다) */
export const asks = (t: TeamView) => !!t.question && ['waiting_human', 'idle', 'down', 'paused'].includes(t.state);
/** 서버가 만든 승인/거절 선택지(서버 언어에 따라 한국어 또는 영어) */
const hasOpt = (o: string[] | undefined, ko: string, en: string) => !!o && (o.includes(ko) || o.includes(en));
export const hasApprove = (o: string[] | undefined) => hasOpt(o, '승인', 'Approve');
export const isApproval = (o: string[] | undefined) => hasApprove(o) && hasOpt(o, '거절', 'Reject');

export function dotOf(t: TeamView): Dot {
  if (asks(t)) return 'ask';
  if (t.state === 'running' || t.state === 'reviving') return 'run';
  if (t.state === 'waiting_human' || t.state === 'failed' || t.state === 'down') return 'ask';
  if (t.state === 'paused') return 'pause';
  if (t.state === 'queued') return 'queue';
  return 'idle';
}
export const DOT_LABEL: Record<Dot, string> = { run: t('일하는 중'), ask: t('내 결정·확인 필요'), pause: t('일시정지'), queue: t('대기열'), idle: t('대기') };
const STAGE = [t('기획'), t('구현'), t('검사'), t('보고')];

/** 채널 이름 오른쪽에 붙는 짧은 상태 글 */
export function sideNote(tm: TeamView, _now: number): { text: string; cls: string } | null {
  if (asks(tm) || tm.state === 'waiting_human') return { text: hasApprove(tm.question?.options) ? t('승인') : t('결정'), cls: 'b-ask' };
  if (tm.state === 'failed') return { text: t('실패'), cls: 'b-ask' };
  if (tm.state === 'down' || tm.state === 'reviving') return { text: tm.state === 'down' ? t('장애') : t('복구 중'), cls: 'b-ask' };
  if (tm.state === 'running') return { text: tm.lifetime === 'standing' ? t('일하는 중') : `${STAGE[Math.min(tm.stage, 3)]} ${Math.min(tm.stage, 3) + 1}/4`, cls: 't-run' };
  if (tm.state === 'paused') return { text: tm.pause_kind?.startsWith('engine') ? t('멈춤 · 자동 재개 대기') : t('멈춤'), cls: 't-pause' };
  if (tm.state === 'queued') return { text: t('대기열'), cls: 't-muted' };
  return null;
}

export const isStandingCh = (t: TeamView) => t.lifetime === 'standing' && t.state !== 'archived';
export const isActiveTask = (t: TeamView) => t.lifetime === 'task' && !['done', 'archived'].includes(t.state);
export const isDoneTask = (t: TeamView) => t.lifetime === 'task' && t.state === 'done';

/** 「지금 볼 것」 수: 내 답이 필요한 것 + 안 읽은 것 */
export function nowCount(snap: StateSnapshot): { need: number; news: number } {
  const live = snap.teams.filter((t) => t.state !== 'archived');
  const need = live.filter((t) => asks(t) || t.state === 'waiting_human' || t.state === 'failed' || t.state === 'down').length + snap.proposals.filter((p) => p.status === 'pending').length;
  const news = live.reduce((a, t) => a + (t.unread > 0 && !asks(t) && t.state !== 'waiting_human' ? 1 : 0), 0) + (snap.poUnread > 0 ? 1 : 0);
  return { need, news };
}
