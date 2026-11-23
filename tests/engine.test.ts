import { describe, expect, it } from 'vitest';
import { checkBash, checkWritePath, isHeavy } from '../server/agents/guard.ts';
import { cleanSubagentText } from '../server/agents/runner.ts';
import { DEPS_MUTATE } from '../server/teams/orchestrator.ts';
import { decide, slotsFor, ZoneTracker, type PolicyTeam } from '../server/po/policy.ts';
import { descendants, sumUsage } from '../server/po/resources.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY } from '../server/store.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

const S = DEFAULT_SETTINGS.engine;

describe('경로·명령 가드', () => {
  const root = '/w/repo-t1';
  it('worktree 안 쓰기는 허용, 밖은 거부', () => {
    expect(checkWritePath('Edit', { file_path: '/w/repo-t1/src/a.ts' }, root, [root])).toBeNull();
    expect(checkWritePath('Write', { file_path: 'src/b.ts' }, root, [root])).toBeNull();
    expect(checkWritePath('Edit', { file_path: '/w/repo-t1/../main/a.ts' }, root, [root])).toMatch(/밖에는/);
    expect(checkWritePath('Write', { file_path: '/etc/hosts' }, root, [root])).toMatch(/밖에는/);
    expect(checkWritePath('Read', { file_path: '/etc/hosts' }, root, [root])).toBeNull();
  });
  it('막힌 명령과 루트 밖 리다이렉션을 거부', () => {
    expect(checkBash('git commit -m x', root, [root], DEFAULT_BLOCKED)).toMatch(/막힌 패턴/);
    expect(checkBash('git push origin dev', root, [root], DEFAULT_BLOCKED)).toMatch(/막힌 패턴/);
    expect(checkBash('npm run db:prod:sync', root, [root], DEFAULT_BLOCKED)).toMatch(/막힌 패턴/);
    expect(checkBash('git status && git diff', root, [root], DEFAULT_BLOCKED)).toBeNull();
    expect(checkBash('echo hi > /Users/x/other/a.txt', root, [root], DEFAULT_BLOCKED)).toMatch(/밖 경로/);
    expect(checkBash('npm test > /tmp/out.log 2>/dev/null', root, [root], DEFAULT_BLOCKED)).toBeNull();
    expect(checkBash('echo ok > /w/repo-t1/x.txt', root, [root], DEFAULT_BLOCKED)).toBeNull();
  });
  it('서브에이전트 결과 틀 걷어 내기', () => {
    const raw = '<tools-used-before-summary>Bash</tools-used-before-summary>\n[Subagent hand-back] The text below is ... The report follows:\n  **PASS**\n  - 통과 2\nagentId: a87\n<usage>subagent_tokens: 1</usage>';
    expect(cleanSubagentText(raw)).toBe('**PASS**\n- 통과 2');
    expect(cleanSubagentText('그냥 결과')).toBe('그냥 결과');
  });
  it('git 전역 옵션으로 감싼 커밋·공유 ref 변경도 막고, 읽기 명령은 허용', () => {
    for (const c of ['git -C . commit -m x', 'git --no-pager push', 'git -c user.name=x commit', 'git stash', 'git branch -f dev', 'git update-ref refs/heads/dev HEAD', 'git clean -fdx', 'git reset --hard HEAD~1', 'git checkout -b x'])
      expect(checkBash(c, root, [root], DEFAULT_BLOCKED), c).toMatch(/막힌 패턴/);
    for (const c of ['git status', 'git diff --stat', 'git log --oneline --grep commit', 'git show HEAD', 'git -C . diff'])
      expect(checkBash(c, root, [root], DEFAULT_BLOCKED), c).toBeNull();
  });
  it('공유 node_modules 에서는 의존성 변경 명령을 막는다', () => {
    expect(checkBash('npm install lodash', root, [root], DEPS_MUTATE)).toMatch(/막힌 패턴/);
    expect(checkBash('pnpm add x', root, [root], DEPS_MUTATE)).toMatch(/막힌 패턴/);
    expect(checkBash('npm test', root, [root], DEPS_MUTATE)).toBeNull();
    expect(checkBash('npm run build', root, [root], DEPS_MUTATE)).toBeNull();
  });
  it('무거운 명령 판별', () => {
    expect(isHeavy('cd /w && npm test', DEFAULT_HEAVY)).toBe(true);
    expect(isHeavy('pnpm run typecheck', DEFAULT_HEAVY)).toBe(true);
    expect(isHeavy('npm install', DEFAULT_HEAVY)).toBe(false);
    expect(isHeavy('npx vitest run src/a.test.ts', DEFAULT_HEAVY)).toBe(true);
    expect(isHeavy('npm run build', DEFAULT_HEAVY)).toBe(true);
    expect(isHeavy('npx tsc --noEmit', DEFAULT_HEAVY)).toBe(true);
    expect(isHeavy('ls -la', DEFAULT_HEAVY)).toBe(false);
  });
});

