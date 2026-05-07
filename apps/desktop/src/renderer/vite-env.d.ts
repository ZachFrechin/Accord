/// <reference types="vite/client" />

interface Window {
  discord2Desktop?: {
    platform: NodeJS.Platform;
    isSecureStorageAvailable: () => Promise<boolean>;
    encryptString: (value: string) => Promise<string>;
    decryptString: (value: string) => Promise<string>;
  };
}
