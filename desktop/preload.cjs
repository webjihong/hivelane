// 처음 실행 안내 화면(setup.html)에만 쓰는 다리. 관제실 화면(서버)에는 아무것도 내주지 않는다.
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
