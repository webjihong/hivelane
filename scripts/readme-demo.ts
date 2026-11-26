/**
 * README 스크린샷용 데모 데이터(가짜 프로젝트·팀·대화) — 실제 데이터와 섞이지 않게 따로 만든 HIVELANE_HOME 에 넣는다.
 *   HIVELANE_HOME=/tmp/hl-demo npx tsx scripts/readme-demo.ts
 * 그 다음 같은 HIVELANE_HOME 으로 서버를 띄우고 scripts/readme-shots.mjs 로 찍는다(README 의 「스크린샷 다시 찍기」).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirs, loadConfig } from '../server/config.ts';
import { openDb } from '../server/db/index.ts';
import { initServerI18n } from '../server/i18n.ts';
import { SERVER_EN } from '../server/locales/en/index.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { seedTemplates, Store } from '../server/store.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';

/** HL_LANG=en 이면 영어 데모(영어 README 스크린샷용) */
const EN = process.env.HL_LANG === 'en';
const L = <T,>(ko: T, en: T): T => (EN ? en : ko);
const cfg = loadConfig();
ensureDirs(cfg);
const store = new Store(openDb(cfg.dbPath));
initServerI18n(() => (EN ? 'en' : 'ko'), SERVER_EN); // 팀 생성 알림 같은 서버 글도 데모 언어로
seedTemplates(store);
const runner: TurnRunner = { async runTurn() { throw new Error('데모'); } };
const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier() });

