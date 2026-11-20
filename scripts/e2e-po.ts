/**
 * PO 에이전트 실제 점검(Haiku): 지시 → 팀 제안 → 승인 → 팀 완료 → 작업 질문에 기록으로 답하기.
 * 실행: npx tsx scripts/e2e-po.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDirs, loadConfig } from '../server/config.ts';
import { openDb } from '../server/db/index.ts';
import { initLog } from '../server/log.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { AgentRunner } from '../server/agents/runner.ts';
import { PoAgent } from '../server/po/agent.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY, seedTemplates, Store } from '../server/store.ts';
import { Orchestrator } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';

const home = mkdtempSync(join(tmpdir(), 'hl-e2e-po-'));
const cfg = loadConfig({ HIVELANE_HOME: home } as NodeJS.ProcessEnv);
ensureDirs(cfg);
initLog(cfg.logsDir, { quiet: true });
const store = new Store(openDb(cfg.dbPath));
seedTemplates(store);
store.saveSettings({ poModel: 'haiku' });

const repo = mkdtempSync(join(tmpdir(), 'hl-e2e-po-repo-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'package.json'), '{"name":"greet","type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(repo, 'greet.js'), "export const greet = (name) => 'Hello ' + name;\n");
writeFileSync(join(repo, 'greet.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { greet } from './greet.js';\ntest('greet', () => assert.equal(greet('Kim'), 'Hello Kim'));\n");
g('add', '.'); g('commit', '-q', '-m', 'init');
store.insertProject({ name: 'greet', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: DEFAULT_HEAVY, blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: 'tpl-dev' });
// 비용을 줄이려고 기본 개발팀 템플릿을 Haiku 로
const tpl = store.getTemplate('tpl-dev')!;
store.upsertTemplate({ ...tpl, roles: tpl.roles.map((r) => ({ ...r, model: 'haiku' })) });

const slots = new HeavySlots(2);
const runner = new AgentRunner({ store, slots });
const notifier = new NullNotifier();
const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
const po = new PoAgent({ cfg, store, runner, orch, search: new Search(store), notifier });
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const waitPo = async () => { await sleep(500); while (po.busy) await sleep(300); await sleep(500); while (po.busy) await sleep(300); };

console.log('1) 사용자 → PO: 지시');
po.say('greet 프로젝트에서 greet 함수가 이름 뒤에 느낌표(!)를 붙이도록 바꿔줘. 테스트도 맞춰서 고쳐야 해.');
await waitPo();
const props = store.listProposals('pending');
console.log(`   ${secs()}s 제안 ${props.length}개`, props.map((p) => ({ title: p.title, project: p.project_name, template: p.template_name, roles: p.roles.map((r) => `${r.key}/${r.model}/${r.mode}`), brief: p.brief.slice(0, 160) })));
console.log('   PO:', store.chat().filter((c) => c.role === 'po').map((c) => c.body.slice(0, 200)));
if (!props.length) { console.log('제안이 없어 실패'); process.exit(1); }

console.log('2) 사용자 승인 → 팀 실행');
const team = orch.createFromProposal(props[0]!.id);
await orch.start(team.id);
await orch.idle();
const t = store.teamView(store.getTeam(team.id)!);
console.log(`   ${secs()}s 팀 ${t.state} · $${t.cost_usd.toFixed(3)} · 파일 ${store.teamFiles(team.id).map((f) => f.path).join(', ')}`);
console.log('   worktree greet.js:', execFileSync('cat', [join(t.worktree_path!, 'greet.js')]).toString().trim());
await waitPo(); // report 사건으로 PO 가 깨어남

console.log('3) 사용자 → PO: 작업 질문');
po.say('방금 끝난 팀이 어떤 파일을 어떻게 바꿨는지, 검증은 어떻게 됐는지 알려줘.');
await waitPo();
const chat = store.chat();
for (const c of chat) console.log(`   [${c.role}] ${c.body.slice(0, 300).replace(/\n/g, ' ')}${c.proposal_id ? ' (제안 카드)' : ''}`);
const poAgent = store.poAgent()!;
const runs = store.db.prepare('SELECT tool FROM runs WHERE agent_id = ?').all(poAgent.id) as { tool: string }[];
console.log('   PO 도구 사용:', [...new Set(runs.map((r) => r.tool))]);
console.log(`총 ${secs()}s · PO 비용 $${poAgent.cost_usd.toFixed(3)} · 팀 $${t.cost_usd.toFixed(3)}`);
const answered = chat.at(-1)?.role === 'po' && /greet/.test(chat.at(-1)!.body);
process.exit(t.state === 'done' && answered ? 0 : 1);
