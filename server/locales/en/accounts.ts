/** server/accounts.ts */
export default {
  'AI 계정 원래대로': 'AI account switched back',
  'AI 계정 자동 전환': 'AI account switched automatically',
  'AI 계정 전환을 권합니다': 'Consider switching AI account',
  'Claude 와 Codex 계정끼리는 바꿔 쓸 수 없습니다': 'Claude and Codex accounts cannot be swapped for each other',
  '{name} 사용량 {pct}% — 설정 › AI 계정에서 「{to} 으로 전환」을 누르면 바꿔 씁니다.': '{name} usage is {pct}% — press “Switch to {to}” in Settings › AI accounts to switch.',
  '{name} 사용량 {pct}% → {to} 으로 바꿔 씁니다. 한도가 초기화되면 저절로 돌아옵니다.': '{name} usage is {pct}% → switching to {to}. It switches back automatically when the limit resets.',
  '{name} 사용량이 기준 아래로 내려와 다시 씁니다.': '{name} usage dropped below the threshold, using it again.',
  '계정을 지웠습니다': 'Account deleted',
  '바꿔 쓸 계정이 없습니다(로그인돼 있고 사용량이 기준 아래인 계정)': 'No account to switch to (needs to be signed in and below the usage threshold)',
  '새 계정': 'New account',
  '없는 계정입니다': 'No such account',
  '이 맥 Codex': 'This Mac’s Codex',
  '이 맥 기본 계정': 'This Mac’s default account',
  '이 맥 기본 계정은 이름을 바꿀 수 없습니다': 'This Mac’s default account cannot be renamed',
  '이 맥 기본 계정은 지울 수 없습니다': 'This Mac’s default account cannot be deleted',
} as Record<string, string>;