// 가짜 저장소 두 개
function repo(name: string): string {
  const dir = join(cfg.home, 'demo-repos', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-qm', 'init');
  return dir;
}
const shop = store.insertProject({ name: 'shop-web', path: repo('shop-web'), base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: 'tpl-dev' });
const api = store.insertProject({ name: 'shop-api', path: repo('shop-api'), base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: 'tpl-dev' });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const team = (title: string, projectId: string, tpl: string, instruction: string) => {
  const p = store.insertProposal({ project_id: projectId, title, instruction, brief: instruction, template_id: tpl, roles: store.getTemplate(tpl)!.roles, priority: 'normal', budget_usd: 5, note: '' });
  const ROLE_EN: Record<string, string> = { 개발: 'Developer', 리뷰어: 'Reviewer', 탐색: 'Explorer', 점검: 'Inspector', 조사: 'Research' };
  return orch.createFromProposal(p.id, EN ? { roles: store.getTemplate(tpl)!.roles.map((r) => ({ ...r, name: ROLE_EN[r.name] ?? r.name })) } : {});
};

// 1) 일하는 중인 팀: 결제 버그
const pay = team(L('결제 완료 후 주문 상태가 「대기」로 남는 버그 수정', 'Fix orders stuck in "Pending" after payment'), shop.id, 'tpl-big', L('결제가 끝났는데 주문 목록에 「결제 대기」로 보인다. 원인을 찾아 고치고 테스트를 추가해라.', 'Payment succeeds but the order list still shows "Awaiting payment". Find the cause, fix it and add tests.'));
store.setChecklist(pay.id, L(['재현: 결제 완료 웹훅 → 주문 상태 확인', '원인: 웹훅 처리 순서(결제 → 주문) 경합', '수정 + 회귀 테스트', '타입 검사·테스트 통과 확인', '보고'], ['Reproduce: payment webhook → order status', 'Cause: race between payment and order webhooks', 'Fix + regression test', 'Type check and tests pass', 'Report']));
store.checkItem(pay.id, 0, true); store.checkItem(pay.id, 1, true);
// 서버를 띄웠을 때 엔진이 실제로 돌리지 않게 「사용자 멈춤」으로 둔다(찍기 직전에 readme-shots 가 「일하는 중」 표시로 바꿈)
store.updateTeam(pay.id, { state: 'paused', pause_kind: 'user', paused_reason: L('데모', 'demo'), stage: 1, cost_usd: 0.84, started_at: ago(23) });
store.addMessage({ team_id: pay.id, from_label: 'PM', to_label: L('개발', 'Developer'), kind: 'handoff', body: L('orders/webhook.ts 에서 결제 완료 이벤트가 주문 생성보다 먼저 오면 상태가 덮어써진다. 주문을 먼저 잠그고(트랜잭션) 상태를 바꾸도록 고치고, 순서가 뒤바뀌는 경우의 테스트를 추가해 줘.', 'In orders/webhook.ts the payment-completed event can arrive before the order is saved and the status gets overwritten. Lock the order in a transaction before updating the status, and add a test for the out-of-order case.') });
store.addSummary({ team_id: pay.id, stage: '기획', body: L('원인: 결제 웹훅이 주문 저장보다 먼저 도착하면 상태가 「대기」로 되돌아감', 'Cause: when the payment webhook arrives before the order is saved, the status falls back to "Pending"') });

// 2) 사람 확인을 기다리는 팀
const csv = team(L('관리자 주문 CSV 내보내기에 배송지 열 추가', 'Add shipping address to the admin order CSV export'), shop.id, 'tpl-dev', L('관리자 화면의 주문 CSV 에 배송지(우편번호·주소)를 넣어라.', 'Add the shipping address (postcode and address) to the admin order CSV.'));
store.setChecklist(csv.id, L(['CSV 열 정의 확인', '배송지 열 추가', '개인정보 마스킹 정책 확인'], ['Check CSV column definitions', 'Add shipping columns', 'Confirm the PII masking policy']));
store.checkItem(csv.id, 0, true); store.checkItem(csv.id, 1, true);
store.updateTeam(csv.id, { state: 'waiting_human', stage: 2, cost_usd: 0.31, started_at: ago(48), question: JSON.stringify({ ...L({ text: '배송지 주소를 CSV 에 그대로 넣을까요, 아니면 상세 주소는 가릴까요?', options: ['그대로 넣기', '상세 주소 가리기'] }, { text: 'Should the CSV include the full shipping address, or mask the street details?', options: ['Full address', 'Mask street details'] }), asked_at: ago(6) }) });
store.addMessage({ team_id: csv.id, from_label: 'PM', to_label: '사용자', kind: 'question', body: L('배송지 주소를 CSV 에 그대로 넣을까요, 아니면 상세 주소는 가릴까요?\n선택지: 그대로 넣기 / 상세 주소 가리기', 'Should the CSV include the full shipping address, or mask the street details?\nOptions: Full address / Mask street details') });

// 3) 끝난 팀
const done = team(L('상품 목록 API 응답 속도 개선(N+1 쿼리)', 'Speed up the product list API (N+1 queries)'), api.id, 'tpl-dev', L('상품 목록 API 가 느리다. 쿼리를 확인하고 개선해라.', 'The product list API is slow. Check the queries and improve it.'));
store.setChecklist(done.id, L(['느린 쿼리 찾기', '카테고리 조인을 한 번에', '측정 전후 비교'], ['Find slow queries', 'Load categories in one join', 'Compare before/after']));
for (const i of [0, 1, 2]) store.checkItem(done.id, i, true);
store.updateTeam(done.id, { state: 'done', stage: 4, cost_usd: 1.12, started_at: ago(180), finished_at: ago(140) });
const doneReport = L('**결론: 상품 목록 API 가 평균 820ms → 95ms 로 빨라졌습니다.**\n\n- 원인: 상품마다 카테고리를 따로 읽는 N+1 쿼리(`products/list.ts:41`)\n- 수정: 카테고리를 한 번에 읽어 붙이도록 바꾸고 인덱스 추가\n- 테스트 12개 추가, 전체 통과', '**Conclusion: the product list API went from 820 ms to 95 ms on average.**\n\n- Cause: an N+1 query loading each product\'s category separately (`products/list.ts:41`)\n- Fix: load categories in one join and add an index\n- Added 12 tests, all passing');
store.addMessage({ team_id: done.id, from_label: 'PM', to_label: 'PO', kind: 'report', body: doneReport });
store.addSummary({ team_id: done.id, stage: '최종', body: doneReport });

// 4) 직속 팀(상시 대기)
const ops = orch.createStanding({ ...(EN ? { roles: store.getTemplate('tpl-ops')!.roles.map((r) => ({ ...r, name: r.key === 'pm' ? 'PM' : 'Inspector' })) } : {}), name: L('운영 점검팀', 'Ops on-call'), project_id: api.id, template_id: 'tpl-ops', brief: L('서버 오류·느려짐을 점검하고 원인을 보고한다. 운영 DB·배포 명령은 사람 승인을 받는다.', 'Investigate server errors and slowdowns and report the cause. Production DB and deploy commands need human approval.') });
store.addMessage({ team_id: ops.id, from_label: '사용자', to_label: 'PM', kind: 'instruction', body: L('어젯밤 11시쯤 주문 API 오류가 늘었는데 원인 좀 봐 줘', 'Order API errors spiked around 11pm last night, can you check why?') });
store.addMessage({ team_id: ops.id, from_label: 'PM', to_label: '사용자', kind: 'report', body: L('**결론: 23:02~23:09 사이 결제사 응답 지연(타임아웃 5초)으로 주문 API 오류가 늘었습니다. 우리 코드 문제는 아닙니다.**\n\n- 근거: 로그에 결제사 호출 타임아웃 214건, 그 외 오류 없음\n- 제안: 결제사 호출만 타임아웃 10초 + 재시도 1회\n- 확인할 점: 재시도를 넣을지 정해 주세요', '**Conclusion: from 23:02 to 23:09 the payment provider was slow (5 s timeouts), which caused the order API errors. Our code was not at fault.**\n\n- Evidence: 214 payment-provider timeouts in the logs, no other errors\n- Suggestion: raise the timeout to 10 s for payment calls only, plus one retry\n- Your call: should we add the retry?') });

// 총괄 대화
store.addChat({ role: 'user', body: L('결제 끝났는데 주문이 계속 「결제 대기」로 보인다는 문의가 왔어. 고쳐 줘', 'Customers say paid orders still show "Awaiting payment". Please fix it') });
store.addChat({ role: 'po', body: L(`**결론: 「큰 기능 팀」(PM · 개발 · QA)을 꾸려 맡겼습니다. 결제 웹훅과 주문 저장 순서 문제로 보입니다.**\n\n- 프로젝트: shop-web · 예산 $5\n- 할 일: 재현 → 원인 → 수정·회귀 테스트 → 검사 → 보고\n- 진행은 「결제 완료 후 주문 상태가 「대기」로 남는 버그 수정」 채널에서 볼 수 있습니다`, `**Conclusion: I set up a "Large feature team" (PM · Developer · QA) for this. It looks like an ordering problem between the payment webhook and saving the order.**\n\n- Project: shop-web · budget $5\n- Plan: reproduce → cause → fix + regression test → check → report\n- Follow along in the ${pay.id} channel`), team_id: pay.id });
store.addChat({ role: 'user', body: L('지금 팀들 상황 정리해 줘', 'Give me a status update on all teams') });
store.addChat({ role: 'po', body: L(`**결론: 3개 팀 중 1개는 일하는 중, 1개는 답을 기다리고, 1개는 끝났습니다.**\n\n| 팀 | 상태 | 할 일 |\n|---|---|---|\n| ${pay.id} | 구현 중 | 2/5 |\n| ${csv.id} | 사람 확인 필요 | 2/3 |\n| ${done.id} | 완료 | 3/3 |\n\n- CSV 팀이 「상세 주소를 가릴지」 묻고 있습니다. 답해 주시면 바로 이어 갑니다.`, `**Conclusion: of 3 teams, 1 is working, 1 is waiting for your answer and 1 is done.**\n\n| Team | Status | Tasks |\n|---|---|---|\n| ${pay.id} | Building | 2/5 |\n| ${csv.id} | Needs you | 2/3 |\n| ${done.id} | Done | 3/3 |\n\n- The CSV team is asking whether to mask street details. Answer and it continues right away.`) });

console.log(JSON.stringify({ pay: pay.id, csv: csv.id, done: done.id, ops: ops.id }));
