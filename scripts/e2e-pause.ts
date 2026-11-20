/**
 * 실제 Claude 로 멈춤·재개 점검: 일하는 도중 부드러운 멈춤 → paused, 프로세스 종료 확인 → 재개 → 완료.
 * 실행: npx tsx scripts/e2e-pause.ts
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
import { sleep } from '../server/util.ts';
import type { TemplateRole } from '../shared/types.ts';

const home = mkdtempSync(join(tmpdir(), 'hl-e2e-pause-'));
const cfg = loadConfig({ HIVELANE_HOME: home } as NodeJS.ProcessEnv);
ensureDirs(cfg);
initLog(cfg.logsDir, { quiet: true });
const store = new Store(openDb(cfg.dbPath));
seedTemplates(store);
const repo = mkdtempSync(join(tmpdir(), 'hl-e2e-pause-repo-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(repo, `${n}.txt`), `${n}\n`);
g('add', '.'); g('commit', '-q', '-m', 'init');
const project = store.insertProject({ name: 'files', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: DEFAULT_HEAVY, blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: null });
const roles: TemplateRole[] = [{ key: 'pm', name: 'PM', model: 'haiku', mode: 'session', tools: 'pm' }, { key: 'dev', name: '개발', model: 'haiku', mode: 'subagent', tools: 'write' }];
const prop = store.insertProposal({ project_id: project.id, title: '파일 4개 대문자로', instruction: 'x', template_id: null, roles, priority: 'normal', budget_usd: 2, note: '',
  brief: 'a.txt, b.txt, c.txt, d.txt 네 파일의 내용을 각각 대문자로 바꿔라. 개발에게 파일마다 따로 맡기고(4번), 맡길 때마다 개발은 먼저 `sleep 4` 를 실행한 뒤 수정한다. 다 되면 report.' });
const slots = new HeavySlots(2);
const orch = new Orchestrator({ cfg, store, runner: new AgentRunner({ store, slots }), slots, notifier: new NullNotifier() });
const team = orch.createFromProposal(prop.id);
const t0 = Date.now();
const s = () => `${Math.round((Date.now() - t0) / 1000)}s`;
void orch.start(team.id);
while (store.checklist(team.id).length === 0 || !orch.rootPids(team.id).length) await sleep(300);
await sleep(6000);
const pidsBefore = orch.rootPids(team.id);
console.log(`${s()} 멈춤 요청 (실행 중 pid ${pidsBefore.join(',')})`);
await orch.pause(team.id, 'user', '점검: 사용자 멈춤');
const tPause = Date.now();
while (orch.isRunning(team.id)) await sleep(200);
const alive = pidsBefore.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
const st = store.getTeam(team.id)!;
console.log(`${s()} 상태 ${st.state} (${st.pause_kind}) · 멈추는 데 ${Date.now() - tPause}ms · 남은 프로세스 ${alive.length}개 · 할 일 ${store.checklist(team.id).filter((c) => c.done).length}/${store.checklist(team.id).length}`);
const filesAtPause = execFileSync('cat', ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => join(st.worktree_path!, f))).toString().replace(/\n/g, ' ');
console.log(`   멈춘 순간 파일: ${filesAtPause}`);
await sleep(3000);
console.log(`${s()} 재개`);
await orch.resume(team.id, 'user', '점검: 재개');
await orch.idle();
const end = store.getTeam(team.id)!;
console.log(`${s()} 최종 ${end.state} · $${end.cost_usd.toFixed(3)} · 파일: ${execFileSync('cat', ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => join(end.worktree_path!, f))).toString().replace(/\n/g, ' ')}`);
console.log('결정 기록:', store.teamDetail(team.id)!.decisions.map((d) => `${d.actor}:${d.action}`).reverse().join(' → '));
process.exit(st.state === 'paused' && end.state === 'done' && alive.length === 0 ? 0 : 1);
