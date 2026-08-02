import { describe, expect, it } from "vitest";

import { fromBase64 } from "./crypto";
import {
  type Jwks,
  bindingLeaf,
  hashLeaf,
  hexToBytes,
  verifyConsistency,
  verifyInclusion,
  verifySth,
} from "./keyTransparency";

// Fixtures captured LIVE from the Rust backend's key-transparency endpoints, so
// these tests cross-check the TypeScript verifiers against an independent
// implementation of the RFC 6962 generator (matching bugs across both are unlikely).
const UID = "7700b309-3f46-4360-b23a-30046c3b022e";
const DEVICE = "kt-dev-1";
const PUBKEY_B64 = "HNyV7PiAkhYv/IfXBRdVMhlzFYlIBC+o0ZthgmLZkSM=";

const INC = {
  index: 0,
  size: 2,
  root: "2663a967a038d28a8632df4eb9b2d9fd580d2bb8c4cc3ce7dcac7c13f56de760",
  proof: ["e5aeb3ffe0300f05840d0172f7ee5cf6ebbf79b9b78761e63c1ff9829dbf3a4f"],
};

const CONS = {
  first: 1,
  firstRoot: "980c552ce9a8099fa8934fc73da4db7fcde637708ddde4193e75f17df557cb04",
  second: 2,
  secondRoot: "2663a967a038d28a8632df4eb9b2d9fd580d2bb8c4cc3ce7dcac7c13f56de760",
  proof: ["e5aeb3ffe0300f05840d0172f7ee5cf6ebbf79b9b78761e63c1ff9829dbf3a4f"],
};

const STH_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImFjY29yZC1lZDI1NTE5LWRldiJ9.eyJhdWQiOiJhY2NvcmQiLCJ0eXAiOiJrdC1zdGgiLCJzaXplIjoyLCJyb290IjoiMjY2M2E5NjdhMDM4ZDI4YTg2MzJkZjRlYjliMmQ5ZmQ1ODBkMmJiOGM0Y2MzY2U3ZGNhYzdjMTNmNTZkZTc2MCIsImlhdCI6MTc4NDMwNDI1NX0.M1-f5AZd5LkDB3nrCKW_a0jn-yWOtXluUy1oB2kjjhvgnDdyyMgRZxjqrJUlsXUPgmlWI_vpCR2FtJ3CgFDBCg";

const JWKS: Jwks = {
  keys: [{ kty: "OKP", crv: "Ed25519", kid: "accord-ed25519-dev", x: "r5Wlp-PLKKIwgoeCciRSI2KLSJ2jRYqhW7ja0l3pTeU" }],
};

describe("key-transparency client verifiers", () => {
  it("verifies a real inclusion proof and reconstructs the leaf like the server", async () => {
    const leaf = await hashLeaf(bindingLeaf(UID, DEVICE, fromBase64(PUBKEY_B64)));
    expect(await verifyInclusion(leaf, INC.index, INC.size, hexToBytes(INC.root), INC.proof.map(hexToBytes))).toBe(
      true,
    );
  });

  it("refuses to prove a substituted key under a valid proof", async () => {
    const evil = await hashLeaf(bindingLeaf(UID, DEVICE, new Uint8Array(32)));
    expect(await verifyInclusion(evil, INC.index, INC.size, hexToBytes(INC.root), INC.proof.map(hexToBytes))).toBe(
      false,
    );
  });

  it("verifies a real consistency proof and rejects a rewritten history", async () => {
    expect(
      await verifyConsistency(
        CONS.first,
        CONS.second,
        hexToBytes(CONS.firstRoot),
        hexToBytes(CONS.secondRoot),
        CONS.proof.map(hexToBytes),
      ),
    ).toBe(true);
    // A server that shows a different old root (rewrote history) is caught.
    expect(
      await verifyConsistency(
        CONS.first,
        CONS.second,
        hexToBytes("00".repeat(32)),
        hexToBytes(CONS.secondRoot),
        CONS.proof.map(hexToBytes),
      ),
    ).toBe(false);
  });

  it("verifies the STH's Ed25519 signature and reads its (size, root)", async () => {
    const sth = await verifySth(STH_JWT, JWKS);
    expect(sth).not.toBeNull();
    expect(sth?.size).toBe(2);
    expect(sth?.root).toEqual(hexToBytes(INC.root));
  });

  it("rejects an STH with a tampered signature", async () => {
    const flipped = STH_JWT.slice(0, -3) + (STH_JWT.endsWith("A") ? "B" : "A") + STH_JWT.slice(-2);
    expect(await verifySth(flipped, JWKS)).toBeNull();
  });
});
