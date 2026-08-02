/**
 * Per-instance WebSocket client.
 *
 * Obtains a single-use ticket, connects, validates every frame with zod, routes
 * events to registered handlers (a WS-router: each store subscribes its own
 * type), heartbeats to keep presence alive, and reconnects with exponential
 * backoff. Ticket minting goes through [`ApiClient`], so an expired access token
 * is refreshed transparently before each (re)connect.
 */

import type { ApiClient } from "../api/ApiClient";
import { toWsUrl } from "../api/http";
import {
  ServerEventSchema,
  type ClientCommand,
  type ServerEvent,
  type ServerEventType,
} from "./wireSchema";

type Handler = (event: ServerEvent) => void;

/** Live connection state, for the offline/reconnecting banner. */
export type WsStatus = "connecting" | "open" | "reconnecting";
type StatusHandler = (status: WsStatus) => void;

const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<ServerEventType, Set<Handler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private status: WsStatus = "connecting";
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly client: ApiClient) {}

  /** Subscribe to connection-status changes; fires immediately with the current
   * status. Returns an unsubscribe function. */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  /** Registers a handler for one event type; returns an unsubscribe function. */
  on(type: ServerEventType, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** Sends a command if the socket is open. */
  send(command: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    }
  }

  /** Opens the connection (idempotent: safe to call to (re)establish). */
  async connect(): Promise<void> {
    this.closed = false;
    this.clearReconnect();
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    try {
      const { ticket } = await this.client.wsTicket();
      const url = `${toWsUrl(this.client.baseUrl)}/ws?ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.attempt = 0;
        this.setStatus("open");
        this.startHeartbeat();
      };
      ws.onmessage = (ev) => this.handleMessage(ev);
      ws.onclose = () => {
        this.stopHeartbeat();
        if (!this.closed) this.scheduleReconnect();
      };
      ws.onerror = () => {
        // `onclose` follows and drives the reconnect.
      };
    } catch {
      if (!this.closed) this.scheduleReconnect();
    }
  }

  /** Réveil après une mise en veille du système.
   *
   * On ne consulte pas `readyState` : une WebView gelée rend un socket qui se
   * dit encore ouvert alors que le serveur a coupé depuis longtemps, et lui
   * faire confiance laisse l'utilisateur devant un écran définitivement muet.
   * On repart donc systématiquement d'une connexion neuve, et on remet le
   * backoff à zéro pour ne pas lui infliger les trente secondes d'attente
   * héritées des tentatives d'avant la veille. */
  wake(): void {
    if (this.closed) return;
    this.attempt = 0;
    this.clearReconnect();
    this.stopHeartbeat();
    const ws = this.ws;
    if (ws) {
      // Détacher `onclose` AVANT de fermer : sinon la fermeture volontaire
      // programme un reconnect qui entrerait en concurrence avec le nôtre, et
      // deux sockets se disputeraient les événements.
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
      this.ws = null;
    }
    void this.connect();
  }

  /** Closes intentionally and stops reconnecting. */
  disconnect(): void {
    this.closed = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(ev: MessageEvent): void {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    const parsed = ServerEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("ws: dropping unrecognized frame", raw);
      return;
    }
    const event = parsed.data;
    if (event.type === "RESET") {
      // The server asked us to resync: reconnect (state is re-fetched via REST).
      this.ws?.close();
      return;
    }
    this.handlers.get(event.type)?.forEach((h) => h(event));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: "HEARTBEAT" }), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.setStatus("reconnecting");
    this.attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 5));
    this.reconnect = setTimeout(() => void this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnect) {
      clearTimeout(this.reconnect);
      this.reconnect = null;
    }
  }
}
