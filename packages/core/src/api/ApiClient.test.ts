import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://api.test";

/** A Map-backed `localStorage` shim (vitest runs in the node environment). */
function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
  return map;
}

/** Fresh, shared module graph: ApiClient and secureStore see the same state. */
async function freshModules() {
  vi.resetModules();
  const secure = await import("../lib/secureStore");
  const { ApiClient } = await import("./ApiClient");
  return { ...secure, ApiClient };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

const authHeader = (init?: RequestInit) => new Headers(init?.headers).get("authorization");

describe("ApiClient token flow", () => {
  beforeEach(() => {
    installLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints a fresh access token up front when only a refresh token is present", async () => {
    const { secureStore, hydrateSecureStore, ApiClient } = await freshModules();
    localStorage.setItem("accord.rt.i", "R0");
    await hydrateSecureStore(["i"]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${BASE}/auth/refresh`) {
        return jsonResponse(200, { access_token: "A1", refresh_token: "R1" });
      }
      if (url === `${BASE}/data`) {
        expect(authHeader(init)).toBe("Bearer A1");
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAuthLost = vi.fn();
    const res = await new ApiClient("i", BASE, onAuthLost).request<{ ok: boolean }>("/data");

    expect(res).toEqual({ ok: true });
    // Refresh happened BEFORE the data call (no guaranteed-401 round trip).
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${BASE}/auth/refresh`, `${BASE}/data`]);
    // Rotated tokens are persisted (refresh) / cached (access).
    expect(secureStore.get("i")).toEqual({ accessToken: "A1", refreshToken: "R1" });
    expect(localStorage.getItem("accord.rt.i")).toBe("R1");
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it("refreshes and replays once on a 401", async () => {
    const { secureStore, ApiClient } = await freshModules();
    secureStore.set("i", { accessToken: "A0", refreshToken: "R0" });

    let dataCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${BASE}/auth/refresh`) {
        return jsonResponse(200, { access_token: "A1", refresh_token: "R1" });
      }
      if (url === `${BASE}/data`) {
        dataCalls += 1;
        if (dataCalls === 1) {
          expect(authHeader(init)).toBe("Bearer A0");
          return jsonResponse(401, { error: { code: "unauthorized" } });
        }
        expect(authHeader(init)).toBe("Bearer A1");
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await new ApiClient("i", BASE, vi.fn()).request<{ ok: boolean }>("/data");

    expect(res).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/data`,
      `${BASE}/auth/refresh`,
      `${BASE}/data`,
    ]);
    expect(secureStore.get("i")).toEqual({ accessToken: "A1", refreshToken: "R1" });
  });

  it("clears tokens and signals auth loss when the refresh fails", async () => {
    const { secureStore, ApiClient } = await freshModules();
    secureStore.set("i", { accessToken: "A0", refreshToken: "R0" });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${BASE}/auth/refresh`) return jsonResponse(401, { error: { code: "invalid_grant" } });
      if (url === `${BASE}/data`) return jsonResponse(401, { error: { code: "unauthorized" } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAuthLost = vi.fn();
    const client = new ApiClient("i", BASE, onAuthLost);

    await expect(client.request("/data")).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(secureStore.get("i")).toBeNull();
    expect(localStorage.getItem("accord.rt.i")).toBeNull();
  });

  // Le contraire du test précédent, et le plus important des deux : une panne
  // serveur ne doit PAS détruire la session. Elle l'était, et comme le jeton
  // était effacé du trousseau, la déconnexion survivait au retour du serveur —
  // « on se fait perma déconnecter ». Un redéploiement suffisait.
  it("garde la session quand le serveur est en panne (5xx)", async () => {
    const { secureStore, ApiClient } = await freshModules();
    secureStore.set("i", { accessToken: "A0", refreshToken: "R0" });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${BASE}/auth/refresh`) return jsonResponse(503, { error: { code: "unavailable" } });
      if (url === `${BASE}/data`) return jsonResponse(401, { error: { code: "unauthorized" } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAuthLost = vi.fn();
    const client = new ApiClient("i", BASE, onAuthLost);

    await expect(client.request("/data")).rejects.toThrow();
    expect(onAuthLost).not.toHaveBeenCalled();
    // Le jeton survit : au retour du serveur, la session repart sans reconnexion.
    expect(secureStore.get("i")?.refreshToken).toBe("R0");
  });
});
