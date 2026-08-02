/**
 * Message-level E2EE orchestration: turn a plaintext content object into the
 * per-device encrypted payload the backend stores, and back. The server only
 * ever sees the ciphertext + wrapped keys produced here.
 */

import type {
  ApiClient,
  KeyBundle,
  MessageDto,
  RecipientKeyDto,
  SendMessagePayload,
} from "../api/ApiClient";
import * as crypto from "./crypto";
import type { DeviceIdentity } from "./deviceIdentity";

/** A message's plaintext content, JSON-encoded inside the E2EE envelope. */
export interface MessageContent {
  text?: string;
  attachments?: AttachmentRef[];
}

/** Reference to an encrypted attachment blob (the file key rides in the E2EE body). */
export interface AttachmentRef {
  blob_id: string;
  key: string; // base64 file key
  nonce: string; // base64 file nonce
  name: string;
  size: number;
  mime: string;
}

// Short-lived cache of device-key bundles to avoid refetching per message.
const bundleCache = new Map<string, { at: number; bundle: KeyBundle }>();
const BUNDLE_TTL_MS = 60_000;

async function getBundle(client: ApiClient, userId: string): Promise<KeyBundle> {
  const cached = bundleCache.get(userId);
  if (cached && Date.now() - cached.at < BUNDLE_TTL_MS) return cached.bundle;
  const bundle = await client.keyBundle(userId);
  bundleCache.set(userId, { at: Date.now(), bundle });
  return bundle;
}

/** Drops a user's cached bundle (e.g. after a device add/revoke event). */
export function invalidateBundle(userId: string): void {
  bundleCache.delete(userId);
}

/** Clears the whole bundle cache (call on instance switch — it is module-level). */
export function clearBundleCache(): void {
  bundleCache.clear();
}

/** The authenticated plaintext envelope. `cid`/`sid` bind the ciphertext to its
 * conversation and sender so a malicious server cannot relocate/replay it into
 * another conversation or attribute it to a different sender undetected. */
interface Envelope extends MessageContent {
  v: 1;
  cid: string;
  sid: string;
}

/** Encrypts a content object once, wrapping the message key for every device of
 * every member (including the sender's own devices, so they can read it back).
 * The envelope binds the conversation id + sender id. */
export async function encryptForMembers(
  client: ApiClient,
  identity: DeviceIdentity,
  conversationId: string,
  senderId: string,
  memberIds: string[],
  content: MessageContent,
): Promise<SendMessagePayload> {
  const envelope: Envelope = { v: 1, cid: conversationId, sid: senderId, ...content };
  const plaintext = crypto.utf8ToBytes(JSON.stringify(envelope));
  const { ciphertext, nonce, messageKey } = crypto.encryptBody(plaintext);

  const recipients: RecipientKeyDto[] = [];
  for (const userId of memberIds) {
    const bundle = await getBundle(client, userId);
    for (const device of bundle.devices) {
      const wrapped = crypto.wrapKeyForDevice(
        messageKey,
        crypto.fromBase64(device.public_key),
        identity.keyPair.privateKey,
      );
      recipients.push({
        user_id: userId,
        device_id: device.device_id,
        wrapped_key: crypto.toBase64(wrapped.wrapped),
        wrap_nonce: crypto.toBase64(wrapped.nonce),
      });
    }
  }

  return {
    sender_device: identity.deviceId,
    ciphertext: crypto.toBase64(ciphertext),
    body_nonce: crypto.toBase64(nonce),
    recipients,
  };
}

/** Decrypts a message with THIS device's wrapped key, verifying the envelope's
 * bound conversation id + sender id. Returns null when the device has no key for
 * it (joined later), the sender key is unknown, the message is deleted, or the
 * envelope's context does not match (a relocated/replayed ciphertext) — the UI
 * renders those as placeholders.
 *
 * NOTE (threat model): the sender's public key comes from the server-provided
 * bundle with no client-side pinning, so a fully malicious server can still
 * impersonate a sender by swapping that key. End-to-end sender verification
 * (safety numbers / key transparency) arrives with MLS in Phase 3. Context
 * binding below closes the cross-conversation relocation/replay hole. */
export async function decryptMessage(
  client: ApiClient,
  identity: DeviceIdentity,
  conversationId: string,
  msg: MessageDto,
): Promise<MessageContent | null> {
  if (msg.deleted || !msg.ciphertext || !msg.body_nonce || !msg.wrapped_key || !msg.wrap_nonce) {
    return null;
  }
  if (!msg.sender_id) return null;

  const senderBundle = await getBundle(client, msg.sender_id);
  const senderDevice = senderBundle.devices.find((d) => d.device_id === msg.sender_device);
  if (!senderDevice) return null;

  try {
    const messageKey = crypto.unwrapKeyFromDevice(
      crypto.fromBase64(msg.wrapped_key),
      crypto.fromBase64(msg.wrap_nonce),
      crypto.fromBase64(senderDevice.public_key),
      identity.keyPair.privateKey,
    );
    const plaintext = crypto.decryptBody(
      crypto.fromBase64(msg.ciphertext),
      crypto.fromBase64(msg.body_nonce),
      messageKey,
    );
    const envelope = JSON.parse(crypto.bytesToUtf8(plaintext)) as Envelope;
    // Reject a ciphertext relocated to another conversation or re-attributed.
    if (envelope.cid !== conversationId || envelope.sid !== msg.sender_id) return null;
    return { text: envelope.text, attachments: envelope.attachments };
  } catch {
    return null;
  }
}

/** Encrypts a file with a fresh key and uploads the ciphertext to storage,
 * returning a reference (with the key) to embed in the E2EE message body. */
export async function encryptAndUpload(
  client: ApiClient,
  conversationId: string,
  file: File,
): Promise<AttachmentRef> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { ciphertext, nonce, messageKey } = crypto.encryptBody(bytes);
  const ticket = await client.requestUpload(conversationId, ciphertext.length);
  const put = await fetch(ticket.upload_url, { method: "PUT", body: ciphertext });
  if (!put.ok) throw new Error(`attachment upload failed (${put.status})`);
  return {
    blob_id: ticket.blob_id,
    key: crypto.toBase64(messageKey),
    nonce: crypto.toBase64(nonce),
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
}

/** Downloads an attachment's ciphertext and decrypts it to the original bytes. */
export async function downloadAndDecrypt(
  client: ApiClient,
  ref: AttachmentRef,
): Promise<Uint8Array> {
  const ticket = await client.downloadUrl(ref.blob_id);
  const res = await fetch(ticket.download_url);
  if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());
  return crypto.decryptBody(ciphertext, crypto.fromBase64(ref.nonce), crypto.fromBase64(ref.key));
}
