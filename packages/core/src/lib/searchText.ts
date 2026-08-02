/** Accent- and case-insensitive form for on-device search matching: NFD
 * decomposition with combining marks stripped, lowercased. For NFC input (all
 * normal French text) the result keeps the original length, so indexes into it
 * remain usable against the source string for snippeting. */
export function searchNormalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
