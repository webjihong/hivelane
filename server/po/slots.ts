import { st } from '../i18n.ts';
import type { Priority } from '../../shared/types.ts';

interface Waiter {
  id: number;
  teamId: string;
  rank: number;
  standing: boolean;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
}

const RANK: Record<Priority, number> = { urgent: 1, normal: 2, low: 3 };

/**
 * 무거운 명령 자리. 용량은 구간에 따라 엔진이 바꾼다.
 * 직속 팀은 맨 앞에 서고, 용량이 0 이어도 1 자리는 보장한다.
 */
export class HeavySlots {
  private capacity: number;
  private running = new Map<number, { teamId: string; standing: boolean }>();
  private waiters: Waiter[] = [];
  private seq = 0;
  onChange: () => void = () => {};

  constructor(capacity: number) { this.capacity = capacity; }

  setCapacity(n: number): void {
    this.capacity = Math.max(0, Math.floor(n));
    this.pump();
  }
  get stats() { return { running: this.running.size, waiting: this.waiters.length, capacity: this.capacity }; }
  waitingPosition(teamId: string): number {
    const i = this.sorted().findIndex((w) => w.teamId === teamId);
    return i < 0 ? 0 : i + 1;
  }

  acquire(teamId: string, priority: Priority, standing: boolean, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { id: ++this.seq, teamId, rank: standing ? 0 : RANK[priority], standing, enqueuedAt: Date.now(), resolve, reject };
      this.waiters.push(w);
      if (signal) {
        const onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) { this.waiters.splice(i, 1); this.onChange(); reject(new Error(st('대기 취소'))); }
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pump();
      this.onChange();
    });
  }

  /** 팀이 멈추거나 끝날 때 남은 대기를 모두 거절한다. */
  cancelTeam(teamId: string): void {
    const gone = this.waiters.filter((w) => w.teamId === teamId);
    this.waiters = this.waiters.filter((w) => w.teamId !== teamId);
    for (const w of gone) w.reject(new Error(st('팀이 멈춰 대기를 취소했습니다')));
    if (gone.length) this.onChange();
  }

  private sorted(): Waiter[] {
    return [...this.waiters].sort((a, b) => a.rank - b.rank || a.enqueuedAt - b.enqueuedAt);
  }

  private pump(): void {
    let changed = false;
    for (const w of this.sorted()) {
      const cap = w.standing ? Math.max(this.capacity, 1) : this.capacity;
      if (this.running.size >= cap) continue;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      const key = w.id;
      this.running.set(key, { teamId: w.teamId, standing: w.standing });
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.running.delete(key);
        this.pump();
        this.onChange();
      });
      changed = true;
    }
    if (changed) this.onChange();
  }
}
