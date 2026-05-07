import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('discord2Desktop', {
  platform: process.platform,
  isSecureStorageAvailable: () =>
    ipcRenderer.invoke('secure-storage:available') as Promise<boolean>,
  encryptString: (value: string) =>
    ipcRenderer.invoke('secure-storage:encrypt-string', value) as Promise<string>,
  decryptString: (value: string) =>
    ipcRenderer.invoke('secure-storage:decrypt-string', value) as Promise<string>,
});
