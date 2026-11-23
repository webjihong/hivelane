import type { EngineSettings, Priority, Zone } from '../../shared/types.ts';

/** 구간 판정: 원시 구간이 sustainSec 동안 이어져야 올라간다. 내려갈 때는 바로. */
export class ZoneTracker {
  private yellowSince: number | null = null;
  private redSince: number | null = null;
  private greenSince: number | null = null;

  raw(cpu: number, mem: number, s: EngineSettings): Zone {
    if (cpu > s.cpuR || mem > s.memR) return 'red';
    if (cpu >= s.cpuY || mem >= s.memY) return 'yellow';
    return 'green';
  }

  update(cpu: number, mem: number, s: EngineSettings, now: number): { zone: Zone; raw: Zone; redFor: number; greenFor: number } {
    const raw = this.raw(cpu, mem, s);
    if (raw === 'red') { this.redSince ??= now; this.yellowSince ??= now; this.greenSince = null; }
    else if (raw === 'yellow') { this.redSince = null; this.yellowSince ??= now; this.greenSince = null; }
    else { this.redSince = null; this.yellowSince = null; this.greenSince ??= now; }
    const sustain = s.sustainSec * 1000;
    const zone: Zone = this.redSince !== null && now - this.redSince >= sustain ? 'red'
      : this.yellowSince !== null && now - this.yellowSince >= sustain ? 'yellow' : 'green';
    return { zone, raw, redFor: this.redSince === null ? 0 : now - this.redSince, greenFor: this.greenSince === null ? 0 : now - this.greenSince };
  }
}

export interface PolicyTeam {
  id: string;
  state: string;            // running | paused | queued ...
  standing: boolean;
  priority: Priority;
  pinned: boolean;
  pauseKind: string | null; // engine-soft | engine-hard | user | null
  pausePending: boolean;    // 부드러운 멈춤 요청 뒤 아직 도는 중
  cpu: number;              // 팀 프로세스 CPU 합(%)
  rss: number;              // MB
  createdAt: number;
}

export type Action =
  | { type: 'start'; teamId: string; reason: string }
  | { type: 'pause'; teamId: string; reason: string }
  | { type: 'hardPause'; teamId: string; reason: string }
  | { type: 'resume'; teamId: string; reason: string }
  | { type: 'hold'; reason: string };

export interface PolicyInput {
  s: EngineSettings;
  zone: Zone;
  redFor: number;
  greenFor: number;
  mem: number;
  cpu: number;
  now: number;
  lastPauseAt: number;
  lastResumeAt: number;
  teams: PolicyTeam[];
  /** CPU 코어 수(팀 %CPU 는 코어 하나=100%). 없으면 외부 부하 판단을 안 한다 */
  cores?: number;
}

/** 외부 부하 기준: 빨강이 CPU 때문만이고 Hivelane 팀이 쓰는 몫이 이 비율보다 작으면 멈춰도 소용없다. */
export const OWN_SHARE_MIN = 0.25;

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

export function slotsFor(zone: Zone, s: EngineSettings): number {
  return zone === 'green' ? s.slotsGreen : zone === 'yellow' ? s.slotsYellow : 0;
}

/** 엔진이 이번 틱에 할 일을 정한다. 부수효과 없음. */
export function decide(i: PolicyInput): Action[] {
  const { s, zone, now } = i;
  const actions: Action[] = [];
  const po = i.teams.filter((t) => !t.standing);
  const running = po.filter((t) => t.state === 'running');
  const enginePaused = po.filter((t) => t.state === 'paused' && (t.pauseKind === 'engine-soft' || t.pauseKind === 'engine-hard'));

  if (zone === 'red') {
    const memHard = i.mem >= s.memHard;
    // 메모리는 정상인데 CPU 만 높고, 그 CPU 를 Hivelane 팀이 거의 안 쓰면(다른 터미널·앱의 부하) 멈춰도 내려가지 않는다 → 새 팀만 막고 유지
    if (i.cores && i.mem <= s.memR && (running.length || enginePaused.length)) {
      const own = running.reduce((a, t) => a + t.cpu, 0) / i.cores;
      if (own < i.cpu * OWN_SHARE_MIN) {
        const out: Action[] = [];
        if (running.length) out.push({ type: 'hold', reason: `CPU ${Math.round(i.cpu)}% 중 Hivelane 팀 몫 ${Math.round(own)}% · 외부 부하라 멈추지 않음(새 팀만 대기)` });
        // 외부 부하 때문에 멈춰 둔 팀도 하나씩 되돌린다(멈춰 봐야 CPU 가 안 내려간다)
        if (enginePaused.length && now - i.lastResumeAt >= s.resumeSec * 1000 && running.length < s.cap) {
          const t = [...enginePaused].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt)[0]!;
          out.push({ type: 'resume', teamId: t.id, reason: `외부 부하(Hivelane 팀 몫 ${Math.round(own)}%) · 멈춰도 CPU 가 안 내려가 재개` });
        }
        return out;
      }
    }
    // 1) 강한 멈춤: 빨강이 hardPauseSec 이상 이어졌는데 멈춤 요청 뒤에도 아직 도는 팀
    if (i.redFor >= s.hardPauseSec * 1000) {
      for (const t of running.filter((t) => t.pausePending)) actions.push({ type: 'hardPause', teamId: t.id, reason: `빨강 ${Math.round(i.redFor / 1000)}초 지속 · 부드러운 멈춤이 안 끝남` });
    }
    // 2) 부드러운 멈춤: pauseEverySec 마다 하나
    if (now - i.lastPauseAt >= s.pauseEverySec * 1000) {
      const cand = running
        .filter((t) => !t.pausePending && (!t.pinned || memHard))
        .sort((a, b) => RANK[b.priority] - RANK[a.priority] || b.cpu + b.rss / 100 - (a.cpu + a.rss / 100) || b.createdAt - a.createdAt)[0];
      if (cand) actions.push({ type: 'pause', teamId: cand.id, reason: `CPU ${Math.round(i.cpu)}% · 메모리 ${Math.round(i.mem)}% · 우선순위 ${cand.priority}${cand.pinned ? ' · 메모리 한계로 고정 무시' : ''}` });
    }
    return actions;
  }

  if (zone === 'green') {
    // 멈춘 팀이 있으면 새 팀보다 먼저 재개(초록 resumeSec 유지, resumeSec 마다 하나)
    if (enginePaused.length) {
      if (i.greenFor >= s.resumeSec * 1000 && now - i.lastResumeAt >= s.resumeSec * 1000 && running.length < s.cap) {
        const t = [...enginePaused].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt)[0]!;
        actions.push({ type: 'resume', teamId: t.id, reason: `초록 ${Math.round(i.greenFor / 1000)}초 유지` });
      }
      return actions;
    }
    let slots = s.cap - running.length;
    const queued = po.filter((t) => t.state === 'queued').sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt);
    for (const t of queued) {
      if (slots <= 0) break;
      actions.push({ type: 'start', teamId: t.id, reason: '초록 구간 · 자리 있음' });
      slots--;
    }
  }
  return actions;
}
