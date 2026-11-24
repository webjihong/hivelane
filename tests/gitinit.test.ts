import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRepo, inspectRepo } from '../server/projects/git.ts';
import { makeRepo } from './helpers.ts';

describe('git 이 아닌 폴더에서 git 시작하기', () => {
  it('기본 .gitignore 를 만들고 첫 커밋 · .env·node_modules 는 빠진다', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hl-init-')), 'my-app');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n');
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    writeFileSync(join(dir, 'node_modules', 'x', 'a.js'), 'x\n');
    await expect(inspectRepo(dir)).rejects.toThrow(/git 저장소가 아닙니다/);
    const info = await initRepo(dir);
    expect(info.name).toBe('my-app');
    expect(info.baseRef).toBe('main');
    const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.sort()).toEqual(['.gitignore', 'index.js']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env');
    expect(execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' })).toContain('Hivelane: 처음 상태');
    await expect(initRepo(dir)).rejects.toThrow(/이미 git 저장소/);
  });
  it('이미 있는 .gitignore 는 그대로 · 다른 저장소 안쪽·넓은 위치는 거절', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hl-init-')), 'b');
    mkdirSync(dir);
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    await initRepo(dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
    const repo = makeRepo();
    mkdirSync(join(repo, 'sub'));
    await expect(initRepo(join(repo, 'sub'))).rejects.toThrow(/이미 git 저장소/);
    await expect(initRepo(homedir())).rejects.toThrow(/이 위치에서는/);
    await expect(initRepo(join(homedir(), 'Desktop'))).rejects.toThrow(/이 위치에서는/);
  });
});

import { describeRemote } from '../server/projects/git.ts';
describe('원격 저장소 표시', () => {
  it('ssh·https 주소를 웹 주소로 · 토큰은 가린다', () => {
    expect(describeRemote('origin', 'git@github.com:webjihong/hivelane.git\n')).toMatchObject({ web: 'https://github.com/webjihong/hivelane', label: 'github.com/webjihong/hivelane' });
    expect(describeRemote('origin', 'https://github.com/acme/app.git')).toMatchObject({ web: 'https://github.com/acme/app' });
    const t = describeRemote('origin', 'https://x-access-token:ghp_SECRET@github.com/a/b.git');
    expect(t.url).not.toContain('SECRET');
    expect(t.web).toBe('https://github.com/a/b');
    expect(describeRemote('up', '/Volumes/backup/repo.git')).toMatchObject({ web: null, label: '/Volumes/backup/repo.git' });
  });
  it('git 시작한 폴더는 원격이 없다', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const d = join(mkdtempSync(join(tmpdir(), 'hl-init-')), 'c'); mkdirSync(d);
    expect((await initRepo(d)).remote).toBeNull();
  });
});
