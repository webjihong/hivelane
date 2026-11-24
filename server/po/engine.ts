import { cpus } from 'node:os';
import { bus, type ResourceSnapshot } from '../bus.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import type { Orchestrator } from '../teams/orchestrator.ts';
import { nowIso, runShell, truncate } from '../util.ts';
import { decide, slotsFor, ZoneTracker, type PolicyTeam } from './policy.ts';
import { CpuMeter, descendants, listProcs, load1, memPercent, signalTree, sumUsage, type Proc } from './resources.ts';
import type { HeavySlots } from './slots.ts';
import type { Notifier } from '../notify/index.ts';
import type { Zone } from '../../shared/types.ts';

const log = logger('engine');

export interface Sampler { cpu(): number; mem(): Promise<number>; procs(): Promise<Proc[]> }
export const realSampler = (): Sampler => { const m = new CpuMeter(); return { cpu: () => m.sample(), mem: memPercent, procs: listProcs }; };

/** 총괄 엔진: LLM 없이 규칙으로 리소스를 지킨다. */
export class Engine {
  private zones = new ZoneTracker();
  private lastPauseAt = 0;
  private lastHoldNote = 0;
  private lastResumeAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stalled = new Set<string>();
  private checking = new Set<string>();
  private lastSamplePersist = 0;
  private lastPrune = 0;
  last: ResourceSnapshot = { cpu: 0, mem: 0, zone: 'green', heavyRunning: 0, heavyWaiting: 0, takenAt: nowIso() };

  constructor(private deps: { store: Store; orch: Orchestrator; slots: HeavySlots; sampler: Sampler; intervalMs?: number; notifier?: Notifier }) {
    deps.slots.onChange = () => { const s = deps.slots.stats; this.last = { ...this.last, heavyRunning: s.running, heavyWaiting: s.waiting }; bus.emitEvent({ type: 'resource', sample: this.last }); };
  }

