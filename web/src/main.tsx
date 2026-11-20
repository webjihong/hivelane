import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect, refreshChat, refreshState } from './store.ts';

const el = document.getElementById('root');
if (!el) throw new Error('#root 가 없습니다');
createRoot(el).render(<StrictMode><App /></StrictMode>);

void refreshState();
void refreshChat();
connect();

// 푸시 알림을 이미 켠 기기는 서비스 워커를 계속 등록해 둔다.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration('/sw.js').then((r) => { if (r) void r.update(); }).catch(() => {});
