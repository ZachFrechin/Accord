export async function isSecureStorageAvailable(): Promise<boolean> {
  return window.discord2Desktop?.isSecureStorageAvailable() ?? false;
}

export async function encryptString(value: string): Promise<string> {
  if (!window.discord2Desktop?.encryptString) {
    throw new Error('Secure storage is not available.');
  }

  return window.discord2Desktop.encryptString(value);
}

export async function decryptString(value: string): Promise<string> {
  if (!window.discord2Desktop?.decryptString) {
    throw new Error('Secure storage is not available.');
  }

  return window.discord2Desktop.decryptString(value);
}
