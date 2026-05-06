# Discord2

Discord2 is a secure self-hosted Discord-like desktop app scaffold.

## Stack

- Desktop: Electron, React, Vite, TypeScript.
- API: NestJS HTTP API.
- Realtime: NestJS WebSocket gateway with Socket.IO.
- Data: self-hosted Supabase and Postgres using the legacy self-host keys available on this instance: `anon` for clients and `service_role` for backend services.
- Media: self-hosted LiveKit.
- Volatile state: Redis.
- E2EE: client-side libsodium helpers for DM and private channels.

## Layout

- `apps/desktop`: Electron desktop client.
- `apps/api`: NestJS HTTP API.
- `apps/gateway`: NestJS Socket.IO gateway.
- `packages/shared`: shared contracts, event names, IDs, common types.
- `packages/domain`: pure business rules.
- `packages/db`: Supabase clients and repositories.
- `packages/e2ee`: client-side encryption helpers.
- `packages/config`: validated environment loading.
- `supabase/migrations`: SQL schema and RLS policies.
- `infra/livekit`: LiveKit self-host configuration.

## Local Setup

1. Copy `.env.example` to `.env` and fill Supabase and LiveKit values.
2. Install dependencies:

```bash
npm install
```

3. Run checks:

```bash
npm run typecheck
npm test
npm run lint
```

4. Start services:

```bash
npm run dev:api
npm run dev:gateway
npm run dev:desktop
```

## Coolify / Traefik

`docker-compose.yml` uses `expose` instead of host `ports` for `api`, `gateway`, and LiveKit HTTP/TCP listeners. Coolify/Traefik should publish the public routes, so the compose file does not reserve host ports by default.

Redis is internal only and must not be exposed publicly.

LiveKit is the exception to plan carefully: WebRTC signaling can go through Traefik to `7880`, but media requires UDP connectivity. For production, keep API/gateway/Redis internal and open the LiveKit RTC UDP range configured in `infra/livekit/livekit.yaml` (`50000-50100/udp` by default) on the VPS.

For local Docker testing, publish ports only on the LiveKit service if you need to test media from outside the Docker network:

```yaml
ports:
  - '7880:7880'
  - '7881:7881'
  - '50000-50100:50000-50100/udp'
```

## Security Baseline

- The server stores encrypted private messages as ciphertext only.
- Supabase RLS must stay enabled on all public schema tables.
- Electron renderer has no Node integration and uses a minimal preload bridge.
- Client env vars are public by design; never put server secrets in `VITE_*`.
- NestJS validates request payloads and applies Supabase JWT auth globally.

## Current Scope

This is a maintainable v1 foundation, not the full Discord feature set. Current scope includes server/channel CRUD, public text chat, profile/server settings, and audio-only LiveKit voice rooms. E2EE media is intentionally prepared but disabled until client-only key distribution is designed.
