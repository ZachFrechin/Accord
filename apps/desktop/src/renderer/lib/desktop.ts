export async function isSecureStorageAvailable(): Promise<boolean> {
  return window.discord2Desktop?.isSecureStorageAvailable() ?? false;
}
