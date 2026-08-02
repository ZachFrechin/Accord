/**
 * Authenticated API client, one per instance.
 *
 * Injects the instance's access token, and on a 401 does a single-flight refresh
 * (`POST /auth/refresh`) then replays the request once. Tokens live in
 * `secureStore`, keyed by instance id, so switching instances never crosses
 * credentials.
 */

import { secureStore } from "../lib/secureStore";
import type { PresenceStatus } from "../realtime/wireSchema";
import type { TokenResponse, UserDto } from "./auth";
import { toApiError } from "./http";

// ── Administration DTOs ──────────────────────────────────────────────────────

/** Instance-wide counters (`GET /admin/stats`). */
export interface AdminStats {
  users_total: number;
  users_active: number;
  users_disabled: number;
  admins: number;
  /** Approximate — live presence sets in Redis. */
  users_online: number;
  conversations: number;
  messages: number;
  attachments: number;
  attachment_bytes: number;
  db_bytes: number;
  version: string;
}
/** A user as managed from the admin panel. */
export interface AdminUserDto {
  id: string;
  username: string;
  email: string;
  display_name: string | null;
  role: "member" | "admin";
  email_verified: boolean;
  disabled: boolean;
  created_at: string;
  /** Custom role ids assigned to this user (details via adminRoles()). */
  role_ids: string[];
}

/** A custom instance role (permission bits: see AdminPermission). */
export interface AdminRole {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
}

/** Permission bits carried by custom roles (mirror of the backend). */
export const AdminPermission = {
  PANEL: 1 << 0,
  MANAGE_USERS: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MODERATE: 1 << 3,
  EDIT_PROFILES: 1 << 4,
  VIEW_AUDIT: 1 << 5,
} as const;

/** The caller's effective instance capabilities (GET /admin/me — never 403s). */
export interface AdminMe {
  is_admin: boolean;
  permissions: number;
}

/** A linked game account with its last known rank. */
export interface GameAccount {
  game: string;
  external_name: string;
  /** Only present on the OWNER's own reads. */
  external_id?: string;
  region: string | null;
  rank: Record<string, unknown>;
  rank_updated_at: string | null;
}
export interface GameAccountsMine {
  accounts: GameAccount[];
  /** Which games have a server-side API key configured. */
  configured: Record<string, boolean>;
}

/** Instance leveling: a user's XP and computed level. */
export interface LevelDto {
  xp: number;
  level: number;
  level_floor: number;
  next_level_at: number;
}
export interface LeaderboardEntry {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  xp: number;
  level: number;
}
export interface LeaderboardResponse {
  items: LeaderboardEntry[];
  period: string;
}

/** One administration audit entry. */
export interface AuditEntry {
  id: string;
  actor_id: string;
  actor_username: string | null;
  action: string;
  target_id: string | null;
  target_username: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  per_page: number;
}
export interface AdminUserPage {
  items: AdminUserDto[];
  total: number;
  page: number;
  per_page: number;
}

/** A session as returned by `GET /auth/sessions`. */
export interface SessionDto {
  id: string;
  device_label: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string;
  current: boolean;
}

// ── Messaging DTOs (mirror the backend JSON shapes) ──────────────────────────

export interface FriendUser {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  presence?: PresenceStatus;
  /** Custom free-text status (accepted friends only; null/absent when unset). */
  status_text?: string | null;
}
export interface FriendsResponse {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
  blocked: FriendUser[];
}
/** A user's public profile. */
export interface ProfileDto {
  user_id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  accent_color: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  /** Instance root admin (crown badge). */
  is_admin?: boolean;
  /** Custom instance roles, highest first (badges — no permission bits). */
  roles?: { id: string; name: string; color: string | null }[];
}
export interface DeviceKeyDto {
  device_id: string;
  public_key: string;
  created_at: string;
}
export interface KeyBundle {
  user_id: string;
  devices: DeviceKeyDto[];
}
/** One published MLS KeyPackage: its base64 hash ref + opaque public bytes. */
export interface MlsKeyPackageDto {
  kp_ref: string;
  key_package: string;
}
export interface ClaimedKeyPackage {
  device_id: string;
  key_package: string;
  last_resort: boolean;
}
export interface ClaimKeyPackagesResponse {
  user_id: string;
  packages: ClaimedKeyPackage[];
}
/** A Welcome to deliver to a specific device when committing an add. */
export interface MlsWelcomeSend {
  user_id: string;
  device_id: string;
  welcome: string;
}
/** One ordered frame in a group's log. */
export interface MlsFrameDto {
  order_seq: number;
  epoch: number;
  content_type: "commit" | "proposal" | "application";
  sender_id: string | null;
  frame: string;
}
/** A pending Welcome pulled from the mailbox. */
export interface MlsWelcomeDto {
  /** Present on servers with ack support — used to confirm the join attempt. */
  id?: string;
  group_id: string;
  welcome: string;
}
/** Server answer to the (idempotent) group-create call. `created` is the
 * creation ARBITRATION: exactly one device ever gets `true` per group — only it
 * may build the root MLS group locally. Optional fields = older server. */
