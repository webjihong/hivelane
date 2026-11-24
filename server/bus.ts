import { EventEmitter } from 'node:events';
import type { UsageView } from '../shared/types.ts';

/**
 * 서버 안의 이벤트 버스. SSE 로 화면에 그대로 흘려보낸다.
 * - state: 무언가 바뀌었으니 스냅샷을 다시 받아라(화면이 디바운스)
 * - agent_event: 에이전트 진행 스트림 한 줄
 * - chat: PO 대화창 한 줄
 * - resource: 리소스 측정값
 * - usage: Claude 플랜 사용량
 */
export type BusEvent =
  | { type: 'state'; reason: string }
  | { type: 'agent_event'; agentId: string; teamId: string | null; event: AgentEventRow }
  | { type: 'chat'; row: ChatRow }
  | { type: 'resource'; sample: ResourceSnapshot }
  | { type: 'script_out'; runId: number; chunk: string }
  | { type: 'usage'; usage: UsageView };

export interface AgentEventRow { id: number; agent_id: string; team_id: string | null; kind: string; name: string | null; body: string; created_at: string }
export interface ChatRow { id: number; role: string; body: string; proposal_id: string | null; links: string | null; tone: string | null; team_id: string | null; created_at: string }
export interface ResourceSnapshot { cpu: number; mem: number; zone: Zone; heavyRunning: number; heavyWaiting: number; takenAt: string }
export type Zone = 'green' | 'yellow' | 'red';

class Bus extends EventEmitter {
  emitEvent(e: BusEvent): void { this.emit('event', e); }
  onEvent(fn: (e: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
  changed(reason: string): void { this.emitEvent({ type: 'state', reason }); }
}

export const bus = new Bus();
bus.setMaxListeners(200);
