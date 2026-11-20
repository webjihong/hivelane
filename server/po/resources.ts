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
