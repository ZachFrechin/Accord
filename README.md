<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Accord

**A self-hostable, end-to-end encrypted messenger.** Friends, direct messages,
groups, voice and video — with the encryption done properly, not bolted on.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Encryption: MLS RFC 9420](https://img.shields.io/badge/Encryption-MLS%20RFC%209420-green.svg)](https://www.rfc-editor.org/rfc/rfc9420.html)

Accord is not a Discord clone. There are no guilds, no server browser, no
federation. It is private messaging between people who know each other, on
infrastructure you control.

The desktop client is **multi-instance**: connect to several Accord servers at
once — your own, a friend's, your team's — and switch between them without
logging out.

> **Status: usable, pre-1.0.** Messaging, calls, and both clients work. The
> APIs and storage formats may still change between releases.

---

## What makes it different

**The server cannot read your messages.** Not "we promise not to", not "we
encrypt at rest" — it structurally cannot. Message content is encrypted on your
device with [MLS (RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420.html) using
[OpenMLS](https://github.com/openmls/openmls) compiled natively into the client.
The server stores and routes ciphertext it has no key for.

This has real consequences, and they are the honest kind:

- **Message previews in notifications are decrypted on your device.** The push
  payload the server sends contains two identifiers and nothing else — the phone
  wakes up, fetches, decrypts, and only then shows text. Google never sees a
  message.
- **Search runs locally**, over the history your device has decrypted.
- **Losing every device means losing history**, unless you exported an encrypted
  backup. There is no server-side copy to restore from. That is the price of the
  guarantee, and it is stated here rather than buried.

Group membership changes re-key the group, so someone removed from a
conversation cannot read what follows, and someone added cannot read what came
before.

**Calls are encrypted too.** Voice and video run over [LiveKit](https://livekit.io),
with the frame encryption key derived from the MLS group secret — so the media
server routes packets it cannot decode either.

---

## Features

| | |
| --- | --- |
| **Messaging** | Direct messages, groups, replies, threads, reactions, edits, pins, mentions, typing indicators, read state |
| **Media** | Images inline, arbitrary attachments, voice messages, link previews |
| **Calls** | Voice, video, screen sharing, per-participant volume, pop-out windows |
| **Identity** | Argon2id password hashing, Ed25519-signed tokens with rotating refresh, TOTP two-factor, recovery codes, session management |
| **Trust** | Safety-number verification, key transparency log, device list per account |
| **Clients** | Desktop (macOS, Windows, Linux) and Android, sharing one Rust encryption core |
| **Operations** | Admin panel, custom roles and permissions, moderation with an audit log |
| **Personalisation** | Themes, transparency, typography, wallpapers (image or video), saved presets |
| **Optional** | XP and levels, game rank linking (League of Legends, CS2), push notifications |

Optional integrations are **per-instance**: whoever deploys an Accord server
supplies their own API keys. Absent keys disable that feature cleanly — nothing
else breaks, and no key is ever shipped in the code.

---

## Repository layout

| Path | What lives there |
| --- | --- |
| `backend/` | Rust / Axum API (`accord-backend`) |
| `crates/accord-mls/` | The MLS engine, shared by every client |
| `packages/core/` | Shared TypeScript: API client, realtime, stores, design system |
| `apps/desktop/` | Tauri 2 + React desktop client |
| `apps/mobile/` | Tauri 2 + React Android client |
| `infra/` | Compose stacks, Dockerfiles, Helm skeleton, observability |
| `migrations/` | sqlx migrations |
| `config/default.toml` | Backend configuration defaults |

The encryption engine is Rust, compiled into both clients — desktop and phone
run the *same* code path, not two implementations that have to be kept in
agreement.

---

## Self-hosting

**Requirements:** Docker and Docker Compose. Everything else is containerised.

```bash
git clone https://github.com/ZachFrechin/Accord.git
cd Accord
cp infra/.env.example infra/.env    # then edit it — see below
docker compose -f infra/docker-compose.deploy.yml up -d
```

Before starting, set at minimum in `infra/.env`:

- `JWT__PRIVATE_KEY_PEM` — the token signing key. Generate one with
  `openssl genpkey -algorithm ed25519`. Without it a throwaway key is generated
  at boot and every restart logs everyone out.
- `DATABASE__URL`, `REDIS__URL`, `NATS__URL` — the backing services.
- `AUTH__BOOTSTRAP_ADMIN_EMAILS` — who gets administrator on first sign-up.

Everything else has a working default. `infra/.env.example` documents every key.

**No secret is ever committed.** If you fork this repository, the keys are yours
to generate; there is nothing in here to leak.

---

## Development

**Prerequisites:** Rust (stable), Node.js 20+, Docker, and the
[Tauri 2 toolchain](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres, Redis, NATS…
cp .env.example .env

cd backend && cargo run                                 # API on :8080
cd apps/desktop && npm install && npm run tauri dev     # desktop client
```

For Android, add the Android SDK and NDK, then:

```bash
cd apps/mobile && npm install && npm run tauri android dev
```

Health checks:

```bash
curl http://localhost:8080/health/live     # 200 while the process is up
curl http://localhost:8080/health/ready    # 200 once the database answers
```

### Configuration

Defaults live in `config/default.toml`, overridden by environment variables. The
nesting separator is a double underscore: `SERVER__PORT` sets `[server].port`.

### Tests

```bash
cd backend && cargo test
cd apps/desktop && npm test
```

The backend uses sqlx's compile-time query checking. The offline cache in
`backend/.sqlx` is committed so a build needs no database; regenerate it with
`cargo sqlx prepare` after changing any query.

---

## Contributing

Issues and pull requests are welcome. A few things that will save us both time:

- **Match the surrounding code.** Comments explain *why*, not *what* — the code
  already says what it does.
- **Keep the encryption boundary intact.** Any change that would let the server
  see plaintext needs to be discussed first, whatever else it improves.
- **Run the tests**, and say so in the pull request if something is left failing.

Security issues should not be opened as public issues — see below.

---

## Reporting a vulnerability

Please report security problems privately through
[GitHub Security Advisories](https://github.com/ZachFrechin/Accord/security/advisories/new)
rather than in a public issue, so a fix can ship before the details do.

---

## License

Accord is licensed under the **GNU Affero General Public License v3.0 or later**
([`LICENSE`](./LICENSE)).

The Affero clause is deliberate. Accord is server software: the AGPL means that
if you run a modified version and let other people use it over a network, those
users are entitled to your changes. Improvements to a messenger people rely on
should come back to everyone who relies on it.

Bundled fonts are licensed separately under the SIL Open Font License — see
[`packages/core/src/assets/fonts/OFL.txt`](./packages/core/src/assets/fonts/OFL.txt).
