import { spawn, type ChildProcess } from 'node:child_process';
import { serve } from '@hono/node-server';
import { ensureDirs, loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { initLog, logger } from './log.ts';
import { AppNotifier } from './notify/index.ts';
import { AgentRunner } from './agents/runner.ts';
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
const slots = new HeavySlots(store.getSettings().engine.slotsGreen);
const runner = new AgentRunner({ store, slots });
const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
const search = new Search(store);
const engine = new Engine({ store, orch, slots, sampler: realSampler() });
const po = new PoAgent({ cfg, store, runner, orch, search, notifier });

orch.recover();
engine.start();

const app = createApp({ cfg, store, orch, engine, po, search, notifier });
const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  log.info(`Hivelane 관제실 http://${cfg.host}:${info.port} · 데이터 ${cfg.home}`);
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
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('처리되지 않은 Promise 거부', e));
process.on('uncaughtException', (e) => log.error('처리되지 않은 예외', e));
