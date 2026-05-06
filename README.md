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

LiveKit is the exception to plan carefully: WebRTC media requires UDP connectivity. If Traefik/Coolify does not handle your LiveKit UDP port range, publish the LiveKit RTC UDP range separately at the infrastructure level and keep API/gateway ports behind Traefik.

## Security Baseline

- The server stores encrypted private messages as ciphertext only.
- Supabase RLS must stay enabled on all public schema tables.
- Electron renderer has no Node integration and uses a minimal preload bridge.
- Client env vars are public by design; never put server secrets in `VITE_*`.
- NestJS validates request payloads and applies Supabase JWT auth globally.

## Current Scope

This is a maintainable v1 foundation, not the full Discord feature set. The next implementation steps are to fill the server/channel CRUD, permission checks, key exchange UX, message composer, LiveKit room join UI, and Coolify-specific deployment values.
