import { cpus, loadavg, totalmem } from 'node:os';
import { run } from '../util.ts';

interface CpuTimes { idle: number; total: number }

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export class CpuMeter {
  private prev = cpuTimes();
  /** 직전 호출 이후 CPU 사용률(%) */
  sample(): number {
    const cur = cpuTimes();
    const dt = cur.total - this.prev.total;
    const di = cur.idle - this.prev.idle;
    this.prev = cur;
    return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
}

/**
 * macOS 메모리 사용률. 시스템이 판단하는 여유율(kern.memorystatus_level, Activity Monitor 의 메모리 압박과 같은 기준)을 쓴다.
 * active+wired+compressed 합은 캐시·압축 때문에 평소에도 75% 를 넘어 기준으로 쓰기 어렵다.
 */
export async function memPercent(): Promise<number> {
  const s = await run('sysctl', ['-n', 'kern.memorystatus_level'], { timeoutMs: 3000 });
  const free = Number(s.stdout.trim());
  if (s.code === 0 && Number.isFinite(free) && free > 0) return Math.max(0, Math.min(100, 100 - free));
  const r = await run('vm_stat', [], { timeoutMs: 5000 });
  if (r.code !== 0) return 0;
  const page = Number(r.stdout.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const get = (label: string) => Number(r.stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const used = (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
  return Math.max(0, Math.min(100, (used / totalmem()) * 100));
}

export function load1(): number {
  return loadavg()[0] ?? 0;
}

export interface Proc { pid: number; ppid: number; cpu: number; rssMb: number }

export async function listProcs(): Promise<Proc[]> {
  const r = await run('ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], { timeoutMs: 5000 });
  if (r.code !== 0) return [];
  const out: Proc[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length < 4) continue;
    out.push({ pid: Number(m[0]), ppid: Number(m[1]), cpu: Number(m[2]), rssMb: Number(m[3]) / 1024 });
  }
  return out;
}

/** 루트 pid 들의 자손 전체(루트 포함). */
export function descendants(procs: Proc[], roots: number[]): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) { const a = kids.get(p.ppid) ?? []; a.push(p); kids.set(p.ppid, a); }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  const out: Proc[] = [];
  const stack = roots.filter((r) => byPid.has(r));
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (p) out.push(p);
    for (const k of kids.get(pid) ?? []) stack.push(k.pid);
  }
  return out;
}

export function sumUsage(ps: Proc[]): { cpu: number; rss: number; count: number } {
  return { cpu: ps.reduce((a, p) => a + p.cpu, 0), rss: ps.reduce((a, p) => a + p.rssMb, 0), count: ps.length };
}

/** 프로세스 트리 전체에 신호. 자식부터 멈추고, 깨울 때는 부모부터. */
export function signalTree(procs: Proc[], sig: 'SIGSTOP' | 'SIGCONT'): number {
  const ordered = sig === 'SIGSTOP' ? [...procs].reverse() : procs;
  let n = 0;
  for (const p of ordered) {
    try { process.kill(p.pid, sig); n++; } catch { /* 이미 끝난 프로세스 */ }
  }
  return n;
}

/* ---------- PO 진단용: 누가 CPU·메모리를 쓰는지 ---------- */

export interface ProcDetail extends Proc { etime: string; command: string }

export async function listProcDetails(): Promise<ProcDetail[]> {
  const r = await run('ps', ['-axww', '-o', 'pid=,ppid=,%cpu=,rss=,etime=,command='], { timeoutMs: 5000 });
  if (r.code !== 0) return [];
  const out: ProcDetail[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssMb: Number(m[4]) / 1024, etime: m[5]!, command: m[6]! });
  }
  return out;
}

const base = (cmd: string) => (cmd.split(/\s+/)[0] ?? '').split('/').pop() ?? '';
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'login', '-zsh', '-bash']);

