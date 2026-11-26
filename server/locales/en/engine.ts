/** 총괄 엔진 글 (server/po/engine.ts) */
export default {
  '강한 멈춤 해제': 'Hard pause lifted',
  '{reason} · 프로세스 {n}개 정지': '{reason} · {n} processes stopped',
  '재개': 'Resumed',
  '{min}분 동안 진행 없음': 'No progress for {min} min',
  '장애 상태 자동 복구 시도 {n}회째': 'Auto-recovery attempt #{n}',
  '읽지 않은 답변 {n}건': '{n} unread replies',
  '· {name} {n}건': '· {name}: {n}',
  '외 {n}곳': '{n} more',
  '실행 중인데 루프가 없음 → 다시 깨움': 'Marked running but no loop → woke it again',
  '점검 이상(종료 코드 {code})': 'Check failed (exit code {code})',
  '점검 실패(코드 {code}) → 팀 깨움': 'Check failed (code {code}) → woke the team',
  '점검 정상으로 돌아옴': 'Check back to normal',
} as Record<string, string>;
