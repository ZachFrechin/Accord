/**
 * Unauthenticated auth calls (register / verify / login) against a specific
 * backend URL. Authenticated calls live on [`ApiClient`].
 */

import { ApiError, toApiError } from "./http";

/** The public user projection returned by the backend. */
export interface UserDto {
  id: string;
  username: string;
  email: string;
  email_verified: boolean;
  /** Instance-level role — `admin` unlocks the administration panel. */
  role: "member" | "admin";
}

/** The token pair issued on login/refresh. */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: UserDto;
}

/** A password-verified login that still needs a second factor (TOTP). */
export interface MfaChallenge {
  status: "totp_required";
  challenge: string;
  expires_in: number;
}

/** Login returns either the tokens or a 2FA challenge. */
export type LoginResult = TokenResponse | MfaChallenge;

/** Whether a login result still needs a TOTP / recovery code. */
export function isMfaChallenge(r: LoginResult): r is MfaChallenge {
  return "challenge" in r;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Probes that a URL points at a reachable Accord backend. */
export async function health(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl + "/health/live", { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Registers a new account. Returns nothing (202 verification_required). */
export async function register(
  baseUrl: string,
  input: { username: string; email: string; password: string },
): Promise<void> {
  await postJson<unknown>(baseUrl, "/auth/register", input);
}

/** Re-sends the verification email for a still-unverified account. Returns nothing
 * and reveals nothing (the server answers the same whether or not the address is
 * known / already verified). */
export async function resendVerification(baseUrl: string, email: string): Promise<void> {
  await postJson<unknown>(baseUrl, "/auth/resend-verification", { email });
}

/** Consumes an email-verification token, returning the one-time recovery codes. */
export async function verifyEmail(
  baseUrl: string,
  token: string,
): Promise<{ status: string; recovery_codes: string[] }> {
  return postJson(baseUrl, "/auth/verify-email", { token });
}

/** Signs in, returning the token pair. Throws [`ApiError`] on bad credentials
 * (401) or an unverified account (403). */
export async function login(
  baseUrl: string,
  input: { username_or_email: string; password: string },
): Promise<LoginResult> {
  return postJson<LoginResult>(baseUrl, "/auth/login", input);
}

/** Completes a 2FA login with the TOTP (or a one-time recovery) code. */
export async function verifyTotp(
  baseUrl: string,
  input: { challenge: string; code: string },
): Promise<TokenResponse> {
  return postJson<TokenResponse>(baseUrl, "/auth/login/totp", input);
}

/** Extracts a verification/reset token from a pasted link or a bare token. */
export function extractToken(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/[?&]token=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);
  // A bare token (no URL) is accepted as-is.
  return /\s/.test(trimmed) ? null : trimmed;
}

export { ApiError };