/** 프로세스의 「출처」: 가장 가까운 Claude Code 세션 → 없으면 launchd 바로 밑 조상(앱). */
export function originOf(p: ProcDetail, byPid: Map<number, ProcDetail>): ProcDetail {
  let cur: ProcDetail = p;
  let top: ProcDetail = p;
  for (let i = 0; i < 64; i++) {
    if (base(cur.command) === 'claude') return cur;
    const parent = byPid.get(cur.ppid);
    if (!parent || parent.pid <= 1) return top;
    if (!SHELLS.has(base(parent.command))) top = parent;
    cur = parent;
  }
  return top;
}

export interface DiagInput {
  procs: ProcDetail[];
  cpu: number; mem: number; load: number; cores: number;
  /** Hivelane 팀 루트 pid → 팀 이름 */
  teamRoots: Map<number, string>;
  hivelanePid: number;
  /** 출처 pid → 작업 디렉토리(있으면) */
  cwdOf?: Map<number, string>;
  top?: number;
}

/** 사람·PO 가 읽을 진단 보고서. 순수 함수(테스트 가능). */
export function diagnose(d: DiagInput): { text: string; origins: number[] } {
  const byPid = new Map(d.procs.map((p) => [p.pid, p]));
  const teamOf = new Map<number, string>();
  for (const [root, name] of d.teamRoots) for (const p of descendants(d.procs, [root])) teamOf.set(p.pid, name);
  for (const p of descendants(d.procs, [d.hivelanePid])) if (!teamOf.has(p.pid)) teamOf.set(p.pid, 'Hivelane 서버');
  const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // 출처별 합계
  const groups = new Map<number, { origin: ProcDetail; cpu: number; rss: number; n: number; team: string | null }>();
  for (const p of d.procs) {
    if (p.pid === 0) continue;
    const o = originOf(p, byPid);
    const g = groups.get(o.pid) ?? { origin: o, cpu: 0, rss: 0, n: 0, team: teamOf.get(p.pid) ?? null };
    g.cpu += p.cpu; g.rss += p.rssMb; g.n++;
    groups.set(o.pid, g);
  }
  const topGroups = [...groups.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  const topProcs = [...d.procs].sort((a, b) => b.cpu - a.cpu).slice(0, d.top ?? 12);
  const memTop = [...d.procs].sort((a, b) => b.rssMb - a.rssMb).slice(0, 6);
  const lines: string[] = [];
  lines.push(`## 시스템: CPU ${d.cpu.toFixed(0)}% · 메모리 압박 ${d.mem.toFixed(0)}% · load ${d.load.toFixed(1)} (코어 ${d.cores}개, %CPU 는 코어 하나=100%)`);
  lines.push('\n## 출처별 CPU 합계 (가까운 Claude Code 세션 또는 앱 단위)');
  for (const g of topGroups) {
    const cwd = d.cwdOf?.get(g.origin.pid);
    const who = g.team ? ` [${g.team}]` : '';
    lines.push(`- ${g.cpu.toFixed(0)}% · ${Math.round(g.rss)}MB · 프로세스 ${g.n}개 · pid ${g.origin.pid} ${short(g.origin.command, 120)}${cwd ? ` · cwd ${cwd}` : ''}${who}`);
  }
  lines.push('\n## CPU 상위 프로세스');
  for (const p of topProcs) {
    const parent = byPid.get(p.ppid);
    const who = teamOf.get(p.pid);
    lines.push(`- ${p.cpu.toFixed(0)}% · ${Math.round(p.rssMb)}MB · ${p.etime} · pid ${p.pid} ${short(p.command)}${parent ? ` ← ${p.ppid} ${short(parent.command, 80)}` : ''}${who ? ` [${who}]` : ''}`);
  }
  lines.push('\n## 메모리 상위 프로세스');
  for (const p of memTop) lines.push(`- ${Math.round(p.rssMb)}MB · pid ${p.pid} ${short(p.command, 120)}${teamOf.get(p.pid) ? ` [${teamOf.get(p.pid)}]` : ''}`);
  return { text: lines.join('\n'), origins: topGroups.map((g) => g.origin.pid) };
}

/** 프로세스 작업 디렉토리(lsof). 실패하면 비움. */
export async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  const r = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], { timeoutMs: 5000 });
  let cur = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) cur = Number(line.slice(1));
    else if (line.startsWith('n') && cur) out.set(cur, line.slice(1));
  }
  return out;
}
