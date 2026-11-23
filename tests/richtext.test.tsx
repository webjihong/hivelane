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
