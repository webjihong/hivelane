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
import { NullNotifier } from '../server/notify/index.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { seedTemplates, Store } from '../server/store.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';

const cfg = loadConfig();
ensureDirs(cfg);
const store = new Store(openDb(cfg.dbPath));
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
  return orch.createFromProposal(p.id);
};

// 1) 일하는 중인 팀: 결제 버그
const pay = team('결제 완료 후 주문 상태가 「대기」로 남는 버그 수정', shop.id, 'tpl-big', '결제가 끝났는데 주문 목록에 「결제 대기」로 보인다. 원인을 찾아 고치고 테스트를 추가해라.');
store.setChecklist(pay.id, ['재현: 결제 완료 웹훅 → 주문 상태 확인', '원인: 웹훅 처리 순서(결제 → 주문) 경합', '수정 + 회귀 테스트', '타입 검사·테스트 통과 확인', '보고']);
store.checkItem(pay.id, 0, true); store.checkItem(pay.id, 1, true);
// 서버를 띄웠을 때 엔진이 실제로 돌리지 않게 「사용자 멈춤」으로 둔다(찍기 직전에 readme-shots 가 「일하는 중」 표시로 바꿈)
store.updateTeam(pay.id, { state: 'paused', pause_kind: 'user', paused_reason: '데모', stage: 1, cost_usd: 0.84, started_at: ago(23) });
store.addMessage({ team_id: pay.id, from_label: 'PM', to_label: '개발', kind: 'handoff', body: 'orders/webhook.ts 에서 결제 완료 이벤트가 주문 생성보다 먼저 오면 상태가 덮어써진다. 주문을 먼저 잠그고(트랜잭션) 상태를 바꾸도록 고치고, 순서가 뒤바뀌는 경우의 테스트를 추가해 줘.' });
store.addSummary({ team_id: pay.id, stage: '기획', body: '원인: 결제 웹훅이 주문 저장보다 먼저 도착하면 상태가 「대기」로 되돌아감' });

// 2) 사람 확인을 기다리는 팀
const csv = team('관리자 주문 CSV 내보내기에 배송지 열 추가', shop.id, 'tpl-dev', '관리자 화면의 주문 CSV 에 배송지(우편번호·주소)를 넣어라.');
store.setChecklist(csv.id, ['CSV 열 정의 확인', '배송지 열 추가', '개인정보 마스킹 정책 확인']);
store.checkItem(csv.id, 0, true); store.checkItem(csv.id, 1, true);
store.updateTeam(csv.id, { state: 'waiting_human', stage: 2, cost_usd: 0.31, started_at: ago(48), question: JSON.stringify({ text: '배송지 주소를 CSV 에 그대로 넣을까요, 아니면 상세 주소는 가릴까요?', options: ['그대로 넣기', '상세 주소 가리기'], asked_at: ago(6) }) });
store.addMessage({ team_id: csv.id, from_label: 'PM', to_label: '사용자', kind: 'question', body: '배송지 주소를 CSV 에 그대로 넣을까요, 아니면 상세 주소는 가릴까요?\n선택지: 그대로 넣기 / 상세 주소 가리기' });

// 3) 끝난 팀
const done = team('상품 목록 API 응답 속도 개선(N+1 쿼리)', api.id, 'tpl-dev', '상품 목록 API 가 느리다. 쿼리를 확인하고 개선해라.');
store.setChecklist(done.id, ['느린 쿼리 찾기', '카테고리 조인을 한 번에', '측정 전후 비교']);
for (const i of [0, 1, 2]) store.checkItem(done.id, i, true);
store.updateTeam(done.id, { state: 'done', stage: 4, cost_usd: 1.12, started_at: ago(180), finished_at: ago(140) });
const doneReport = '**결론: 상품 목록 API 가 평균 820ms → 95ms 로 빨라졌습니다.**\n\n- 원인: 상품마다 카테고리를 따로 읽는 N+1 쿼리(`products/list.ts:41`)\n- 수정: 카테고리를 한 번에 읽어 붙이도록 바꾸고 인덱스 추가\n- 테스트 12개 추가, 전체 통과';
store.addMessage({ team_id: done.id, from_label: 'PM', to_label: 'PO', kind: 'report', body: doneReport });
store.addSummary({ team_id: done.id, stage: '최종', body: doneReport });

// 4) 직속 팀(상시 대기)
const ops = orch.createStanding({ name: '운영 점검팀', project_id: api.id, template_id: 'tpl-ops', brief: '서버 오류·느려짐을 점검하고 원인을 보고한다. 운영 DB·배포 명령은 사람 승인을 받는다.' });
store.addMessage({ team_id: ops.id, from_label: '사용자', to_label: 'PM', kind: 'instruction', body: '어젯밤 11시쯤 주문 API 오류가 늘었는데 원인 좀 봐 줘' });
store.addMessage({ team_id: ops.id, from_label: 'PM', to_label: '사용자', kind: 'report', body: '**결론: 23:02~23:09 사이 결제사 응답 지연(타임아웃 5초)으로 주문 API 오류가 늘었습니다. 우리 코드 문제는 아닙니다.**\n\n- 근거: 로그에 결제사 호출 타임아웃 214건, 그 외 오류 없음\n- 제안: 결제사 호출만 타임아웃 10초 + 재시도 1회\n- 확인할 점: 재시도를 넣을지 정해 주세요' });

// 총괄 대화
store.addChat({ role: 'user', body: '결제 끝났는데 주문이 계속 「결제 대기」로 보인다는 문의가 왔어. 고쳐 줘' });
store.addChat({ role: 'po', body: `**결론: 「큰 기능 팀」(PM · 개발 · QA)을 꾸려 맡겼습니다. 결제 웹훅과 주문 저장 순서 문제로 보입니다.**\n\n- 프로젝트: shop-web · 예산 $5\n- 할 일: 재현 → 원인 → 수정·회귀 테스트 → 검사 → 보고\n- 진행은 「결제 완료 후 주문 상태가 「대기」로 남는 버그 수정」 채널에서 볼 수 있습니다`, team_id: pay.id });
store.addChat({ role: 'user', body: '지금 팀들 상황 정리해 줘' });
store.addChat({ role: 'po', body: `**결론: 3개 팀 중 1개는 일하는 중, 1개는 답을 기다리고, 1개는 끝났습니다.**\n\n| 팀 | 상태 | 할 일 |\n|---|---|---|\n| ${pay.id} | 구현 중 | 2/5 |\n| ${csv.id} | 사람 확인 필요 | 2/3 |\n| ${done.id} | 완료 | 3/3 |\n\n- CSV 팀이 「상세 주소를 가릴지」 묻고 있습니다. 답해 주시면 바로 이어 갑니다.` });

console.log(JSON.stringify({ pay: pay.id, csv: csv.id, done: done.id, ops: ops.id }));
