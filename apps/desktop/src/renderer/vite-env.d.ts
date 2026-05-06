/// <reference types="vite/client" />

interface Window {
  discord2Desktop?: {
    platform: NodeJS.Platform;
    isSecureStorageAvailable: () => Promise<boolean>;
  };
}
