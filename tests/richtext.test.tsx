import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichText } from '../web/src/ui.tsx';

describe('보고 렌더링', () => {
  it('결론 강조 · 목록 · 표 · 코드', () => {
    const html = renderToStaticMarkup(createElement(RichText, { text: '**결론: 주문서 만들 때 정해진다.**\n\n- 판정: `MyShopApp/` 있으면 APP\n- 저장: INSERT 한 번\n\n| 경우 | 결과 |\n|---|---|\n| 앱 | APP |\n\n(코드는 고치지 않음)' }));
    expect(html).toContain('<p class="rt-lead"><span><b>결론: 주문서 만들 때 정해진다.</b></span></p>');
    expect(html).toContain('<ul><li>판정: <code>MyShopApp/</code> 있으면 APP</li><li>저장: INSERT 한 번</li></ul>');
    expect(html).toContain('<thead><tr><th>경우</th><th>결과</th></tr></thead><tbody><tr><td>앱</td><td>APP</td></tr></tbody>');
    expect(html).toContain('<p><span>(코드는 고치지 않음)</span></p>');
  });
  it('예전 형식(긴 문단)도 그대로 보인다', () => {
    const html = renderToStaticMarkup(createElement(RichText, { text: '질문 답변만 했고 코드는 고치지 않음. 주문이 앱 주문인지는…' }));
    expect(html).toBe('<div class="rt"><p><span>질문 답변만 했고 코드는 고치지 않음. 주문이 앱 주문인지는…</span></p></div>');
  });
});

describe('긴 문단 문장 나누기', () => {
  it('문장 끝에서 나누고 소수점·짧은 문단은 그대로', async () => {
    const { splitSentences } = await import('../web/src/ui.tsx');
    const long = '질문 답변만 했고 코드는 고치지 않음. 주문이 앱 주문인지는 결제 완료 때가 아니라 주문서를 만드는 요청(POST /orders, createOrder) 때 정해진다. 그 요청의 User-Agent 끝에 MyShopApp/<버전> 이 붙어 있으면 APP, 아니면 WEB 이다. 버전 1.5 처럼 소수점은 안 나눈다. 채널 없이 만든 주문은 미상으로 집계된다.';
    const s = splitSentences(long);
    expect(s).toHaveLength(5);
    expect(s[0]).toBe('질문 답변만 했고 코드는 고치지 않음.');
    expect(s[3]).toBe('버전 1.5 처럼 소수점은 안 나눈다.');
    expect(splitSentences('짧다. 그대로다.')).toEqual(['짧다. 그대로다.']);
  });
});

describe('링크', () => {
  it('[글](주소)는 링크로, 맨 주소도 링크로, 위험한 주소는 글자만', () => {
    const html = renderToStaticMarkup(createElement(RichText, { text: '- [KOMOJU 조사](https://en.komoju.com/news/x-2024/)\n- 출처 https://isdown.app/status/komoju. 끝\n- [나쁜](javascript:alert(1))' }));
    expect(html).toContain('<li><a href="https://en.komoju.com/news/x-2024/" target="_blank" rel="noreferrer">KOMOJU 조사</a></li>');
    expect(html).toContain('출처 <a href="https://isdown.app/status/komoju" target="_blank" rel="noreferrer">https://isdown.app/status/komoju</a>. 끝');
    expect(html).not.toContain('javascript:');
  });
});
