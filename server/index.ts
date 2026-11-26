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
import { AccountManager } from './accounts.ts';
import { GitCleanWatcher } from './projects/cleanwatch.ts';
import { OllamaManager } from './search/ollama.ts';
import { bus } from './bus.ts';
import { Engine, realSampler } from './po/engine.ts';
import { PoAgent } from './po/agent.ts';
import { HeavySlots } from './po/slots.ts';
import { Search } from './search/index.ts';
import { seedTemplates, Store } from './store.ts';
import { Orchestrator } from './teams/orchestrator.ts';
import { createApp } from './http/app.ts';
import { applyPendingRestore, BackupManager } from './backup/index.ts';

const cfg = loadConfig();
ensureDirs(cfg);
initLog(cfg.logsDir);
const log = logger('main');
// 복구를 골랐으면 DB 를 열기 전에 풀어 둔 백업으로 바꿔 끼운다
try { const r = applyPendingRestore(cfg); if (r) log.warn(`백업으로 복구함: ${r}`); } catch (e) { log.error('백업 복구 실패(지금 DB 그대로 씀)', e); }

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
const accounts = new AccountManager({ cfg, store, defaultUsage: usage, defaultLogin: auth, onChange: () => bus.emitEvent({ type: 'state', reason: 'accounts' }), notify: (title, body) => void notifier.send({ title, body, level: 'warn', url: '/#settings/accounts', tag: 'acct-switch' }) });
// 기본 계정 말고 추가한 계정들도 5분마다 사용량을 읽는다
const accountsTimer = setInterval(() => { for (const a of accounts.list()) if (a.id !== 'default') void accounts.usage(a.id).refresh(); }, 300_000);
accountsTimer.unref();
setTimeout(() => { for (const a of accounts.list()) if (a.id !== 'default') void accounts.usage(a.id).refresh(); }, 15_000).unref();
const runner = new AgentRunner({ store, slots, onRateLimit: () => usage.poke() });
const orch = new Orchestrator({ cfg, store, runner, slots, notifier, accounts });
const search = new Search(store);
const engine = new Engine({ store, orch, slots, sampler: realSampler(), notifier });
const gitClean = new GitCleanWatcher({ cfg, store, orch, onChange: () => bus.emitEvent({ type: 'state', reason: 'git-clean' }) });
const po = new PoAgent({ cfg, store, runner, orch, search, notifier, onGitCleaned: () => void gitClean.refresh(), accounts });

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
const ollama = new OllamaManager({ store, logsDir: cfg.logsDir, onChange: () => {} });
void ollama.ensure(); // 검색 방식이 Ollama 면 Hivelane 과 함께 켠다
try { const n = store.backfillChatIndex(); if (n) log.info(`총괄 대화 ${n}줄 검색 색인`); } catch (e) { log.warn('총괄 대화 색인 실패', e); }
// 빠진 벡터 채우기: 부팅 1분 뒤, 그다음 10분마다(빠진 것만이라 가볍다)
setTimeout(() => void search.fillMissing(), 60_000).unref();
const fillTimer = setInterval(() => void search.fillMissing(), 600_000);
fillTimer.unref();
setTimeout(() => void gitClean.refresh(), 20_000).unref();
const gitCleanTimer = setInterval(() => void gitClean.refresh(), 600_000);
gitCleanTimer.unref();
// 백업: launchd 서비스로 돌 때만 복구 후 스스로 내려가 다시 뜬다(KeepAlive)
const underLaunchd = (process.env.XPC_SERVICE_NAME ?? '').includes('com.webjihong.hivelane');
const backups = new BackupManager({
  cfg, store, onChange: () => bus.emitEvent({ type: 'state', reason: 'backup' }),
  notify: (title, body, ok) => void notifier.send({ title, body, level: ok ? 'good' : 'warn', url: '/#settings/backup', tag: 'backup' }),
  exit: underLaunchd ? () => void shutdown('restore') : undefined,
});
backups.start();
const app = createApp({ cfg, store, orch, engine, po, search, notifier, prs, repos, scripts, usage, auth, gitClean, ollama, accounts, backups });
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
  ollama.stop();
  backups.stop();
  caffeinate?.kill();
  server.close();
  remoteServer.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('처리되지 않은 Promise 거부', e));
process.on('uncaughtException', (e) => log.error('처리되지 않은 예외', e));
