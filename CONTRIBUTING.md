# Contributing

## Code Style

- Use TypeScript strict mode.
- Keep controllers and gateway handlers thin.
- Put business rules in `packages/domain`.
- Put shared contracts in `packages/shared`.
- Put Supabase access behind repositories in `packages/db`.
- Do not access Postgres directly from the desktop app.
- Use one validation style per boundary. This repo starts with NestJS DTOs and `class-validator`.

## Comments

Comments should explain intent, security constraints, or non-obvious tradeoffs. Do not comment obvious assignments or simple control flow.

## Security Rules

- Never log access tokens, service role keys, private keys, or full ciphertext payloads.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` or LiveKit API secrets to the renderer.
- E2EE conversations must not send plaintext message content to the API.
- Private attachments must be encrypted client-side before upload.
- Keep Electron `contextIsolation` enabled and `nodeIntegration` disabled.

## Required Checks

Run these before opening a PR:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
