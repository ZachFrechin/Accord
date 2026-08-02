/**
 * Encrypted backup of the local MLS history. MLS plaintext is device-bound
 * (forward secrecy: the server's frames can never be re-decrypted), so a lost
 * machine means lost history — unless it was exported. The backup is the whole
 * instance's decrypted history, sealed under a passphrase:
 *
 *   "ACCB1" ‖ salt(16) ‖ iv(12) ‖ AES-256-GCM(JSON payload)
 *
 * with the key derived via PBKDF2-SHA256 (600k iterations — the OWASP web
 * baseline; WebCrypto only, no native dependency). Import merges by message id
 * (IndexedDB put), so re-importing or overlapping backups is idempotent.
 */

import { appendMlsMessages, loadInstanceMlsHistory } from "./mls/mlsHistory";
import type { DecryptedMessage } from "../stores/useMessagesStore";

const MAGIC = new TextEncoder().encode("ACCB1");
const PBKDF2_ITERS = 600_000;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function exportHistory(
  instanceId: string,
  passphrase: string,
): Promise<{ blob: Blob; messages: number; conversations: number }> {
  const corpus = await loadInstanceMlsHistory(instanceId);
  const conversations: Record<string, DecryptedMessage[]> = {};
  let messages = 0;
  for (const [convId, msgs] of corpus) {
    conversations[convId] = msgs;
    messages += msgs.length;
  }
  const payload = new TextEncoder().encode(
    JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), conversations }),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, payload),
  );
  const out = new Uint8Array(MAGIC.length + 16 + 12 + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + 16);
  out.set(ciphertext, MAGIC.length + 28);
  return {
    blob: new Blob([out], { type: "application/octet-stream" }),
    messages,
    conversations: corpus.size,
  };
}

export async function importHistory(
  instanceId: string,
  file: File,
  passphrase: string,
): Promise<{ messages: number; conversations: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = MAGIC.length;
  if (bytes.length < head + 28 || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error("Ce fichier n'est pas une sauvegarde Accord.");
  }
  const salt = bytes.slice(head, head + 16);
  const iv = bytes.slice(head + 16, head + 28);
  const ciphertext = bytes.slice(head + 28);
  const key = await deriveKey(passphrase, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext,
    );
  } catch {
    throw new Error("Phrase secrète incorrecte (ou fichier corrompu).");
  }
  const data = JSON.parse(new TextDecoder().decode(plaintext)) as {
    v: number;
    conversations: Record<string, DecryptedMessage[]>;
  };
  if (data.v !== 1 || !data.conversations) throw new Error("Format de sauvegarde inconnu.");
  let messages = 0;
  let conversations = 0;
  for (const [convId, msgs] of Object.entries(data.conversations)) {
    if (!Array.isArray(msgs) || msgs.length === 0) continue;
    await appendMlsMessages(instanceId, convId, msgs); // put-by-id → idempotent merge
    messages += msgs.length;
    conversations += 1;
  }
  return { messages, conversations };
}
