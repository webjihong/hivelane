import { run } from '../util.ts';
import { describeRemote, remoteOf, type RemoteInfo } from './git.ts';

const git = (cwd: string, args: string[], timeoutMs = 120_000) => run('git', ['-C', cwd, ...args], { timeoutMs });

/** gh 에 로그인된 GitHub 계정들(활성 표시). gh 가 없으면 null */
export async function githubAccounts(): Promise<{ login: string; active: boolean }[] | null> {
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 10_000 });
  if (r.code !== 0 && !/Logged in/.test(r.stdout + r.stderr)) return /not found|ENOENT/.test(r.stderr) ? null : [];
  const out = `${r.stdout}\n${r.stderr}`;
  const list: { login: string; active: boolean }[] = [];
  for (const m of out.matchAll(/Logged in to github\.com account (\S+)[^\n]*\n\s*-\s*Active account:\s*(true|false)/g)) list.push({ login: m[1]!, active: m[2] === 'true' });
  return list;
}

async function currentBranch(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
}

/** 이미 있는 원격 주소를 origin 으로 연결(+ 원하면 지금 브랜치를 올림) */
export async function linkRemoteUrl(root: string, url: string, push: boolean): Promise<{ remote: RemoteInfo; log: string[] }> {
  if (await remoteOf(root)) throw new Error('이미 원격 저장소가 연결돼 있습니다');
  const u = url.trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(u)) throw new Error('원격 주소는 https://… 또는 git@… 형태여야 합니다');
  const log: string[] = [];
  const add = await git(root, ['remote', 'add', 'origin', u]);
  if (add.code !== 0) throw new Error(`연결 실패: ${add.stderr.trim()}`);
  log.push(`origin ← ${describeRemote('origin', u).label}`);
  if (push) {
    const br = await currentBranch(root);
    const p = await git(root, ['push', '-u', 'origin', br], 300_000);
    if (p.code !== 0) { log.push(`올리기 실패: ${(p.stderr || p.stdout).trim().slice(0, 300)}`); return { remote: describeRemote('origin', u), log }; }
    log.push(`${br} 브랜치를 올렸습니다`);
  }
  return { remote: describeRemote('origin', u), log };
}

/**
 * GitHub 에 새 저장소를 만들고 origin 으로 연결한 뒤 지금 브랜치를 올린다(gh repo create).
 * account 를 주면 그 계정의 토큰으로만 실행한다(전역 활성 계정은 바꾸지 않음).
 */
export async function createGithubRepo(root: string, o: { account?: string; owner?: string; name: string; visibility: 'private' | 'public'; description?: string }): Promise<{ remote: RemoteInfo; log: string[] }> {
  if (await remoteOf(root)) throw new Error('이미 원격 저장소가 연결돼 있습니다');
  if (!/^[\w.-]{1,100}$/.test(o.name)) throw new Error('저장소 이름은 영문·숫자·-·_·. 만 씁니다');
  if (o.owner && !/^[\w-]{1,39}$/.test(o.owner)) throw new Error('소유자(계정·조직) 이름이 이상합니다');
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (o.account) {
    const t = await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', o.account], { timeoutMs: 10_000 });
    if (t.code !== 0 || !t.stdout.trim()) throw new Error(`${o.account} 계정 토큰을 찾지 못했습니다(gh auth login 필요)`);
    env.GH_TOKEN = t.stdout.trim();
  }
  const full = o.owner ? `${o.owner}/${o.name}` : o.name;
  const args = ['repo', 'create', full, `--${o.visibility}`, '--source', root, '--remote', 'origin', '--push'];
  if (o.description) args.push('--description', o.description.slice(0, 200));
  const r = await run('gh', args, { cwd: root, timeoutMs: 300_000, env });
  if (r.code !== 0) throw new Error(`GitHub 저장소 만들기 실패: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const remote = await remoteOf(root);
  if (!remote) throw new Error('저장소는 만들었지만 origin 연결을 확인하지 못했습니다');
  return { remote, log: [`GitHub 에 ${remote.label} (${o.visibility === 'private' ? '비공개' : '공개'}) 를 만들고 올렸습니다`] };
}