export interface MlsGroupStatus {
  status: string;
  created?: boolean;
  current_epoch?: number;
  order_seq?: number;
}
export interface ConversationDto {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  /** E2EE envelope format (Phase 3 cutover flag): legacy X25519 or MLS. */
  protocol: "x25519" | "mls";
  created_at: string;
  unread: number;
  /** This member's read marker (ISO), for the unread divider. */
  last_read_at?: string | null;
  /** Group description (admin-editable), if any. */
  description?: string | null;
  /** Group avatar public URL (versioned; null = none). */
  avatar_url?: string | null;
}
export interface MemberDto {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  role: "admin" | "member";
}
/** One aggregated emoji reaction bucket for a message. */
export interface ReactionDto {
  emoji: string;
  count: number;
  me: boolean;
}
export interface MessageDto {
  id: string;
  sender_id: string | null;
  sender_device: string;
  ciphertext: string | null;
  body_nonce: string | null;
  wrapped_key: string | null;
  wrap_nonce: string | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reply_to?: string | null;
  reactions?: ReactionDto[];
}
export interface MessagePage {
  messages: MessageDto[];
  next_cursor: string | null;
}
export interface RecipientKeyDto {
  user_id: string;
  device_id: string;
  wrapped_key: string;
  wrap_nonce: string;
}
export interface SendMessagePayload {
  sender_device: string;
  ciphertext: string;
  body_nonce: string;
  recipients: RecipientKeyDto[];
  /** Optional parent message id this replies to (metadata; server stays blind). */
  reply_to?: string | null;
}
export interface EditMessagePayload {
  ciphertext: string;
  body_nonce: string;
  recipients: RecipientKeyDto[];
}
export interface UploadTicket {
  blob_id: string;
  upload_url: string;
  expires_in: number;
}
export interface DownloadTicket {
  download_url: string;
  expires_in: number;
}

// Single-flight refresh keyed by instanceId, shared across ALL ApiClient
// instances for that instance. Refresh tokens are single-use with reuse
// detection (RFC 9700): two clients refreshing the same token concurrently — e.g.
// React StrictMode's double-mount, or a burst of requests on reload — would trip
// reuse detection and revoke the whole session family, logging the user out.
const inFlightRefresh = new Map<string, Promise<string | null>>();

export class ApiClient {
  constructor(
    public readonly instanceId: string,
    public readonly baseUrl: string,
    private readonly onAuthLost: () => void,
    /** Fired with the fresh user projection on every token refresh — lets the
     * app keep the stored account (email, role…) in sync server-side. */
    private readonly onUser?: (user: UserDto) => void,
  ) {}

  /** Performs an authenticated request, refreshing + replaying once on a 401. */
  async request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
    let tokens = secureStore.get(this.instanceId);
    // After a restart the access token is gone (memory-only) but the refresh
    // token persists — mint a fresh access token up front instead of forcing a
    // guaranteed 401 round-trip.
    if (allowRetry && tokens?.refreshToken && !tokens.accessToken) {
      await this.refresh();
      tokens = secureStore.get(this.instanceId);
    }
    const res = await fetch(this.baseUrl + path, this.withAuth(init, tokens?.accessToken));

