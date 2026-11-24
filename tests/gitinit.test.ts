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
