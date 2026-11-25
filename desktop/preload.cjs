// 처음 실행 안내 화면(setup.html)용 다리. 관제실 화면(서버)에는 창 앞으로 가져오기 하나만 내준다(맥 알림을 눌렀을 때).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('hl', {
    status: () => ipcRenderer.invoke('hl:status'),
    install: () => ipcRenderer.invoke('hl:install'),
    tailscale: () => ipcRenderer.invoke('hl:tailscale'),
    open: () => ipcRenderer.invoke('hl:open'),
    link: (url) => ipcRenderer.invoke('hl:link', url),
    installCLT: () => ipcRenderer.invoke('hl:installCLT'),
  });
}

if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  contextBridge.exposeInMainWorld('hlDesktop', { focus: () => ipcRenderer.invoke('hl:focus') });
}
