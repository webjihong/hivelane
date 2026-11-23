import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { act, api, toast } from './store.ts';

interface Att { id: string; url: string; name: string }
const MAX = 10 * 1024 * 1024;

function toBase64(f: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
}

/**
 * 지시·질문 입력칸: Enter 보내기 · Shift+Enter 줄바꿈 · Esc/취소로 진행 중인 응답 취소 ·
 * 이미지 붙여넣기·끌어놓기·첨부(에이전트가 Read 도구로 본다).
 */
export function ChatInput({ placeholder, label, button = '보내기', working = false, onSend, onCancel, cancelLabel = '취소' }: {
  placeholder: string; label: string; button?: string; working?: boolean;
  onSend: (text: string) => Promise<boolean>; onCancel?: () => Promise<unknown>; cancelLabel?: string;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const grow = () => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; };
  const upload = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    for (const f of imgs) {
      if (f.size > MAX) { toast(`${f.name || '이미지'}: 10MB 를 넘습니다`, 'crit'); continue; }
      setUploading((n) => n + 1);
      const r = await act(async () => api<{ id: string; url: string }>('/api/uploads', 'POST', { type: f.type, data: await toBase64(f) }));
      setUploading((n) => n - 1);
      if (r) setAtts((a) => [...a, { id: r.id, url: r.url, name: f.name && f.name !== 'image.png' ? f.name : `이미지${a.length + 1}` }]);
    }
  };
  const send = async () => {
    const v = text.trim();
    if ((!v && !atts.length) || sending || uploading) return;
    const body = [v, ...atts.map((a) => `![${a.name}](${a.url})`)].filter(Boolean).join('\n\n');
    setSending(true);
    const ok = await onSend(body);
    setSending(false);
    if (ok) { setText(''); setAtts([]); requestAnimationFrame(grow); }
  };
  const cancel = async () => { if (onCancel && working) await onCancel(); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 글자 확정
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); return; }
    if (e.key === 'Escape') {
      if (working && onCancel) { e.preventDefault(); void cancel(); }
      else if (atts.length) { e.preventDefault(); setAtts([]); }
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void upload(files); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void upload([...e.dataTransfer.files]); };

  return (
    <div className={`ci${drag ? ' drag' : ''}`} onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      {(atts.length > 0 || uploading > 0) && (
        <div className="ci-atts">
          {atts.map((a) => (
            <div key={a.id} className="ci-att"><img src={a.url} alt={a.name} /><button type="button" className="ci-x" aria-label={`${a.name} 빼기`} onClick={() => setAtts((l) => l.filter((x) => x.id !== a.id))}>×</button></div>
          ))}
          {uploading > 0 && <div className="ci-att loading">올리는 중…</div>}
        </div>
      )}
      <div className="ci-row">
        <div className="ci-box">
          <textarea ref={ta} rows={1} value={text} placeholder={placeholder} aria-label={label} onChange={(e) => { setText(e.target.value); grow(); }} onKeyDown={onKey} onPaste={onPaste} />
          <button type="button" className="ci-clip" title="이미지 첨부 (붙여넣기·끌어놓기도 됨)" aria-label="이미지 첨부" onClick={() => file.current?.click()}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        {/* 진행 중이고 새로 쓴 게 없으면 보내기 자리에 취소. 쓰는 중이면 보내기(진행 중에도 추가 지시 가능) */}
        {working && onCancel && !text.trim() && !atts.length
          ? <button className="btn ci-send ci-cancel" type="button" onClick={() => void cancel()} title="Esc">{cancelLabel}</button>
          : <button className="btn primary ci-send" type="button" disabled={sending || uploading > 0 || (!text.trim() && !atts.length)} onClick={() => void send()}>{button}</button>}
      </div>
      <div className="ci-hint muted">Enter 보내기 · Shift+Enter 줄바꿈{onCancel ? ' · Esc 진행 취소' : ''} · 이미지 붙여넣기·끌어놓기</div>
    </div>
  );
}
