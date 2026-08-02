/** A backend error surfaced to the UI, carrying the stable machine code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Builds an [`ApiError`] from a non-OK response, reading `{error:{code,message}}`. */
export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      res.status,
      body.error?.code ?? "ERROR",
      body.error?.message ?? res.statusText,
    );
  } catch {
    return new ApiError(res.status, "ERROR", res.statusText || "Request failed");
  }
}

/** Derives the WebSocket origin from an http(s) base URL. */
export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^https?/i, (m) => (m.length === 5 ? "wss" : "ws"));
}
