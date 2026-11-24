import { spawn, type ChildProcess } from 'node:child_process';
import { serve } from '@hono/node-server';
import { ensureDirs, loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { initLog, logger } from './log.ts';
import { AppNotifier } from './notify/index.ts';
import { PrWatcher } from './projects/prs.ts';
import { RepoWatcher } from './projects/repos.ts';
import { ScriptRunner } from './scripts.ts';
import { AgentRunner } from './agents/runner.ts';
import { PlanUsage } from './po/usage.ts';
import { AuthLogin } from './po/auth.ts';
import { bus } from './bus.ts';
import { Engine, realSampler } from './po/engine.ts';
import { PoAgent } from './po/agent.ts';
import { HeavySlots } from './po/slots.ts';
import { Search } from './search/index.ts';
import { seedTemplates, Store } from './store.ts';
import { Orchestrator } from './teams/orchestrator.ts';
import { createApp } from './http/app.ts';

const cfg = loadConfig();
ensureDirs(cfg);
initLog(cfg.logsDir);
const log = logger('main');

const store = new Store(openDb(cfg.dbPath));
seedTemplates(store);
const notifier = new AppNotifier(store, cfg.home);
store.initSeenBaseline();
const slots = new HeavySlots(store.getSettings().engine.slotsGreen);
const usage = new PlanUsage({ onChange: (u) => bus.emitEvent({ type: 'usage', usage: u }) });
void usage.refresh();
const usageTimer = setInterval(() => void usage.refresh(), 300_000);
usageTimer.unref();
const auth = new AuthLogin({ onDone: () => { void usage.refresh(); bus.emitEvent({ type: 'state', reason: 'auth' }); } });
const runner = new AgentRunner({ store, slots, onRateLimit: () => usage.poke() });
const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
const search = new Search(store);
const engine = new Engine({ store, orch, slots, sampler: realSampler(), notifier });
const po = new PoAgent({ cfg, store, runner, orch, search, notifier });

orch.recover();
engine.start();

const prs = new PrWatcher({ store, notifier });
void prs.refresh();
const prTimer = setInterval(() => void prs.refresh(), 120_000);
prTimer.unref();
const repos = new RepoWatcher({ store });
void repos.refresh(true);
const repoTimer = setInterval(() => void repos.refresh(true), 300_000);
repoTimer.unref();
const scripts = new ScriptRunner(store);
const app = createApp({ cfg, store, orch, engine, po, search, notifier, prs, repos, scripts, usage, auth });
const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  log.info(`Hivelane 관제실 http://${cfg.host}:${info.port} · 데이터 ${cfg.home}`);
});
// tailscale serve 전용 리스너: 여기로 들어온 요청은 항상 원격(주인 계정 확인 + 원격 제한)
const remoteServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: cfg.remotePort }, (info) => {
  log.info(`원격(tailscale serve) 리스너 127.0.0.1:${info.port}`);
});

// 맥이 잠들면 팀이 멈춘다: 서버가 살아 있는 동안 잠자기 방지(전원 연결 시)
let caffeinate: ChildProcess | null = null;
if (process.platform === 'darwin' && !process.env.HIVELANE_NO_CAFFEINATE) {
  caffeinate = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
  caffeinate.on('error', (e) => log.warn('caffeinate 실행 실패', e));
}

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  log.info(`${sig} 받음 · 종료`);
  engine.stop();
  caffeinate?.kill();
  server.close();
  remoteServer.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('처리되지 않은 Promise 거부', e));
process.on('uncaughtException', (e) => log.error('처리되지 않은 예외', e));