  start(): void {
    if (this.timer) return;
    const every = this.deps.intervalMs ?? 5000;
    this.timer = setInterval(() => void this.tick(), every);
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.tickInner(now); } catch (e) { log.error('엔진 틱 실패', e); } finally { this.ticking = false; }
  }

  private async tickInner(now: number): Promise<void> {
    const { store, orch, slots, sampler } = this.deps;
    const s = store.getSettings().engine;
    const cpu = sampler.cpu();
    const [mem, procs] = await Promise.all([sampler.mem(), sampler.procs()]);
    const z = this.zones.update(cpu, mem, s, now);
    slots.setCapacity(slotsFor(z.zone, s));

    const teams = store.listTeams("state IN ('queued','running','paused','waiting_human','idle','down','reviving')");
    const perTeam: Record<string, { cpu: number; rss: number }> = {};
    const policyTeams: PolicyTeam[] = teams.map((t) => {
      const u = sumUsage(descendants(procs, orch.rootPids(t.id)));
      perTeam[t.id] = { cpu: Math.round(u.cpu), rss: Math.round(u.rss) };
      return {
        id: t.id, state: t.state, standing: t.lifetime === 'standing', priority: t.priority, pinned: !!t.pinned || orch.inGrace(t.id, now), pauseKind: t.pause_kind,
        pausePending: orch.isPausePending(t.id) && orch.isRunning(t.id), cpu: u.cpu, rss: u.rss, createdAt: Date.parse(t.created_at),
      };
    });

    const actions = decide({ s, zone: z.zone, redFor: z.redFor, greenFor: z.greenFor, mem, cpu, now, lastPauseAt: this.lastPauseAt, lastResumeAt: this.lastResumeAt, teams: policyTeams,
      // 도는 팀의 프로세스를 잴 수 있을 때만 외부 부하를 판단한다
      cores: (() => { const run = teams.filter((t) => t.state === 'running' && t.lifetime === 'task'); return !run.length || run.some((t) => orch.rootPids(t.id).length) ? cpus().length : undefined; })() });
    for (const a of actions) {
      if (a.type === 'hold') {
        if (now - this.lastHoldNote >= 600_000) {
          this.lastHoldNote = now;
          log.info('외부 부하 · 팀 유지', a.reason);
          for (const t of teams.filter((x) => x.state === 'running' && x.lifetime === 'task')) store.addDecision(t.id, 'engine', 'hold', a.reason);
        }
        continue;
      }
      const team = store.getTeam(a.teamId);
      if (!team) continue;
      if (a.type === 'start') { log.info(`시작 ${team.name}`, a.reason); store.addDecision(team.id, 'engine', 'start', a.reason); void orch.start(team.id); }
      else if (a.type === 'pause') { this.lastPauseAt = now; await orch.pause(team.id, 'engine-soft', a.reason); }
      else if (a.type === 'resume') {
        this.lastResumeAt = now;
        if (orch.isHardPaused(team.id)) { signalTree(descendants(procs, orch.rootPids(team.id)), 'SIGCONT'); orch.markHardPaused(team.id, false, '강한 멈춤 해제'); }
        await orch.resume(team.id, 'engine', a.reason);
      } else if (a.type === 'hardPause' && !orch.isHardPaused(team.id)) {
        const n = signalTree(descendants(procs, orch.rootPids(team.id)), 'SIGSTOP');
        orch.markHardPaused(team.id, true, `${a.reason} · 프로세스 ${n}개 정지`);
      }
    }
    // 강한 멈춤 상태인데 멈춤 요청이 풀린 팀(사용자 재개 등)은 깨운다
    for (const t of teams) if (orch.isHardPaused(t.id) && !orch.isPausePending(t.id)) { signalTree(descendants(procs, orch.rootPids(t.id)), 'SIGCONT'); orch.markHardPaused(t.id, false, '재개'); }

    this.watchStalls(teams, s.stallMin, now);
    this.heartbeat(teams, s.beatSec, now);
    this.retryDown(teams, now);
    this.runChecks(teams, now);
    this.remindUnread(now);

    const st = slots.stats;
    this.last = { cpu: Math.round(cpu), mem: Math.round(mem), zone: z.zone, heavyRunning: st.running, heavyWaiting: st.waiting, takenAt: nowIso() };
    bus.emitEvent({ type: 'resource', sample: this.last });
    if (now - this.lastSamplePersist >= 60_000) {
      this.lastSamplePersist = now;
      store.addSample({ cpu, mem, load: load1(), zone: z.zone, perTeam });
      store.pruneSamples();
    }
    if (now - this.lastPrune >= 3_600_000) {
      this.lastPrune = now;
      const r = store.prune();
      if (r.events + r.runs + r.poEvents) log.info('오래된 기록 정리', r);
    }
    if (actions.length) bus.changed('engine');
  }

  get zone(): Zone { return this.last.zone; }

  private watchStalls(teams: ReturnType<Store['listTeams']>, stallMin: number, now: number): void {
    for (const t of teams) {
      if (t.state !== 'running' || t.lifetime === 'standing') { this.stalled.delete(t.id); continue; }
      const last = Date.parse(t.last_activity_at ?? t.started_at ?? t.created_at);
      if (now - last > stallMin * 60_000) {
        if (!this.stalled.has(t.id)) {
          this.stalled.add(t.id);
          this.deps.store.addPoEvent('stall', t.id, { minutes: Math.round((now - last) / 60_000) });
          this.deps.store.addDecision(t.id, 'engine', 'stall', `${Math.round((now - last) / 60_000)}분 동안 진행 없음`);
        }
      } else this.stalled.delete(t.id);
    }
  }

  /** 장애(down)로 멈춘 직속 팀 자동 복구 시도 간격: 2·5·15분, 이후 30분마다 계속. 직속 팀은 사람이 끝낼 때까지 유지된다. */
  private downRetry = new Map<string, { attempts: number; next: number }>();
  static readonly DOWN_BACKOFF_MS = [120_000, 300_000, 900_000, 1_800_000];

  private retryDown(teams: ReturnType<Store['listTeams']>, now: number): void {
    const down = new Set<string>();
    for (const t of teams) {
      if (t.lifetime !== 'standing' || t.state !== 'down') continue;
      down.add(t.id);
      const r = this.downRetry.get(t.id) ?? { attempts: 0, next: now + Engine.DOWN_BACKOFF_MS[0]! };
      if (!this.downRetry.has(t.id)) { this.downRetry.set(t.id, r); continue; }
      if (now < r.next || this.deps.orch.isRunning(t.id)) continue;
      r.attempts++;
      r.next = now + Engine.DOWN_BACKOFF_MS[Math.min(r.attempts, Engine.DOWN_BACKOFF_MS.length - 1)]!;
      this.deps.store.addDecision(t.id, 'engine', 'revive', `장애 상태 자동 복구 시도 ${r.attempts}회째`);
      this.deps.orch.wake(t.id, '장애로 멈췄다가 자동으로 다시 시작되었다. 하던 일이 있으면 이어서 진행하고, 없으면 짧게 대기 상태라고 답해라.');
    }
    for (const id of [...this.downRetry.keys()]) if (!down.has(id)) this.downRetry.delete(id);
  }

  /** 안 본 답변이 남아 있으면 remindUnreadMin 마다 다시 알린다(처음 알림 뒤 그 간격이 지나야 첫 재알림). */
  private remindUnread(now: number): void {
    const min = this.deps.store.getSettings().remindUnreadMin;
    if (!min) return;
    const last = this.deps.store.getKv<number>('remind:last', 0);
    if (now - last < min * 60_000) return;
    const due = this.deps.store.unreadDigest().items.filter((i) => now - Date.parse(i.oldest) >= min * 60_000);
    if (!due.length) return;
    this.deps.store.setKv('remind:last', now);
    const total = due.reduce((a, i) => a + i.count, 0);
    const first = due[0]!;
    void this.deps.notifier?.send({
      title: `읽지 않은 답변 ${total}건`,
      body: due.slice(0, 5).map((i) => `· ${i.name} ${i.count}건`).join('\n') + (due.length > 5 ? `\n· 외 ${due.length - 5}곳` : ''),
      level: 'warn', tag: 'unread-remind', url: first.kind === 'po' ? '/#po' : `/#team-${first.id}`,
    });
  }

  private heartbeat(teams: ReturnType<Store['listTeams']>, beatSec: number, now: number): void {
    for (const t of teams) {
      if (t.lifetime !== 'standing' || t.state === 'down') continue;
      const last = t.last_heartbeat_at ? Date.parse(t.last_heartbeat_at) : 0;
      // 대기 중 직속 팀은 서버가 살아 있으면 살아 있다. 실행 중이면 최근 활동이 있어야 한다.
      const alive = t.state !== 'running' || this.deps.orch.isRunning(t.id);
      if (alive && now - last >= beatSec * 1000) this.deps.store.db.prepare('UPDATE teams SET last_heartbeat_at = ? WHERE id = ?').run(nowIso(), t.id);
      if (!alive) {
        this.deps.store.addDecision(t.id, 'engine', 'heartbeat', '실행 중인데 루프가 없음 → 다시 깨움');
        this.deps.orch.wake(t.id, '연결이 끊겼다가 다시 이어졌다. 하던 일이 있으면 이어서 진행해라.');
      }
    }
  }

  private runChecks(teams: ReturnType<Store['listTeams']>, now: number): void {
    for (const t of teams) {
      if (t.lifetime !== 'standing' || !t.check_command || !t.check_interval_sec || this.checking.has(t.id)) continue;
      const last = t.last_check_at ? Date.parse(t.last_check_at) : 0;
      if (now - last < t.check_interval_sec * 1000) continue;
      this.checking.add(t.id);
      const cwd = t.worktree_path ?? this.deps.store.getProject(t.project_id)?.path ?? undefined;
      void runShell(t.check_command, { cwd, timeoutMs: 60_000 }).then((r) => {
        const ok = r.code === 0;
        this.deps.store.updateTeam(t.id, { last_check_at: nowIso(), last_check_ok: ok ? 1 : 0 });
        const out = truncate((r.stdout + '\n' + r.stderr).trim(), 3000);
        if (!ok) {
          this.deps.store.addMessage({ team_id: t.id, from_label: 'PO 엔진', kind: 'engine', body: `점검 이상(종료 코드 ${r.code})\n${out}` });
          this.deps.store.addDecision(t.id, 'engine', 'check', `점검 실패(코드 ${r.code}) → 팀 깨움`);
          // 같은 이상으로 계속 깨우지 않도록 직전 결과가 실패면 알림만
          if (t.last_check_ok !== 0) this.deps.orch.wake(t.id, `[점검 이상] 명령: ${t.check_command}\n종료 코드: ${r.code}\n출력:\n${out}\n\n원인을 확인하고 보고해라. 고쳐야 하면 무엇을 할지 ask_human 으로 물어라.`);
        } else if (t.last_check_ok === 0) {
          this.deps.store.addMessage({ team_id: t.id, from_label: 'PO 엔진', kind: 'engine', body: '점검 정상으로 돌아옴' });
        }
      }).finally(() => this.checking.delete(t.id));
    }
  }
}
