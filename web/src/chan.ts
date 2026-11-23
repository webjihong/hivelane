import type { StateSnapshot, TeamView } from '../../shared/types.ts';

/** 채널 상태 점: 일하는 중 · 내 결정 · 멈춤 · 대기열 · 대기 */
export type Dot = 'run' | 'ask' | 'pause' | 'queue' | 'idle';
export function dotOf(t: TeamView): Dot {
  if (t.state === 'running' || t.state === 'reviving') return 'run';
  if (t.state === 'waiting_human' || t.state === 'failed' || t.state === 'down') return 'ask';
  if (t.state === 'paused') return 'pause';
  if (t.state === 'queued') return 'queue';
  return 'idle';
}
export const DOT_LABEL: Record<Dot, string> = { run: '일하는 중', ask: '내 결정·확인 필요', pause: '일시정지', queue: '대기열', idle: '대기' };
const STAGE = ['기획', '구현', '검사', '보고'];

/** 채널 이름 오른쪽에 붙는 짧은 상태 글 */
export function sideNote(t: TeamView, _now: number): { text: string; cls: string } | null {
  if (t.state === 'waiting_human') return { text: t.question?.options.includes('승인') ? '승인' : '결정', cls: 'b-ask' };
  if (t.state === 'failed') return { text: '실패', cls: 'b-ask' };
  if (t.state === 'down' || t.state === 'reviving') return { text: t.state === 'down' ? '장애' : '복구 중', cls: 'b-ask' };
  if (t.state === 'running') return { text: t.lifetime === 'standing' ? '일하는 중' : `${STAGE[Math.min(t.stage, 3)]} ${Math.min(t.stage, 3) + 1}/4`, cls: 't-run' };
  if (t.state === 'paused') return { text: t.pause_kind?.startsWith('engine') ? '멈춤 · 자동 재개 대기' : '멈춤', cls: 't-pause' };
  if (t.state === 'queued') return { text: '대기열', cls: 't-muted' };
  return null;
}

export const isStandingCh = (t: TeamView) => t.lifetime === 'standing' && t.state !== 'archived';
export const isActiveTask = (t: TeamView) => t.lifetime === 'task' && !['done', 'archived'].includes(t.state);
export const isDoneTask = (t: TeamView) => t.lifetime === 'task' && t.state === 'done';

/** 「지금 볼 것」 수: 내 답이 필요한 것 + 안 읽은 것 */
export function nowCount(snap: StateSnapshot): { need: number; news: number } {
  const live = snap.teams.filter((t) => t.state !== 'archived');
  const need = live.filter((t) => t.state === 'waiting_human' || t.state === 'failed' || t.state === 'down').length + snap.proposals.filter((p) => p.status === 'pending').length;
  const news = live.reduce((a, t) => a + (t.unread > 0 && t.state !== 'waiting_human' ? 1 : 0), 0) + (snap.poUnread > 0 ? 1 : 0);
  return { need, news };
}
