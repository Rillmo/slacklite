# 💬 SlackLite

[![CI](https://img.shields.io/badge/CI-node--test%20%2B%20docker-brightgreen)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A523.4-blue)](package.json)

An open-source, self-hosted Slack-style team chat. One Node.js process, one SQLite file, zero build steps.

**[한국어 README](README.ko.md)**

## Why SlackLite?

- **Trivial to self-host** — `docker compose up -d` and you're done. No external database, no Redis, no S3.
- **Zero native dependencies** — SQLite via the built-in `node:sqlite`, pure-JS bcrypt. `npm install` never needs a compiler.
- **No frontend build** — vanilla JS SPA served statically. Clone, install, run.
- **Your data stays yours** — everything lives in a single SQLite file you can back up with `cp`.

## Features

- Public channels (create/join, default `#general` / `#random`, topics)
- 1:1 direct messages
- Real-time messaging over WebSockets (Socket.IO)
- Threads with reply counts
- Emoji reactions
- Edit/delete your own messages
- Unread badges per channel/DM
- Typing indicators & online presence
- Full-text message search
- Invite-code gated registration (optional)
- macOS desktop app (Electron) with dock badge & native notifications

## Quick start (Docker, recommended)

```bash
git clone https://github.com/Rillmo/slacklite.git && cd slacklite
docker compose up -d
# open http://localhost:3000
```

Or use the prebuilt image without cloning:

```bash
docker run -d --name slacklite -p 3000:3000 -v slacklite-data:/data \
  ghcr.io/rillmo/slacklite:latest
```

Data (SQLite DB + JWT secret) persists in the `slacklite-data` volume.

To restrict sign-ups, set an invite code in `docker-compose.yml`:

```yaml
environment:
  INVITE_CODE: "our-team-invite"
```

## Quick start (bare Node.js)

Requires **Node.js 23.4+** (Node 24 LTS recommended).

```bash
npm install
npm start          # http://localhost:3000
```

## Exposing to the internet

Run behind a reverse proxy with HTTPS and set `TRUST_PROXY=1`.

**Caddy** (automatic HTTPS):

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
server {
    server_name chat.example.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

Checklist for public instances: HTTPS ✅ · `INVITE_CODE` set ✅ · `TRUST_PROXY=1` ✅ · `/data` backed up ✅. See [SECURITY.md](SECURITY.md).

## Configuration

All environment variables are optional — see [.env.example](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./data.db` | SQLite database file |
| `SECRET_PATH` | `./.jwt-secret` | JWT secret file (auto-generated) |
| `JWT_SECRET` | — | Explicit JWT secret (overrides `SECRET_PATH`) |
| `INVITE_CODE` | — | Require this code to register |
| `TRUST_PROXY` | — | Set to `1` behind a reverse proxy |

## macOS desktop app

```bash
npm run app     # dev mode
npm run dist    # build release/SlackLite-<version>-arm64.dmg
```

The app embeds the server (no separate process needed), shows unread counts as a dock badge, and delivers native notifications. If port 3000 is already serving SlackLite, the app attaches to the existing server instead. App data lives in `~/Library/Application Support/SlackLite/`.

> Builds are unsigned — fine for your own Mac; distributing to others requires an Apple Developer certificate for signing/notarization.

## Development

```bash
npm run dev     # auto-restarting server
npm test        # node:test suite (REST + WebSocket, isolated temp DB)
```

```
server/
  index.js     # CLI entry, graceful shutdown
  app.js       # Express + Socket.IO bootstrap, health check
  db.js        # SQLite schema & queries (node:sqlite)
  auth.js      # JWT sign/verify, HTTP & socket middleware
  routes.js    # REST API (/api/*)
  sockets.js   # Real-time events (messages, reactions, typing, presence)
  ratelimit.js # In-memory per-IP rate limiter for auth endpoints
public/        # Vanilla JS SPA (no build step)
desktop/       # Electron main process + preload (macOS app)
test/          # node:test API & socket tests
```

### API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/meta` | Instance metadata (invite required?) |
| POST | `/api/register` | Sign up (rate-limited, joins default channels) |
| POST | `/api/login` | Log in → JWT |
| GET | `/api/channels` | Channels, DMs, unread counts |
| POST | `/api/channels` | Create channel |
| GET | `/api/channels/:id/messages` | Channel history (auto-joins public channels) |
| POST | `/api/dm/:userId` | Get-or-create DM channel |
| GET | `/api/messages/:id/thread` | Thread replies |
| GET | `/api/search?q=` | Search messages |

Socket events: client emits `message:send/edit/delete`, `reaction:toggle`, `typing`, `channel:read`; server broadcasts `message:new/update/delete`, `presence`, `typing`, `channel:new`, `dm:new`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
