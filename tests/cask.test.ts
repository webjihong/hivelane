import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bumpCask } from '../scripts/cask.ts';

describe('Homebrew cask', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'Casks', 'hivelane.rb'), 'utf8');
  it('지금 cask 는 package.json 버전과 같고, 릴리스 DMG 주소를 버전으로 만든다', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(src).toContain(`version "${pkg.version}"`);
    expect(src).toMatch(/sha256 "[0-9a-f]{64}"/);
    expect(src).toContain('releases/download/v#{version}/Hivelane-#{version}-arm64.dmg');
  });
  it('릴리스 때 version·sha256 줄만 바뀐다', () => {
    const out = bumpCask(src, '9.9.9', 'a'.repeat(64));
    expect(out).toContain('version "9.9.9"');
    expect(out).toContain(`sha256 "${'a'.repeat(64)}"`);
    expect(out.replace(/version "9.9.9"/, '').replace(/sha256 "a{64}"/, '')).toBe(src.replace(/version "[^"]*"/, '').replace(/sha256 "[^"]*"/, ''));
  });
});
