import { describe, expect, it } from 'vitest';
import { parseServe } from '../server/remote.ts';

describe('원격 접속 상태(tailscale serve)', () => {
  it('원격 포트로 연결돼 있으면 주소를 만든다', () => {
    const r = parseServe({ Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4312' } } } } }, 4312);
    expect(r).toEqual({ serving: true, url: 'https://mac.tail1.ts.net', otherTargets: [], funnel: false });
  });
  it('다른 포트로만 연결·funnel 켜짐을 알아챈다', () => {
    const r = parseServe({ Web: { 'mac.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { 'mac.tail1.ts.net:8443': true } }, 4312);
    expect(r.serving).toBe(false);
    expect(r.otherTargets).toEqual(['http://127.0.0.1:3000']);
    expect(r.funnel).toBe(true);
  });
  it('serve 가 없으면 꺼짐', () => {
    expect(parseServe({}, 4312)).toEqual({ serving: false, url: null, otherTargets: [], funnel: false });
  });
});

import { localHostPort } from '../server/search/ollama.ts';
describe('Ollama 주소', () => {
  it('이 맥 주소만 Hivelane 이 켠다', () => {
    expect(localHostPort('http://127.0.0.1:11434')).toBe('127.0.0.1:11434');
    expect(localHostPort('http://localhost:12000/')).toBe('127.0.0.1:12000');
    expect(localHostPort('http://127.0.0.1')).toBe('127.0.0.1:11434');
    expect(localHostPort('http://gpu-box:11434')).toBeNull();
    expect(localHostPort('엉터리')).toBeNull();
  });
});
