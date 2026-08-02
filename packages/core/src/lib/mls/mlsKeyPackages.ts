/**
 * MLS KeyPackage publishing + replenishment (Phase 3 · Lot 2, client half).
 *
 * Keeps a device's directory pool topped up so its peers can add it to groups —
 * even while it is offline. All key material is generated inside the native
 * engine (`MlsEngine`); only the public KeyPackage bytes + their ref are pushed
 * to the server. The boot-time wiring (call this after sign-in) lands in Lot 4.
 */

import type { ApiClient, MlsKeyPackageDto } from "../../api/ApiClient";
import { type MlsEngine, mlsEngine } from "./MlsEngine";

/** Desired number of available single-use KeyPackages per device. */
const POOL_TARGET = 20;
/** Replenish once the available pool drops to this. */
const LOW_WATERMARK = 5;

async function generate(
  engine: MlsEngine,
  instanceId: string,
  count: number,
): Promise<MlsKeyPackageDto[]> {
  const out: MlsKeyPackageDto[] = [];
  for (let i = 0; i < count; i++) {
    const { keyPackage, kpRef } = await engine.generateKeyPackage(instanceId);
    out.push({ kp_ref: kpRef, key_package: keyPackage });
  }
  return out;
}

/**
 * Ensure this device has an MLS identity + a healthy KeyPackage pool published.
 * Idempotent: safe to call on every launch. Requires the native engine (Tauri).
 *
 * @param identity credential binding, e.g. `"${userId}:${deviceId}"`.
 */
export async function ensureMlsKeyPackages(
  client: ApiClient,
  instanceId: string,
  deviceId: string,
  identity: string,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  await engine.initIdentity(instanceId, identity); // idempotent — creates or loads

  const { available } = await client
    .keyPackageCount(deviceId)
    .catch(() => ({ device_id: deviceId, available: 0 }));
  if (available >= LOW_WATERMARK) return;

  const packages = await generate(engine, instanceId, POOL_TARGET - available);
  // Publish a fresh last-resort only when the pool was fully drained (first run).
  const lastResort = available === 0 ? (await generate(engine, instanceId, 1))[0] : undefined;
  await client.publishKeyPackages(deviceId, packages, lastResort);
}

/**
 * Claim one KeyPackage per device for every member being added to a group. Skips
 * devices with none published (the caller adds only the returned ones).
 */
export async function claimForMembers(
  client: ApiClient,
  members: { userId: string; deviceIds: string[] }[],
): Promise<{ userId: string; deviceId: string; keyPackage: string }[]> {
  const out: { userId: string; deviceId: string; keyPackage: string }[] = [];
  for (const m of members) {
    const { packages } = await client.claimKeyPackages(m.userId, m.deviceIds);
    for (const p of packages) {
      out.push({ userId: m.userId, deviceId: p.device_id, keyPackage: p.key_package });
    }
  }
  return out;
}
