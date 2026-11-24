import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthLogin, findUrl } from '../server/po/auth.ts';

/** claude auth login 흉내: 링크(OSC 8)를 찍고 코드 한 줄을 기다려 ok 면 성공 */
function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hl-auth-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh
printf 'Opening browser to sign in…\\nIf the browser didn'"'"'t open, visit:\\n\\033]8;;https://claude.ai/oauth/authorize?x=1\\007https://claude.ai/oauth/authorize?x=1\\033]8;;\\007\\nPaste code here if prompted > '
read code
[ "$code" = "ok-code" ] && { echo 'Login successful'; exit 0; }
echo 'bad code'; exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30)); };

describe('Claude 재인증(claude auth login 대행)', () => {
  it('OSC 8 링크에서 주소만 뽑는다', () => {
    expect(findUrl('visit:\n\u001b]8;;https://a.test/x?y=1\u0007https://a.test/x?y=1\u001b]8;;\u0007\n')).toBe('https://a.test/x?y=1');
  });
  it('링크를 보여 주고 코드를 넘기면 끝난다 · 틀린 코드는 실패', async () => {
    const bin = fakeClaude();
    let done = 0;
    const a = new AuthLogin({ bin, onDone: () => { done++; } });
    a.start();
    await until(() => !!a.view.url);
    expect(a.view.url).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(a.start().phase).toBe('waiting'); // 진행 중엔 새로 띄우지 않음
    a.code(' ok-code ');
    await until(() => a.view.phase !== 'waiting');
    expect(a.view.phase).toBe('done');
    expect(done).toBe(1);
    expect(() => a.code('x')).toThrow();

    a.start();
    await until(() => !!a.view.url);
    a.code('nope');
    await until(() => a.view.phase !== 'waiting');
    expect(a.view.phase).toBe('failed');
  });
  it('취소', async () => {
    const a = new AuthLogin({ bin: fakeClaude(), onDone: () => {} });
    a.start();
    await until(() => !!a.view.url);
    expect(a.cancel().phase).toBe('failed');
  });
});
