import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface TeamTools {
  setPlan(items: string[]): string;
  checkItem(index: number, done: boolean): string;
  setStage(stage: number): string;
  delegate(roleKey: string, instruction: string): Promise<string>;
  askHuman(question: string, options: string[]): string;
  report(status: 'done' | 'failed', summary: string): string;
  readTeamRecords(teamId: string, query: string): string;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** PM 세션에 붙이는 인프로세스 MCP 서버(이름 hivelane). */
export function teamMcpServer(impl: TeamTools, opts: { sessionRoles: { key: string; name: string }[]; readableTeams: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK 가 도구 배열을 any 스키마로 받는다
  const tools: SdkMcpToolDefinition<any>[] = [
    tool('set_plan', '할 일 목록(완료 기준 포함)을 정한다. 기존 목록을 바꾼다.', { items: z.array(z.string()).min(1).describe('할 일. 완료 기준이 보이게 쓴다') }, async (a) => text(impl.setPlan(a.items))),
    tool('check_item', '할 일 하나를 끝냄/안 끝냄으로 표시한다.', { index: z.number().int().min(0).describe('0부터 시작하는 번호'), done: z.boolean().default(true) }, async (a) => text(impl.checkItem(a.index, a.done))),
    tool('set_stage', '팀의 현재 단계를 표시한다. 0=기획 1=구현 2=검사 3=보고', { stage: z.number().int().min(0).max(3) }, async (a) => text(impl.setStage(a.stage))),
    tool('ask_human', '사람의 결정이 필요할 때 질문을 올린다. 호출한 뒤에는 바로 턴을 끝내라. 답은 다음 메시지로 온다.', {
      question: z.string().min(3), options: z.array(z.string()).max(5).default([]).describe('고를 수 있는 답(선택). 자유 답도 가능'),
    }, async (a) => text(impl.askHuman(a.question, a.options))),
    tool('report', '업무를 끝낸다. 반드시 마지막에 호출한다.', {
      status: z.enum(['done', 'failed']), summary: z.string().min(5).describe('바뀐 파일, 검증 결과, 사람이 확인할 점'),
    }, async (a) => text(impl.report(a.status, a.summary))),
  ];
  if (opts.sessionRoles.length) {
    tools.push(tool('delegate', `독립 세션 팀원에게 일을 맡기고 결과를 받는다. 이 팀원들은 이전에 맡긴 일을 기억한다: ${opts.sessionRoles.map((r) => `${r.key}(${r.name})`).join(', ')}`, {
      role_key: z.enum(opts.sessionRoles.map((r) => r.key) as [string, ...string[]]), instruction: z.string().min(5),
    }, async (a) => text(await impl.delegate(a.role_key, a.instruction))));
  }
  if (opts.readableTeams) {
    tools.push(tool('read_team_records', '허용된 다른 팀의 최근 기록(요약·바뀐 파일·대화)을 읽는다.', { team_id: z.string(), query: z.string().default('') }, async (a) => text(impl.readTeamRecords(a.team_id, a.query))));
  }
  return createSdkMcpServer({ name: 'hivelane', version: '0.1.0', tools });
}

export function teamToolNames(sessionRoles: boolean, readable: boolean): string[] {
  const n = ['set_plan', 'check_item', 'set_stage', 'ask_human', 'report'];
  if (sessionRoles) n.push('delegate');
  if (readable) n.push('read_team_records');
  return n.map((x) => `mcp__hivelane__${x}`);
}