    if (res.status === 401 && allowRetry && tokens?.refreshToken) {
      const access = await this.refresh();
      if (access) return this.request<T>(path, init, false);
    }
    if (!res.ok) throw await toApiError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** POST/PATCH/PUT helper that JSON-encodes the body (request() does not). */
  private send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private withAuth(init: RequestInit, access?: string): RequestInit {
    const headers = new Headers(init.headers);
    if (access) headers.set("authorization", `Bearer ${access}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return { ...init, headers };
  }

  /** Exchanges the refresh token for a fresh pair. Concurrent callers — across
   * every ApiClient for this instance — share ONE request (module-level
   * single-flight), so the single-use refresh token is never submitted twice. On
   * failure the instance's tokens are cleared and `onAuthLost` fires. */
  refresh(): Promise<string | null> {
    const existing = inFlightRefresh.get(this.instanceId);
    if (existing) return existing;
    const promise = this.doRefresh().finally(() => inFlightRefresh.delete(this.instanceId));
    inFlightRefresh.set(this.instanceId, promise);
    return promise;
  }

  private async doRefresh(): Promise<string | null> {
    const tokens = secureStore.get(this.instanceId);
    if (!tokens?.refreshToken) return null;
    const res = await fetch(this.baseUrl + "/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    });
    if (!res.ok) {
      secureStore.clear(this.instanceId);
      this.onAuthLost();
      return null;
    }
    const data = (await res.json()) as TokenResponse;
    secureStore.set(this.instanceId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    });
    this.onUser?.(data.user);
    return data.access_token;
  }

  // ── Administration (admin role required) ────────────────────────────────────
  adminStats(): Promise<AdminStats> {
    return this.request<AdminStats>("/admin/stats");
  }
  adminUsers(params: { q?: string; page?: number; perPage?: number } = {}): Promise<AdminUserPage> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.page) qs.set("page", String(params.page));
    if (params.perPage) qs.set("per_page", String(params.perPage));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return this.request<AdminUserPage>(`/admin/users${suffix}`);
  }
  adminRoles(): Promise<{ roles: AdminRole[] }> {
    return this.request("/admin/roles");
  }
  adminCreateRole(body: {
    name: string;
    color?: string | null;
    position?: number;
    permissions: number;
  }): Promise<AdminRole> {
    return this.send("POST", "/admin/roles", body);
  }
  adminUpdateRole(
    id: string,
    body: { name: string; color?: string | null; position?: number; permissions: number },
  ): Promise<{ status: string }> {
    return this.send("PATCH", `/admin/roles/${id}`, body);
  }
  adminDeleteRole(id: string): Promise<{ status: string }> {
    return this.request(`/admin/roles/${id}`, { method: "DELETE" });
  }
  adminSetUserRoles(userId: string, roleIds: string[]): Promise<{ status: string }> {
    return this.send("PUT", `/admin/users/${userId}/roles`, { role_ids: roleIds });
  }
  adminUpdateUser(
    id: string,
    patch: {
      role?: "member" | "admin";
      disabled?: boolean;
      /** Empty string clears the display name. Requires EDIT_PROFILES. */
      display_name?: string;
      /** Requires EDIT_PROFILES; 409 if taken. */
      username?: string;
    },
  ): Promise<AdminUserDto> {
    return this.send<AdminUserDto>("PATCH", `/admin/users/${id}`, patch);
  }
  /** The caller's own capabilities — safe for any user (0 bits for members). */
  adminMe(): Promise<AdminMe> {
    return this.request<AdminMe>("/admin/me");
  }
  adminAudit(params: { page?: number; perPage?: number } = {}): Promise<AuditPage> {
    const qs = new URLSearchParams();
    if (params.page) qs.set("page", String(params.page));
    if (params.perPage) qs.set("per_page", String(params.perPage));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return this.request<AuditPage>(`/admin/audit${suffix}`);
  }
  /** Moderation: hide an E2EE message everywhere by its client-local mls: ref. */
  moderateTombstone(conversationId: string, messageRef: string): Promise<{ status: string }> {
    return this.send("POST", `/conversations/${conversationId}/moderation/tombstone`, {
      message_ref: messageRef,
    });
  }
  /** Moderation tombstones to replay after loading local MLS history. */
  mlsTombstones(conversationId: string): Promise<{ refs: string[] }> {
    return this.request(`/conversations/${conversationId}/mls/tombstones`);
  }

  // ── Comptes de jeu (rangs de profil) ────────────────────────────────────────
  gamesMine(): Promise<GameAccountsMine> {
    return this.request<GameAccountsMine>("/games/accounts");
  }
  userGames(userId: string): Promise<{ accounts: GameAccount[] }> {
    return this.request(`/users/${userId}/games`);
  }
  linkGame(
    game: string,
    body: { riot_id?: string; platform?: string; nickname?: string },
  ): Promise<GameAccount> {
    return this.send<GameAccount>("PUT", `/games/accounts/${game}`, body);
  }
  refreshGame(game: string): Promise<GameAccount> {
    return this.send<GameAccount>("POST", `/games/accounts/${game}/refresh`, {});
  }
  unlinkGame(game: string): Promise<{ status: string }> {
    return this.request(`/games/accounts/${game}`, { method: "DELETE" });
  }

  // ── Niveaux d'instance ──────────────────────────────────────────────────────
  levelsMe(): Promise<LevelDto> {
    return this.request<LevelDto>("/levels/me");
  }
  userLevel(userId: string): Promise<LevelDto> {
    return this.request<LevelDto>(`/levels/users/${userId}`);
  }
  leaderboard(period: "all" | "week" = "all", limit = 50): Promise<LeaderboardResponse> {
    return this.request<LeaderboardResponse>(
      `/levels/leaderboard?period=${period}&limit=${limit}`,
    );
  }

  // ── Sessions ────────────────────────────────────────────────────────────────
  sessions(): Promise<SessionDto[]> {
    return this.request<SessionDto[]>("/auth/sessions");
  }
  revokeSession(id: string): Promise<void> {
    return this.request<void>(`/auth/sessions/${id}`, { method: "DELETE" });
  }
  revokeAllSessions(): Promise<void> {
    return this.request<void>("/auth/sessions/revoke-all", { method: "POST" });
  }
  logout(): Promise<void> {
    return this.request<void>("/auth/logout", { method: "POST" });
  }
  wsTicket(): Promise<{ ticket: string; expires_in: number }> {
    return this.request("/ws/ticket", { method: "POST" });
  }

  // ── Friends ─────────────────────────────────────────────────────────────────
  friends(): Promise<FriendsResponse> {
    return this.request<FriendsResponse>("/friends");
  }
  sendFriendRequest(username: string): Promise<{ status: string }> {
    return this.send("POST", "/friends/requests", { username });
  }
  acceptFriend(userId: string): Promise<{ status: string }> {
    return this.send("POST", `/friends/requests/${userId}/accept`);
  }
  declineFriend(userId: string): Promise<{ status: string }> {
    return this.send("POST", `/friends/requests/${userId}/decline`);
  }
  blockFriend(userId: string): Promise<{ status: string }> {
    return this.send("POST", `/friends/${userId}/block`);
  }
  removeFriend(userId: string): Promise<{ status: string }> {
    return this.request(`/friends/${userId}`, { method: "DELETE" });
  }

  // ── Device keys ─────────────────────────────────────────────────────────────
  publishDeviceKey(deviceId: string, publicKey: string): Promise<{ status: string }> {
    return this.send("POST", "/keys/devices", { device_id: deviceId, public_key: publicKey });
  }
  keyBundle(userId: string): Promise<KeyBundle> {
    return this.request<KeyBundle>(`/keys/users/${userId}`);
  }

  // ── MLS KeyPackages (Phase 3) ───────────────────────────────────────────────
  /** Publish (append) a pool of single-use KeyPackages + optionally replace the
   * last-resort one for a device. Returns the remaining available count. */
  publishKeyPackages(
    deviceId: string,
    packages: MlsKeyPackageDto[],
    lastResort?: MlsKeyPackageDto,
  ): Promise<{ status: string; available: number }> {
    return this.send("POST", "/mls/key-packages", {
      device_id: deviceId,
      packages,
      last_resort: lastResort ?? null,
    });
  }
  /** Claim one KeyPackage per requested device of `userId`, to add them to a
   * group. Single-use; devices with none published are omitted. */
  claimKeyPackages(userId: string, deviceIds: string[]): Promise<ClaimKeyPackagesResponse> {
    return this.send("POST", "/mls/key-packages/claim", {
      user_id: userId,
      device_ids: deviceIds,
    });
  }
  /** The caller's remaining available single-use KeyPackages for a device. */
  keyPackageCount(deviceId: string): Promise<{ device_id: string; available: number }> {
    return this.request(`/mls/key-packages/count/${deviceId}`);
  }

  // ── MLS groups (Delivery Service, Phase 3) ──────────────────────────────────
  /** Create the server-side ordering row for a group (group id = conversation id). */
  createMlsGroup(groupId: string): Promise<MlsGroupStatus> {
    return this.send("POST", `/mls/groups/${groupId}`);
  }
  /** Submit a Commit (CAS on `epoch`) + Welcomes for added devices. Rejects with a
   * 409 ApiError if the epoch already advanced — the caller resyncs and retries. */
  mlsCommit(
    groupId: string,
    epoch: number,
    frame: string,
    welcomes: MlsWelcomeSend[] = [],
  ): Promise<{ order_seq: number }> {
    return this.send("POST", `/mls/groups/${groupId}/commit`, { epoch, frame, welcomes });
  }
  /** Append a proposal or application frame (does not advance the epoch). */
  mlsFrame(
    groupId: string,
    contentType: "proposal" | "application",
    frame: string,
    epoch?: number,
  ): Promise<{ order_seq: number }> {
    // Claiming our epoch lets the server 409 a frame from a diverged/stale
    // group instead of letting it "succeed" into a log nobody can decrypt.
    return this.send("POST", `/mls/groups/${groupId}/frames`, {
      content_type: contentType,
      frame,
      ...(epoch !== undefined ? { epoch } : {}),
    });
  }
  /** Ordered frames after a cursor, for replay on reconnect. */
  mlsFrames(groupId: string, after = 0): Promise<{ frames: MlsFrameDto[] }> {
    return this.request(`/mls/groups/${groupId}/frames?after=${after}`);
  }
  /** Pending Welcomes for a device. `ack=true` keeps them pending until this
   * device explicitly acks each one (at-least-once — survives a crash between
   * fetch and join); an older server ignores the flag and consumes on fetch. */
  mlsWelcomes(deviceId: string): Promise<{ welcomes: MlsWelcomeDto[] }> {
    return this.request(`/mls/welcomes?device_id=${encodeURIComponent(deviceId)}&ack=true`);
  }
  /** Confirm a Welcome's join was attempted — it stops being replayed. */
  ackMlsWelcome(id: string): Promise<{ status: string }> {
    return this.send("POST", `/mls/welcomes/${id}/ack`);
  }

  // ── Conversations & membership ──────────────────────────────────────────────
  conversations(): Promise<{ conversations: ConversationDto[] }> {
    return this.request("/conversations");
  }
  openDm(userId: string): Promise<{ conversation_id: string; kind: "dm" }> {
    return this.send("POST", "/conversations/dm", { user_id: userId });
  }
  createGroup(name: string, memberIds: string[]): Promise<{ conversation_id: string; kind: "group" }> {
    return this.send("POST", "/conversations/group", { name, member_ids: memberIds });
  }
  conversationMembers(conversationId: string): Promise<{ members: MemberDto[] }> {
    return this.request(`/conversations/${conversationId}/members`);
  }
  addMember(conversationId: string, userId: string): Promise<{ status: string }> {
    return this.send("POST", `/conversations/${conversationId}/members`, { user_id: userId });
  }
  removeMember(conversationId: string, userId: string): Promise<{ status: string }> {
    return this.request(`/conversations/${conversationId}/members/${userId}`, { method: "DELETE" });
  }
  /** Update a group's name and/or description (absent fields untouched). */
  updateGroup(
    conversationId: string,
    patch: { name?: string; description?: string },
  ): Promise<{ status: string }> {
    return this.send("PATCH", `/conversations/${conversationId}`, patch);
  }
  /** Reserve a presigned PUT URL for a group avatar (admin only). */
  requestGroupAvatarUpload(
    conversationId: string,
    sizeBytes: number,
  ): Promise<{ upload_url: string; version: number; expires_in: number }> {
    return this.send("POST", `/conversations/${conversationId}/avatar`, {
      size_bytes: sizeBytes,
    });
  }
  /** Commit a just-uploaded group avatar version. */
  commitGroupAvatar(
    conversationId: string,
    version: number,
  ): Promise<{ status: string; avatar_url: string }> {
    return this.send("POST", `/conversations/${conversationId}/avatar/commit`, { version });
  }
  renameGroup(conversationId: string, name: string): Promise<{ status: string }> {
    return this.send("PATCH", `/conversations/${conversationId}`, { name });
  }

  // ── Messages ────────────────────────────────────────────────────────────────
  messages(
    conversationId: string,
    deviceId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<MessagePage> {
    const params = new URLSearchParams({ device_id: deviceId });
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.request<MessagePage>(`/conversations/${conversationId}/messages?${params}`);
  }
  sendMessage(conversationId: string, payload: SendMessagePayload): Promise<{ message_id: string }> {
    return this.send("POST", `/conversations/${conversationId}/messages`, payload);
  }
  editMessage(
    conversationId: string,
    messageId: string,
    payload: EditMessagePayload,
  ): Promise<{ status: string }> {
    return this.send("PATCH", `/conversations/${conversationId}/messages/${messageId}`, payload);
  }
  deleteMessage(conversationId: string, messageId: string): Promise<{ status: string }> {
    return this.request(`/conversations/${conversationId}/messages/${messageId}`, {
      method: "DELETE",
    });
  }
  /** Advance the read marker. Without messageId (MLS conversations, whose local
   * ids don't map to server rows) the server marks everything up to now read. */
  markRead(conversationId: string, messageId?: string): Promise<{ status: string }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/read`,
      messageId ? { message_id: messageId } : {},
    );
  }
  /** Toggle the caller's emoji reaction on a message. Returns whether it is now set. */
  toggleReaction(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ added: boolean }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/messages/${messageId}/reactions`,
      { emoji },
    );
  }
  /** The message's aggregated reactions for the caller (post-`MESSAGE_REACTED` refresh). */
  messageReactions(
    conversationId: string,
    messageId: string,
  ): Promise<{ reactions: ReactionDto[] }> {
    return this.request(`/conversations/${conversationId}/messages/${messageId}/reactions`);
  }
  /** Mint a LiveKit access token to join this conversation's call room (Phase 4).
   * `device` distinguishes the same user's multiple devices as participants. */
  mintCallToken(
    conversationId: string,
    device: string,
  ): Promise<{ url: string; room: string; token: string }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/call/token?device=${encodeURIComponent(device)}`,
      {},
    );
  }
  /** Announce a new call to the other members (they ring). Returns the call_id. */
  callRing(conversationId: string, media: string): Promise<{ call_id: string }> {
    return this.send("POST", `/conversations/${conversationId}/call/ring`, { media });
  }
  /** Join (or start) the conversation's call: records us in the server roster,
   * mints a LiveKit token, and — for the first joiner — rings the others. */
  callJoin(
    conversationId: string,
    media: string,
    device: string,
  ): Promise<{
    call_id: string;
    is_new: boolean;
    url: string;
    room: string;
    token: string;
    participants: string[];
  }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/call/join?device=${encodeURIComponent(device)}`,
      { media },
    );
  }
  /** Leave the conversation's call. `ended` is true when we were the last one. */
  callLeave(
    conversationId: string,
    device: string,
  ): Promise<{ ended: boolean; participants: string[] }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/call/leave?device=${encodeURIComponent(device)}`,
      {},
    );
  }
  /** Refresh our call-roster liveness while in a call (no-op if we aren't in it). */
  callHeartbeat(conversationId: string, device: string): Promise<{ status: string }> {
    return this.send(
      "POST",
      `/conversations/${conversationId}/call/heartbeat?device=${encodeURIComponent(device)}`,
      {},
    );
  }
  /** The conversation's live call (for discovering an in-progress call to join). */
  callGetState(
    conversationId: string,
  ): Promise<{ active: boolean; call_id?: string; participants: string[] }> {
    return this.request(`/conversations/${conversationId}/call`);
  }
  /** Read any user's public profile. */
  getProfile(userId: string): Promise<ProfileDto> {
    return this.request(`/users/${userId}/profile`);
  }
  /** Key transparency (Phase 3 · Lot 6): the current signed tree head. */
  transparencySth(): Promise<{ tree_size: number; root: string; sth: string }> {
    return this.request("/transparency/sth");
  }
  /** Inclusion proof that a device's current published key is in the log. */
  transparencyInclusion(
    userId: string,
    deviceId: string,
  ): Promise<{
    user_id: string;
    device_id: string;
    public_key: string;
    index: number;
    tree_size: number;
    root: string;
    proof: string[];
  }> {
    return this.request(`/transparency/inclusion/${userId}/${encodeURIComponent(deviceId)}`);
  }
  /** Consistency proof between two log sizes (`second` defaults to the current size). */
  transparencyConsistency(
    first: number,
    second?: number,
  ): Promise<{ first: number; second: number; second_root: string; proof: string[] }> {
    const q = second != null ? `?first=${first}&second=${second}` : `?first=${first}`;
    return this.request(`/transparency/consistency${q}`);
  }
  /** The server's JWKS, to verify the STH signature. */
  jwks(): Promise<{ keys: { kty: string; crv?: string; x?: string; kid?: string }[] }> {
    return this.request("/.well-known/jwks.json");
  }
  /** Update the current account's profile text fields (empty clears a field). */
  updateProfile(patch: {
    display_name?: string;
    bio?: string;
    accent_color?: string;
  }): Promise<ProfileDto> {
    return this.send("PATCH", "/me/profile", patch);
  }
  /** Reserve a presigned PUT URL to upload a new avatar (public bucket). */
  requestAvatarUpload(
    sizeBytes: number,
  ): Promise<{ upload_url: string; version: number; expires_in: number }> {
    return this.send("POST", "/me/avatar", { size_bytes: sizeBytes });
  }
  /** Commit a just-uploaded avatar version (bumps the public URL). */
  commitAvatar(version: number): Promise<ProfileDto> {
    return this.send("POST", "/me/avatar/commit", { version });
  }
  /** Remove the current avatar. */
  deleteAvatar(): Promise<ProfileDto> {
    return this.request("/me/avatar", { method: "DELETE" });
  }
  /** Reserve a presigned PUT URL to upload a new banner. */
  requestBannerUpload(
    sizeBytes: number,
  ): Promise<{ upload_url: string; version: number; expires_in: number }> {
    return this.send("POST", "/me/banner", { size_bytes: sizeBytes });
  }
  /** Commit a just-uploaded banner version. */
  commitBanner(version: number): Promise<ProfileDto> {
    return this.send("POST", "/me/banner/commit", { version });
  }
  /** Remove the current banner. */
  deleteBanner(): Promise<ProfileDto> {
    return this.request("/me/banner", { method: "DELETE" });
  }
  /** Whether TOTP two-factor auth is enabled for the current account. */
  totpStatus(): Promise<{ enabled: boolean }> {
    return this.request("/auth/totp");
  }
  /** Begin TOTP enrollment — returns the secret + otpauth URI (shown once). */
  totpEnroll(): Promise<{ secret: string; otpauth_uri: string }> {
    return this.send("POST", "/auth/totp/enroll", {});
  }
  /** Confirm enrollment with a first code → enables 2FA, returns fresh recovery codes. */
  totpConfirm(code: string): Promise<{ status: string; recovery_codes: string[] }> {
    return this.send("POST", "/auth/totp/enroll/confirm", { code });
  }
  /** Disable 2FA (re-authenticates with the account password). */
  totpDisable(password: string): Promise<{ status: string }> {
    return this.send("POST", "/auth/totp/disable", { password });
  }
  /** Signal a call ended / was declined so a ringing prompt dismisses. */
  callEnd(conversationId: string, callId: string): Promise<{ status: string }> {
    return this.send("POST", `/conversations/${conversationId}/call/end`, { call_id: callId });
  }
  /** Set a conversation's E2EE protocol (Phase 3 cutover): "x25519" or "mls". */
  setConversationProtocol(
    conversationId: string,
    protocol: "x25519" | "mls",
  ): Promise<{ status: string; protocol: string }> {
    return this.send("POST", `/conversations/${conversationId}/protocol`, { protocol });
  }

  // ── Attachments ─────────────────────────────────────────────────────────────
  requestUpload(conversationId: string, sizeBytes: number): Promise<UploadTicket> {
    return this.send("POST", "/uploads", { conversation_id: conversationId, size_bytes: sizeBytes });
  }
  downloadUrl(blobId: string): Promise<DownloadTicket> {
    return this.request<DownloadTicket>(`/uploads/${blobId}`);
  }
}
