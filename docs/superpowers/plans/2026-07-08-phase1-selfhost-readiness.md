# Phase 1 — Self-Host Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working SlackLite app into a git-tracked, Docker-packaged, documented, CI-tested project a stranger can clone and self-host.

**Architecture:** Keep the single-process / one-SQLite-file design. Add packaging (Docker + compose), English docs, OSS hygiene files, and a `node:test` smoke suite that boots the real server on an ephemeral port against a throwaway DB. No app-behavior changes except small, verified hardening.

**Tech Stack:** Node.js 24 (runtime pinned in Docker), Express, Socket.IO, `node:sqlite`, built-in `node:test`, Docker, GitHub Actions.

## Global Constraints

- Zero external services; one SQLite file; clone → one command → running instance.
- No new runtime dependencies in Phase 1 (`node:test` is built in).
- Docker base image: `node:24-alpine`. Bare-metal floor: Node ≥ 23.4, recommend ≥ 24.
- Secrets/artifacts never committed: `.jwt-secret`, `data.db`, `data.db-wal`, `data.db-shm`, `.DS_Store`, `release/`, `node_modules/`, `uploads/`, `.env`.
- Docs in English; preserve existing Korean README as `README.ko.md`. App UI stays Korean.
- License is MIT (already present).

---

### Task 1: Git init + ignore hardening + clean first commit

**Files:**
- Modify: `.gitignore`
- Create: git repository (no file)

- [ ] **Step 1: Harden `.gitignore`** — replace contents with:

```gitignore
# dependencies
node_modules/

# build output
release/
dist/

# runtime data (never commit)
data.db
data.db-*
uploads/

# secrets / local config
.jwt-secret
.env
.env.local

# os
.DS_Store
```

- [ ] **Step 2: Initialize repo**

Run: `cd /Users/kimjunho/Develop/slack2 && git init -b main`
Expected: `Initialized empty Git repository`

- [ ] **Step 3: Verify no secrets/artifacts are staged**

Run: `git add -A && git status --short`
Expected output MUST NOT list `.jwt-secret`, `data.db`, `data.db-wal`, `data.db-shm`, `.DS_Store`, `release/`, or `node_modules/`. If any appear, fix `.gitignore` and `git rm --cached <path>` before continuing.

- [ ] **Step 4: Commit source + the design spec**

```bash
git commit -m "chore: initialize git repository

Existing SlackLite source plus self-hosting design spec.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Expected: commit succeeds; `git ls-files | grep -E 'jwt-secret|data.db|DS_Store'` returns nothing.

---

### Task 2: Test harness + characterization smoke tests

The app already works; these tests pin current behavior and gate CI. They boot the real server on port 0 with a temp DB so they never touch `data.db`.

**Files:**
- Create: `test/helpers.js`
- Create: `test/auth.test.js`
- Create: `test/routes.test.js`
- Create: `test/sockets.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `startTestServer()` → `{ url, port, close }` where `url` is `http://127.0.0.1:<port>`; boots via `startServer(0)` after setting a unique `DB_PATH` + `JWT_SECRET` env. `api(url)` helper returning `{ get, post }` that attach `Authorization: Bearer` when a token is passed.
- Consumes: `startServer` from `server/app.js`; the app reads `DB_PATH`, `JWT_SECRET`, `SECRET_PATH` from env at import time.

- [ ] **Step 1: Write the harness** — `test/helpers.js`:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Must set env BEFORE importing the server (db.js reads DB_PATH at import).
export async function startTestServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'slacklite-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.SECRET_PATH = path.join(dir, '.jwt-secret');
  process.env.JWT_SECRET = 'test-secret-' + Math.random().toString(36).slice(2);
  delete process.env.INVITE_CODE;
  const { startServer } = await import('../server/app.js?ts=' + Date.now());
  const server = await startServer(0, '127.0.0.1');
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((res) => server.close(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} res(); })),
  };
}

