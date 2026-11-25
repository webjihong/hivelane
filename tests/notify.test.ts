import { describe, expect, it } from 'vitest';
import { skipForDesktop } from '../server/notify/index.ts';

describe('맥 앱이 켜져 있을 때 웹 푸시', () => {
  it('맥 브라우저 구독만 건너뛰고 휴대폰은 보낸다', () => {
    expect(skipForDesktop('Macintosh · Chrome', 1)).toBe(true);
    expect(skipForDesktop('Android · Chrome', 1)).toBe(false);
    expect(skipForDesktop('iPhone · Safari', 2)).toBe(false);
    expect(skipForDesktop('Macintosh · Chrome', 0)).toBe(false);
  });
});
