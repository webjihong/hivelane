/**
 * 실제 Claude(Haiku)로 팀 하나를 끝까지 돌려 보는 점검 스크립트.
 * 연습 저장소(임시 폴더)에서만 일한다. 실행: npx tsx scripts/e2e.ts
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
import { HeavySlots } from '../server/po/slots.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY, seedTemplates, Store } from '../server/store.ts';
import { Orchestrator } from '../server/teams/orchestrator.ts';
import type { TemplateRole } from '../shared/types.ts';

const home = mkdtempSync(join(tmpdir(), 'hl-e2e-'));
const cfg = loadConfig({ HIVELANE_HOME: home } as NodeJS.ProcessEnv);
ensureDirs(cfg);
initLog(cfg.logsDir, { quiet: true });
const store = new Store(openDb(cfg.dbPath));
seedTemplates(store);

const repo = mkdtempSync(join(tmpdir(), 'hl-e2e-repo-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'package.json'), '{"name":"calc","type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n');
writeFileSync(join(repo, 'calc.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add, mul } from './calc.js';\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('mul', () => assert.equal(mul(2, 3), 6));\n");
g('add', '.'); g('commit', '-q', '-m', 'init');

const project = store.insertProject({ name: 'calc', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [...DEFAULT_HEAVY, 'node --test'], blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: 'tpl-dev' });
const roles: TemplateRole[] = [
  { key: 'pm', name: 'PM', model: 'haiku', mode: 'session', tools: 'pm' },
  { key: 'dev', name: '개발', model: 'haiku', mode: process.argv.includes('--session') ? 'session' : 'subagent', tools: 'write' },
  { key: 'qa', name: 'QA', model: 'haiku', mode: 'subagent', tools: 'verify' },
];
const prop = store.insertProposal({
  project_id: project.id, title: 'add 버그 수정', instruction: 'add 가 이상해', template_id: 'tpl-dev', roles, priority: 'normal', budget_usd: 2, note: '',
  brief: 'calc.js 의 add 가 빼기를 한다. 개발에게 고치게 하고, QA 에게 `npm test` 로 검증하게 한 뒤 report 해라. 커밋은 하지 마라.',
});
const slots = new HeavySlots(1);
const orch = new Orchestrator({ cfg, store, runner: new AgentRunner({ store, slots }), slots, notifier: new NullNotifier() });
const team = orch.createFromProposal(prop.id);
const t0 = Date.now();
console.log(`팀 ${team.id} 시작 · 저장소 ${repo}`);
const tick = setInterval(() => {
  const t = store.teamView(store.getTeam(team.id)!);
  console.log(`  ${Math.round((Date.now() - t0) / 1000)}s ${t.state} 단계${t.stage} $${t.cost_usd.toFixed(3)} · ${t.agents.map((a) => `${a.role_name}:${a.state}(${a.current_step.slice(0, 30)})`).join(' | ')}`);
}, 10_000);
await orch.start(team.id);
await orch.idle();
clearInterval(tick);

const d = store.teamDetail(team.id)!;
const a = d.team.agents;
console.log('\n== 결과 ==');
console.log({ state: d.team.state, stage: d.team.stage, cost: d.team.cost_usd.toFixed(3), secs: Math.round((Date.now() - t0) / 1000), branch: d.team.branch });
console.log('할 일:', d.checklist.map((c) => `${c.done ? '✓' : '·'} ${c.text}`));
console.log('파일:', d.files);
console.log('대화:'); for (const m of d.messages) console.log(`  ${m.from_label}→${m.to_label ?? ''} [${m.kind}] ${m.body.slice(0, 120).replace(/\n/g, ' ')}`);
console.log('팀원별 이벤트 수:', Object.fromEntries(a.map((x) => [x.role_name, store.agentDetail(x.id)!.events.length])));
const runs = store.db.prepare('SELECT tool, status, waited_ms, command FROM runs WHERE team_id = ?').all(team.id) as { tool: string; status: string; waited_ms: number; command: string | null }[];
console.log('도구 실행:', runs.map((r) => `${r.tool}:${r.status}${r.waited_ms ? `(대기${r.waited_ms}ms)` : ''}${r.tool === 'Bash' ? ` «${(r.command ?? '').slice(0, 40)}»` : ''}`));
console.log('worktree calc.js:', execFileSync('cat', [join(d.team.worktree_path!, 'calc.js')]).toString().trim());
console.log('main 브랜치 그대로?:', execFileSync('git', ['-C', repo, 'show', 'main:calc.js']).toString().includes('a - b'));
process.exit(d.team.state === 'done' ? 0 : 1);
