import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoWatcher } from '../server/projects/repos.ts';
import { testEnv } from './helpers.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();

describe('저장소 상태·받기', () => {
  it('원격보다 뒤처짐을 세고, 받기(빨리 감기만), 로컬 변경과 겹치면 거절', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hl-repo-'));
    const origin = join(root, 'origin.git'); const a = join(root, 'a'); const b = join(root, 'b');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'clone', origin, b); writeFileSync(join(b, 'f.txt'), '1\n'); git(b, 'add', '.'); git(b, 'commit', '-m', 'c1'); git(b, 'push', 'origin', 'HEAD:main');
    git(root, 'clone', origin, a);
    writeFileSync(join(b, 'f.txt'), '2\n'); git(b, 'commit', '-am', 'c2'); git(b, 'push');
    const { store } = testEnv();
    const p = store.insertProject({ name: 'app', path: a, base_ref: 'origin/main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const w = new RepoWatcher({ store });
    await w.refresh(true);
    expect(w.repos[0]).toMatchObject({ branch: 'main', upstream: 'origin/main', behind: 1, ahead: 0, dirty: 0 });
    const ok = await w.pull(p.id);
    expect(ok.ok).toBe(true);
    expect(w.repos[0]).toMatchObject({ behind: 0 });
    // 로컬에서 같은 파일을 고친 상태로 새 원격 커밋을 받으면 거절
    writeFileSync(join(b, 'f.txt'), '3\n'); git(b, 'commit', '-am', 'c3'); git(b, 'push');
    writeFileSync(join(a, 'f.txt'), 'local\n');
    await w.refresh(true);
    expect(w.repos[0]).toMatchObject({ behind: 1, dirty: 1 });
    const no = await w.pull(p.id);
    expect(no.ok).toBe(false);
    expect(no.message).toContain('겹칩니다');
  });
});
