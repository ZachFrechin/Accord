import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('discord2Desktop', {
  platform: process.platform,
  isSecureStorageAvailable: () =>
    ipcRenderer.invoke('secure-storage:available') as Promise<boolean>,
});