export function api(base) {
  const call = async (method, pathname, { token, body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  return {
    get: (p, opts) => call('GET', p, opts),
    post: (p, opts) => call('POST', p, opts),
  };
}
```

> Note: `db.js` is a module singleton imported once per process. Each test file is its own Node process under `node:test`, so per-file env works. The `?ts=` cache-buster keeps re-imports within a file pointing at the same module instance (import cache keyed by full specifier) — set env once at file top via a shared `before`.

- [ ] **Step 2: Write `test/auth.test.js`**

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let srv, http;
before(async () => { srv = await startTestServer(); http = api(srv.url); });
after(async () => { await srv.close(); });

test('register creates a user and returns a token', async () => {
  const r = await http.post('/api/register', { body: { username: 'alice', password: 'secret', displayName: 'Alice' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.user.username, 'alice');
});

test('register rejects short password', async () => {
  const r = await http.post('/api/register', { body: { username: 'bob', password: 'no' } });
  assert.equal(r.status, 400);
});

test('register rejects duplicate username', async () => {
  await http.post('/api/register', { body: { username: 'carol', password: 'secret' } });
  const r = await http.post('/api/register', { body: { username: 'carol', password: 'secret' } });
  assert.equal(r.status, 409);
});

test('login succeeds then rejects wrong password', async () => {
  await http.post('/api/register', { body: { username: 'dave', password: 'secret' } });
  const ok = await http.post('/api/login', { body: { username: 'dave', password: 'secret' } });
  assert.equal(ok.status, 200);
  const bad = await http.post('/api/login', { body: { username: 'dave', password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('protected route requires a token', async () => {
  const r = await http.get('/api/me');
  assert.equal(r.status, 401);
});

test('healthz is public', async () => {
  const r = await http.get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
```

- [ ] **Step 3: Write `test/routes.test.js`**

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let srv, http, token;
before(async () => {
  srv = await startTestServer();
  http = api(srv.url);
  const r = await http.post('/api/register', { body: { username: 'owner', password: 'secret' } });
  token = r.body.token;
});
after(async () => { await srv.close(); });

test('default channels exist after register', async () => {
  const r = await http.get('/api/channels', { token });
  assert.equal(r.status, 200);
  const names = r.body.channels.map((c) => c.name);
  assert.ok(names.includes('general'));
  assert.ok(names.includes('random'));
});

test('create channel then reject duplicate', async () => {
  const ok = await http.post('/api/channels', { token, body: { name: 'eng', topic: 'engineering' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.channel.name, 'eng');
  const dup = await http.post('/api/channels', { token, body: { name: 'eng' } });
  assert.equal(dup.status, 409);
});

test('create channel rejects invalid name', async () => {
  const r = await http.post('/api/channels', { token, body: { name: '!!!' } });
  assert.equal(r.status, 400);
});

test('search returns empty for blank query', async () => {
  const r = await http.get('/api/search?q=', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, []);
});
```

- [ ] **Step 4: Write `test/sockets.test.js`** (uses `socket.io-client`, already a transitive dep of `socket.io`; import it directly):

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { startTestServer, api } from './helpers.js';

let srv, http, token, generalId;
before(async () => {
  srv = await startTestServer();
  http = api(srv.url);
  token = (await http.post('/api/register', { body: { username: 'sock', password: 'secret' } })).body.token;
  const ch = await http.get('/api/channels', { token });
  generalId = ch.body.channels.find((c) => c.name === 'general').id;
  await http.get(`/api/channels/${generalId}/messages`, { token }); // ensure membership
});
after(async () => { await srv.close(); });

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(srv.url, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

test('socket sends a message and receives message:new', async () => {
  const s = await connect();
  const got = new Promise((res) => s.on('message:new', res));
  const ack = await s.emitWithAck('message:send', { channelId: generalId, content: 'hello world' });
  assert.ok(ack.message);
  const msg = await got;
  assert.equal(msg.content, 'hello world');
  s.close();
});

test('socket rejects empty auth', async () => {
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const s = ioClient(srv.url, { auth: {}, transports: ['websocket'] });
      s.on('connect', () => { s.close(); resolve(); });
      s.on('connect_error', reject);
    })
  );
});
```

- [ ] **Step 5: Add the test script** — in `package.json` `scripts`, add:

```json
"test": "node --test --test-concurrency=1 test/"
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all tests pass (an `ExperimentalWarning` about SQLite on Node 23 is expected and harmless). If `socket.io-client` is not resolvable, run `npm ls socket.io-client`; if absent add it as a devDependency (`npm i -D socket.io-client`) and note it in CHANGELOG.

- [ ] **Step 7: Commit**

```bash
git add test/ package.json package-lock.json
git commit -m "test: add node:test smoke suite for auth, routes, and sockets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `.env.example` + verified hardening

**Files:**
- Create: `.env.example`
- Modify: `server/app.js` (only if a real gap is found)
- Create: `test/hardening.test.js`

- [ ] **Step 1: Write `.env.example`**

```bash
# Copy to .env and adjust. All values have safe defaults except where noted.

# HTTP port the server listens on.
PORT=3000

# Bind address. 0.0.0.0 exposes on all interfaces (needed inside Docker).
HOST=0.0.0.0

# SQLite database file. In Docker this lives on the mounted volume.
DB_PATH=./data.db

# Session-signing secret. If unset, a random secret is generated and persisted
# to SECRET_PATH so sessions survive restarts. Set explicitly in production.
# JWT_SECRET=

# Where the auto-generated secret is stored when JWT_SECRET is unset.
SECRET_PATH=./.jwt-secret

# Set to 1 when running behind a reverse proxy (nginx/Caddy/Traefik) so the
# real client IP is used for rate limiting.
# TRUST_PROXY=1

# If set, registration requires this invite code. Leave unset for open signup.
# INVITE_CODE=

# --- Phase 2/3 (reserved) ---
# Directory for uploaded files (defaults next to DB_PATH).
# UPLOADS_DIR=./uploads
# Max upload size in megabytes.
# MAX_UPLOAD_MB=10
# Username auto-promoted to workspace admin on registration.
# ADMIN_USERNAME=
```

- [ ] **Step 2: Write `test/hardening.test.js`** — assert security headers + JSON body limit:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

test('security headers are present and x-powered-by is hidden', async () => {
  const res = await fetch(srv.url + '/healthz');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('oversized JSON body is rejected', async () => {
  const big = 'x'.repeat(70 * 1024); // > 64kb limit
  const res = await fetch(srv.url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: big }),
  });
  assert.equal(res.status, 413);
});
```

- [ ] **Step 3: Run**

Run: `npm test`
Expected: PASS. If the body-limit test fails, confirm `express.json({ limit: '64kb' })` is applied before routes in `server/app.js` (it is at line 29) — do not change behavior unless the test proves a gap.

- [ ] **Step 4: Commit**

```bash
git add .env.example test/hardening.test.js
git commit -m "docs: add .env.example; test: cover security headers and body limits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Docker packaging

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# node:sqlite is stable in Node 24 — no experimental flag needed.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Data (SQLite + secret + uploads) lives on a mounted volume.
ENV DB_PATH=/data/data.db \
    SECRET_PATH=/data/.jwt-secret \
    UPLOADS_DIR=/data/uploads \
    HOST=0.0.0.0 \
    PORT=3000
RUN mkdir -p /data && addgroup -S app && adduser -S app -G app && chown -R app:app /app /data
USER app
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```dockerignore
node_modules
release
dist
data.db
data.db-*
uploads
.jwt-secret
.env
.env.local
.git
.github
docs
desktop
test
.DS_Store
*.md
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  slacklite:
    build: .
    image: slacklite:latest
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      # Uncomment to require an invite code for registration.
      # INVITE_CODE: ${INVITE_CODE}
      # Set a strong secret in production (otherwise auto-generated on the volume).
      # JWT_SECRET: ${JWT_SECRET}
      TRUST_PROXY: ${TRUST_PROXY:-}
    volumes:
      - slacklite-data:/data

volumes:
  slacklite-data:
```

- [ ] **Step 4: Build the image**

Run: `docker build -t slacklite:test .`
Expected: build succeeds. If Docker is unavailable in this environment, record that the build is deferred to CI (Task 7 builds it) and continue.

- [ ] **Step 5: Smoke-run (if Docker available)**

Run: `docker run -d --name slacklite-smoke -p 3999:3000 slacklite:test && sleep 3 && curl -fsS http://127.0.0.1:3999/healthz`
Expected: `{"ok":true}`. Then `docker rm -f slacklite-smoke`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "build: add Docker image and compose file for self-hosting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: English README + operator docs

**Files:**
- Create: `README.ko.md` (move current Korean README here)
- Modify/replace: `README.md` (English)
- Create: `docs/SELF_HOSTING.md`
- Create: `docs/CONFIGURATION.md`
- Create: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Preserve Korean README**

Run: `git mv README.md README.ko.md`

- [ ] **Step 2: Write English `README.md`** with these sections (real content, no placeholders):
  - Title + one-line description ("Self-hosted, open-source Slack-style team chat that runs as a single Node.js process with one SQLite file.").
  - Badges: license MIT, CI status (`![CI](.github/workflows/ci.yml badge)`).
  - **Features** (mirror `README.ko.md` in English): channels, DMs, realtime, threads, reactions, edit/delete, unread badges, typing, presence, search, JWT auth, macOS desktop app.
  - **Quick start (Docker)**: `git clone` → `cp .env.example .env` → `docker compose up -d` → open `http://localhost:3000`. First registered user becomes the admin (forward-reference Phase 3).
  - **Quick start (bare metal)**: requires Node ≥ 24 (or ≥ 23.4); `npm install` → `npm start`.
  - **Configuration**: link to `docs/CONFIGURATION.md`, short env table.
  - **Self-hosting / production**: link to `docs/SELF_HOSTING.md`.
  - **Desktop app**: brief, link to details.
  - **Contributing / Security / License** links.
  - Note: "한국어 README는 [README.ko.md](README.ko.md)."

- [ ] **Step 3: Write `docs/SELF_HOSTING.md`** — sections:
  - Deploying with Docker Compose (pull/build, env, `docker compose up -d`, logs, updating: `git pull && docker compose up -d --build`).
  - Bare-metal with a process manager (systemd unit example running `node server/index.js`, `Restart=always`, env file).
  - Reverse proxy + TLS: **nginx** server block (proxy_pass, `proxy_set_header Upgrade`/`Connection` for WebSockets, `X-Forwarded-For`) and **Caddy** two-line config (automatic HTTPS). Note `TRUST_PROXY=1`.
  - Backups: stop or use `sqlite3 data.db ".backup backup.db"`; the whole `/data` volume (DB + `.jwt-secret` + uploads) is the backup unit.
  - Data location: Docker volume `slacklite-data` at `/data`; bare metal next to the project.
  - Upgrades & migrations: schema migrations run automatically at startup; back up first.

- [ ] **Step 4: Write `docs/CONFIGURATION.md`** — full table of every env var (name, default, description) matching `.env.example`, one row each.

- [ ] **Step 5: Write `docs/ARCHITECTURE.md`** — process model (single Node process, embedded Socket.IO), data model (tables + relationships), REST + socket event catalog (copy from `README.ko.md` API summary, in English), security model (bcrypt, JWT, rate limiting, headers, invite gate).

- [ ] **Step 6: Verify links**

Run: `grep -roE '\]\(([^)]+)\)' README.md docs/*.md | sed -E 's/.*\(([^)]+)\).*/\1/' | grep -vE '^https?://' | sort -u`
Then confirm each referenced local file exists. Expected: no broken local links.

- [ ] **Step 7: Commit**

```bash
git add README.md README.ko.md docs/SELF_HOSTING.md docs/CONFIGURATION.md docs/ARCHITECTURE.md
git commit -m "docs: English README and operator guides (self-hosting, config, architecture)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: OSS hygiene files

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: `CONTRIBUTING.md`** — how to set up (`npm install`, `npm start`, `npm test`), branch/PR flow, run tests before PR, code style (match existing), DCO/sign-off optional, that CI must pass.

- [ ] **Step 2: `SECURITY.md`** — supported versions, private disclosure (email `maxman306@gmail.com`), do-not-open-public-issues-for-vulns, response expectations.

- [ ] **Step 3: `CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1 text with the maintainer contact filled in.

- [ ] **Step 4: `CHANGELOG.md`** — Keep a Changelog format; `## [Unreleased]` with an `### Added` list capturing Phase 1 (git repo, Docker, docs, tests, CI).

- [ ] **Step 5: Issue/PR templates** — bug report (steps/expected/actual/version/deployment), feature request (problem/proposal/alternatives), PR template (summary/testing/checklist: tests pass, docs updated).

- [ ] **Step 6: Commit**

```bash
git add CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md .github/
git commit -m "docs: add contributing, security, code of conduct, changelog, and GitHub templates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm test

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        run: docker build -t slacklite:ci .
      - name: Health check container
        run: |
          docker run -d --name slacklite-ci -p 3000:3000 slacklite:ci
          for i in $(seq 1 20); do
            if curl -fsS http://127.0.0.1:3000/healthz; then echo OK; exit 0; fi
            sleep 1
          done
          echo "healthcheck failed"; docker logs slacklite-ci; exit 1
```

- [ ] **Step 2: Validate YAML locally**

Run: `node -e "const f=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/npm test/.test(f)||!/docker build/.test(f)) throw new Error('missing steps'); console.log('ci.yml looks well-formed')"`
Expected: `ci.yml looks well-formed`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests and docker build on push and PR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase 1 sections):**
- 1.1 Git + hygiene → Task 1 ✓
- 1.2 Configuration surface (`.env.example`) → Task 3 ✓
- 1.3 Packaging (Dockerfile, compose, dockerignore) → Task 4 ✓
- 1.4 Documentation (English README + docs/) → Task 5 ✓
- 1.5 OSS hygiene → Task 6 ✓
- 1.6 Tests + CI → Tasks 2 + 7 ✓
- 1.7 Minor hardening → Task 3 (headers/body-limit tests; change only if a gap is proven) ✓

**Placeholder scan:** Prose docs (Tasks 5–6) specify concrete section lists and required content, not "write appropriate docs." All code/config steps contain full file contents. No `TODO`/`TBD`.

**Type consistency:** `startTestServer()` returns `{ url, port, close }` and is consumed identically in every test file; `api(base)` returns `{ get, post }` used consistently. `startServer(port, host)` matches `server/app.js` signature.

**Known risk flagged in-plan:** `socket.io-client` availability (Task 2 Step 6) has a fallback. Docker availability (Task 4 Steps 4–5) has a fallback to CI.

---

## Follow-on plans

- Phase 2 — File & image uploads (separate plan).
- Phase 3 — Admin / workspace management (separate plan).