describe('구간 판정', () => {
  it('지속 시간이 지나야 올라가고, 내려갈 때는 바로', () => {
    const z = new ZoneTracker();
    expect(z.update(90, 50, S, 0).zone).toBe('green');
    expect(z.update(90, 50, S, 10_000).zone).toBe('green');
    expect(z.update(90, 50, S, 31_000).zone).toBe('red');
    expect(z.update(72, 50, S, 32_000).zone).toBe('yellow'); // 빨강→노랑: 노랑 이상은 0초부터 이어짐
    expect(z.update(20, 50, S, 33_000).zone).toBe('green');
    expect(z.update(72, 50, S, 34_000).zone).toBe('green'); // 노랑 막 시작
    expect(z.update(72, 50, S, 65_000).zone).toBe('yellow');
    const g = z.update(20, 30, S, 66_000);
    expect(g.zone).toBe('green');
    expect(z.update(20, 30, S, 186_000).greenFor).toBe(120_000);
  });
  it('구간별 무거운 명령 자리', () => {
    expect(slotsFor('green', S)).toBe(2);
    expect(slotsFor('yellow', S)).toBe(1);
    expect(slotsFor('red', S)).toBe(0);
  });
});

const T = (p: Partial<PolicyTeam> & { id: string }): PolicyTeam => ({ state: 'running', standing: false, priority: 'normal', pinned: false, pauseKind: null, pausePending: false, cpu: 0, rss: 0, createdAt: 0, ...p });
const base = { s: S, redFor: 0, greenFor: 0, mem: 50, cpu: 50, now: 1_000_000, lastPauseAt: 0, lastResumeAt: 0 };

describe('엔진 결정', () => {
  it('초록: 상한까지 우선순위 순으로 시작', () => {
    const a = decide({ ...base, zone: 'green', teams: [T({ id: 'r1' }), T({ id: 'q-low', state: 'queued', priority: 'low' }), T({ id: 'q-urg', state: 'queued', priority: 'urgent', createdAt: 5 }), T({ id: 'q-norm', state: 'queued' })] });
    expect(a.map((x) => x.type + ':' + ('teamId' in x ? x.teamId : ''))).toEqual(['start:q-urg', 'start:q-norm']);
  });
  it('노랑: 아무것도 시작하지 않음', () => {
    expect(decide({ ...base, zone: 'yellow', teams: [T({ id: 'q', state: 'queued' })] })).toEqual([]);
  });
  it('빨강: 낮은 우선순위부터, 고정·직속 제외, 60초에 하나', () => {
    const teams = [T({ id: 'urg', priority: 'urgent' }), T({ id: 'low', priority: 'low', pinned: true }), T({ id: 'norm', priority: 'normal', cpu: 50 }), T({ id: 'norm2', priority: 'normal', cpu: 10 }), T({ id: 'st', standing: true, priority: 'low' })];
    const a = decide({ ...base, zone: 'red', teams });
    expect(a).toEqual([expect.objectContaining({ type: 'pause', teamId: 'norm' })]);
    expect(decide({ ...base, zone: 'red', lastPauseAt: base.now - 10_000, teams })).toEqual([]);
  });
  it('빨강 + 메모리 한계: 고정 팀도 대상', () => {
    const a = decide({ ...base, zone: 'red', mem: 96, teams: [T({ id: 'low', priority: 'low', pinned: true }), T({ id: 'urg', priority: 'urgent' })] });
    expect(a[0]).toMatchObject({ type: 'pause', teamId: 'low' });
  });
  it('빨강이 오래가면 멈춤 요청 뒤에도 도는 팀을 강하게 멈춤', () => {
    const a = decide({ ...base, zone: 'red', redFor: 130_000, lastPauseAt: base.now, teams: [T({ id: 'p', pausePending: true })] });
    expect(a).toEqual([expect.objectContaining({ type: 'hardPause', teamId: 'p' })]);
  });
  it('초록 유지 시 엔진이 멈춘 팀부터 하나씩 재개, 새 팀은 그다음', () => {
    const teams = [T({ id: 'pl', state: 'paused', pauseKind: 'engine-soft', priority: 'low' }), T({ id: 'pu', state: 'paused', pauseKind: 'engine-soft', priority: 'urgent' }), T({ id: 'user', state: 'paused', pauseKind: 'user' }), T({ id: 'q', state: 'queued' })];
    expect(decide({ ...base, zone: 'green', greenFor: 60_000, teams })).toEqual([]);
    expect(decide({ ...base, zone: 'green', greenFor: 130_000, teams })).toEqual([expect.objectContaining({ type: 'resume', teamId: 'pu' })]);
    expect(decide({ ...base, zone: 'green', greenFor: 130_000, teams: teams.filter((t) => t.pauseKind !== 'engine-soft') })).toEqual([expect.objectContaining({ type: 'start', teamId: 'q' })]);
  });
});

