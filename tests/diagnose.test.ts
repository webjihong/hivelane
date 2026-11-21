import { describe, expect, it } from 'vitest';
import { checkBash } from '../server/agents/guard.ts';
import { PO_BLOCKED } from '../server/po/agent.ts';
import { diagnose, type ProcDetail } from '../server/po/resources.ts';
import { DEFAULT_BLOCKED } from '../server/store.ts';

const P = (pid: number, ppid: number, cpu: number, command: string, rssMb = 100): ProcDetail => ({ pid, ppid, cpu, rssMb, etime: '01:00', command });

describe('PO 시스템 진단', () => {
  const procs = [
    P(1, 0, 0, '/sbin/launchd'),
    P(10, 1, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
    P(11, 10, 0, '-zsh'),
    P(20, 11, 20, 'claude', 600),
    P(21, 20, 0, 'npm exec vitest run'),
    P(22, 21, 90, 'node vitest run'),
    P(23, 22, 80, 'node vitest worker'),
    P(30, 1, 5, 'node --import tsx server/index.ts'),
    P(31, 30, 30, '/opt/claude-code/claude --output-format stream-json'),
    P(40, 1, 3, '/Applications/GitKraken.app/Contents/MacOS/GitKraken', 2000),
  ];
  it('출처별로 묶어 가장 많이 쓰는 Claude Code 세션을 맨 위에, Hivelane 팀은 표시', () => {
    const r = diagnose({ procs, cpu: 99, mem: 30, load: 12, cores: 10, teamRoots: new Map([[31, 'Hivelane 팀 tm-1 「앱팀」']]), hivelanePid: 30, cwdOf: new Map([[20, '/Users/x/my-repo']]) });
    const groups = r.text.split('## 출처별')[1]!.split('## CPU 상위')[0]!.trim().split('\n').slice(1);
    expect(groups[0]).toMatch(/^- 190% .*pid 20 claude · cwd \/Users\/x\/my-repo/);
    expect(r.text).toMatch(/pid 31 .*\[Hivelane 팀 tm-1 「앱팀」\]/);
    expect(r.text).toMatch(/GitKraken/);
    expect(r.origins[0]).toBe(20);
  });
  it('PO Bash 는 진단 명령만: kill·설치·시스템 변경·git 커밋은 막힘', () => {
    const blocked = [...DEFAULT_BLOCKED, ...PO_BLOCKED];
    for (const c of ['kill -9 123', 'pkill node', 'killall node', 'launchctl unload x', 'npm install x', 'brew install x', 'git commit -m x', 'sudo ls', 'tailscale down'])
      expect(checkBash(c, '/po', ['/po'], blocked), c).toMatch(/막힌 패턴/);
    for (const c of ['ps -axo pid,command', 'top -l 1 -o cpu -n 10', 'lsof -p 123', 'vm_stat', 'df -h', 'pmset -g'])
      expect(checkBash(c, '/po', ['/po'], blocked), c).toBeNull();
  });
});
