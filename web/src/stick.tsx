import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 대화창 아래 붙이기: 맨 아래를 보고 있으면 내용이 늘 때(새 답·긴 글·이미지 로드·입력칸 높이 변화) 계속 아래로.
 * 위로 올려 읽는 중이면 그대로 두고 「새 메시지 ↓」를 띄운다.
 */
export function useStickToBottom(ref: RefObject<HTMLDivElement | null>, ready = true): { onScroll: () => void; stickNow: () => void; newBelow: boolean; jump: () => void } {
  const stick = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const toBottom = useCallback(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    toBottom();
    const onGrow = () => { if (stick.current) toBottom(); else setNewBelow(true); };
    const mo = new MutationObserver(onGrow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); });
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    // 이미지는 늦게 커진다
    const onLoad = (e: Event) => { if ((e.target as HTMLElement).tagName === 'IMG' && stick.current) toBottom(); };
    el.addEventListener('load', onLoad, true);
    return () => { mo.disconnect(); ro.disconnect(); el.removeEventListener('load', onLoad, true); };
  }, [ref, toBottom, ready]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stick.current) setNewBelow(false);
  }, [ref]);
  const stickNow = useCallback(() => { stick.current = true; setNewBelow(false); requestAnimationFrame(toBottom); }, [toBottom]);
  return { onScroll, stickNow, newBelow, jump: stickNow };
}

export function NewBelow({ show, onClick }: { show: boolean; onClick: () => void }) {
  return show ? <button type="button" className="new-below" onClick={onClick}>새 메시지 ↓</button> : null;
}