describe('무거운 명령 자리', () => {
  it('용량만큼만 동시에, 직속 팀이 앞에, 용량 0이어도 직속은 1', async () => {
    const s = new HeavySlots(1);
    const order: string[] = [];
    const r1 = await s.acquire('a', 'normal', false);
    const p2 = s.acquire('b', 'low', false).then((r) => { order.push('b'); return r; });
    const p3 = s.acquire('c', 'urgent', false).then((r) => { order.push('c'); return r; });
    const p4 = s.acquire('st', 'low', true).then((r) => { order.push('st'); return r; });
    expect(s.stats).toMatchObject({ running: 1, waiting: 3 });
    r1();
    const r4 = await p4; r4();
    const r3 = await p3; r3();
    const r2 = await p2; r2();
    expect(order).toEqual(['st', 'c', 'b']);
    s.setCapacity(0);
    const z = await s.acquire('st2', 'normal', true);
    expect(s.stats.running).toBe(1);
    z();
  });
  it('팀 취소 시 대기 거절, 해제는 한 번만', async () => {
    const s = new HeavySlots(1);
    const r = await s.acquire('a', 'normal', false);
    const p = s.acquire('b', 'normal', false);
    s.cancelTeam('b');
    await expect(p).rejects.toThrow();
    r(); r();
    expect(s.stats).toMatchObject({ running: 0, waiting: 0 });
  });
});

describe('프로세스 트리', () => {
  it('자손 합산', () => {
    const procs = [{ pid: 1, ppid: 0, cpu: 1, rssMb: 10 }, { pid: 10, ppid: 1, cpu: 50, rssMb: 100 }, { pid: 11, ppid: 10, cpu: 20, rssMb: 200 }, { pid: 99, ppid: 1, cpu: 5, rssMb: 5 }];
    const d = descendants(procs, [10]);
    expect(d.map((p) => p.pid).sort()).toEqual([10, 11]);
    expect(sumUsage(d)).toEqual({ cpu: 70, rss: 300, count: 2 });
  });
});

describe('외부 부하·직접 재개 보호', () => {
  const teams = [T({ id: 'a', cpu: 30 }), T({ id: 'b', cpu: 20 })];
  it('CPU 빨강이 다른 프로그램 때문이면(팀 몫 작음) 멈추지 않고 유지', () => {
    const a = decide({ ...base, zone: 'red', cpu: 90, mem: 40, cores: 10, teams });
    expect(a).toEqual([expect.objectContaining({ type: 'hold' })]);
  });
  it('팀이 CPU 대부분을 쓰면 평소처럼 멈춤', () => {
    const heavy = [T({ id: 'a', cpu: 500 }), T({ id: 'b', cpu: 300 })];
    expect(decide({ ...base, zone: 'red', cpu: 90, mem: 40, cores: 10, teams: heavy })[0]).toMatchObject({ type: 'pause' });
  });
  it('메모리 빨강이면 외부 부하여도 멈춤, 팀 측정이 없으면(cores 없음) 예전대로', () => {
    expect(decide({ ...base, zone: 'red', cpu: 90, mem: 90, cores: 10, teams })[0]).toMatchObject({ type: 'pause' });
    expect(decide({ ...base, zone: 'red', cpu: 90, mem: 40, teams })[0]).toMatchObject({ type: 'pause' });
  });
  it('직접 재개한 팀(보호 = pinned 취급)은 멈춤 대상에서 빠진다', () => {
    const a = decide({ ...base, zone: 'red', teams: [T({ id: 'mine', pinned: true, priority: 'low' }), T({ id: 'other' })] });
    expect(a[0]).toMatchObject({ type: 'pause', teamId: 'other' });
  });
});

describe('외부 부하로 멈춘 팀 되돌리기', () => {
  it('모두 멈춰 있고 CPU 가 외부 부하면 resumeSec 간격으로 하나씩 재개', () => {
    const teams = [T({ id: 'p1', state: 'paused', pauseKind: 'engine-soft', priority: 'urgent' }), T({ id: 'p2', state: 'paused', pauseKind: 'engine-soft' })];
    expect(decide({ ...base, zone: 'red', cpu: 90, mem: 40, cores: 10, teams })).toEqual([expect.objectContaining({ type: 'resume', teamId: 'p1' })]);
    expect(decide({ ...base, zone: 'red', cpu: 90, mem: 40, cores: 10, lastResumeAt: base.now - 1000, teams })).toEqual([]);
  });
});
