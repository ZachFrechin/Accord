/** True when running inside the Tauri desktop shell (vs a plain browser/dev). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
