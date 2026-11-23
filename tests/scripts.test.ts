import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bus } from '../server/bus.ts';
import { ScriptRunner } from '../server/scripts.ts';
import { sleep } from '../server/util.ts';
import { makeRepo, testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

describe('스크립트 버튼', () => {
  it('프로젝트 폴더에서 실행 · 출력이 흘러나오고 기록에 남음 · 실패 코드', async () => {
    const { store } = testEnv();
    const repo = makeRepo();
    const p = store.insertProject({ name: 'app', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const sr = new ScriptRunner(store);
    const chunks: string[] = [];
    const off = bus.onEvent((e) => { if (e.type === 'script_out') chunks.push(e.chunk); });
    const s = sr.save({ project_id: p.id, name: '위치', command: 'pwd; echo 끝' });
    const run = sr.run(s.id, 'remote');
    expect(() => sr.run(s.id, 'local')).toThrow(/이미/);
    await until(() => sr.getRun(run)?.finished_at != null);
    const r = sr.getRun(run)!;
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain(repo.split('/').pop());
    expect(r.output).toContain('끝');
    expect(r.by).toBe('remote');
    expect(chunks.join('')).toContain('끝');
    const bad = sr.save({ project_id: p.id, name: '실패', command: 'exit 3' });
    const r2 = sr.run(bad.id, 'local');
    await until(() => sr.getRun(r2)?.finished_at != null);
    expect(sr.getRun(r2)!.exit_code).toBe(3);
    expect(sr.list().find((x) => x.id === bad.id)!.last_run!.exit_code).toBe(3);
    off();
  });
  it('멈추기 · sudo 막힘 · 프로젝트 밖 폴더 막힘 · package.json 스크립트 찾기', async () => {
    const { store } = testEnv();
    const repo = makeRepo();
    mkdirSync(join(repo, 'api'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(repo, 'api', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const p = store.insertProject({ name: 'app', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const sr = new ScriptRunner(store);
    const long = sr.save({ project_id: p.id, name: '오래', command: 'sleep 30' });
    const run = sr.run(long.id, 'local');
    expect(sr.list().find((x) => x.id === long.id)!.running_run_id).toBe(run);
    expect(sr.stop(run)).toBe(true);
    await until(() => sr.getRun(run)?.finished_at != null);
    expect(sr.getRun(run)!.exit_code).not.toBe(0);
    const su = sr.save({ project_id: p.id, name: 'su', command: 'sudo ls' });
    expect(() => sr.run(su.id, 'local')).toThrow(/막힌/);
    const out = sr.save({ project_id: p.id, name: '밖', command: 'ls', cwd: '../..' });
    expect(() => sr.run(out.id, 'local')).toThrow(/프로젝트 밖/);
    expect(sr.npmScripts(repo)).toEqual([{ dir: '', name: 'build', command: 'tsc' }, { dir: 'api', name: 'test', command: 'jest' }]);
  });
});
