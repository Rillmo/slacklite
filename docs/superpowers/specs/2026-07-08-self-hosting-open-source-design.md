# SlackLite — Open-Source & Self-Hosting Readiness (Design)

**Date:** 2026-07-08
**Status:** Approved (autonomous /goal directive)
**Goal:** Turn the working SlackLite app into a project a stranger can clone from GitHub and self-host reliably, plus round it out with the key features a self-hosted Slack is expected to have.

## Decisions (locked)

- **Docs/i18n:** English docs (README + all OSS/ops docs). App UI stays Korean. No frontend i18n framework this pass.
- **Scope:** Self-host readiness **plus** key features — file/image uploads and admin/workspace management (incl. admin-set password reset). No email/SMTP, no SSO (would break the zero-external-service ethos).
- **Runtime:** `node:sqlite` is stable in Node 24 LTS. Docker image pins `node:24-alpine` (no experimental flag). Bare-metal docs require Node ≥ 23.4, recommend ≥ 24.

## Non-goals (YAGNI)

Email delivery/SMTP, password reset via email, OAuth/SSO, message pagination/infinite scroll, voice/video, mobile apps, Postgres/MySQL support, multi-workspace, message editing history, retention policies. None are needed to self-host a working instance; each adds surface to secure and maintain.

## Current state (baseline)

Functional app: channels, DMs, threads, reactions, edit/delete, unread badges, typing, presence, search, JWT auth, Electron desktop app. Already hardened: security headers, in-memory rate limiter, `trust proxy`, `/healthz`, graceful shutdown, `INVITE_CODE` gate, input validation, persisted JWT secret. **Not** a git repo. No Docker, no `.env.example`, no CI, no tests, no OSS hygiene files. Secrets/artifacts (`.jwt-secret`, `data.db*`, `.DS_Store`, `release/`) sit in the working tree untracked.

## Architecture principle

Keep the app's defining trait: **single Node process, zero external services, one SQLite file.** Everything added must preserve "clone → one command → running instance." Docker is the recommended path (pins the runtime); bare-metal `npm start` stays first-class.

---

## Phase 1 — Self-host readiness (the core of the goal)

**1.1 Git + hygiene**
- `git init`; ensure `.jwt-secret`, `data.db`, `data.db-wal`, `data.db-shm`, `.DS_Store`, `release/`, `node_modules/`, `uploads/`, `.env` are ignored and never committed.
- Expand `.gitignore` (add `data.db-*`, `uploads/`, keep existing).
- Initial commit of source only.

**1.2 Configuration surface**
- `.env.example` documenting every env var with safe defaults and comments.
- Env vars: `PORT`, `HOST`, `DB_PATH`, `JWT_SECRET`, `SECRET_PATH`, `TRUST_PROXY`, `INVITE_CODE`, plus new: `UPLOADS_DIR`, `MAX_UPLOAD_MB`, `ADMIN_USERNAME` (optional bootstrap owner).

**1.3 Packaging**
- `Dockerfile`: `node:24-alpine`, non-root user, `npm ci --omit=dev`, `EXPOSE 3000`, `HEALTHCHECK` hitting `/healthz`, data + uploads on a volume.
- `docker-compose.yml`: app service, named volume for `/data` (DB + secret + uploads), env from `.env`, restart policy. Optional `caddy` profile for automatic HTTPS.
- `.dockerignore`.

**1.4 Documentation (English)**
- Rewrite `README.md` in English (features, quick start via Docker and bare-metal, screenshots optional, license). Preserve current Korean text as `README.ko.md`.
- `docs/SELF_HOSTING.md`: Docker Compose walkthrough, bare-metal, reverse proxy (nginx + Caddy snippets), TLS, backups (copy the SQLite file / `.backup`), upgrades, data location.
- `docs/CONFIGURATION.md`: full env var reference.
- `docs/ARCHITECTURE.md`: process model, data model, socket events, security model.

**1.5 OSS hygiene**
- `CONTRIBUTING.md`, `SECURITY.md` (private disclosure), `CODE_OF_CONDUCT.md` (Contributor Covenant), `CHANGELOG.md` (Keep a Changelog).
- `.github/ISSUE_TEMPLATE/bug_report.md` + `feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md`.

**1.6 Tests + CI**
- Test runner: built-in `node:test` (zero new deps). Tests run against an isolated DB per run (`DB_PATH` pointing at a temp file, or `:memory:`), server started on an ephemeral port.
- **Test isolation refactor:** `db.js` currently opens the DB and seeds at import time as a singleton. Refactor so tests can point at a fresh DB. Minimal approach: `DB_PATH` already read from env at import — tests set `DB_PATH` to a unique temp file before importing, and use a helper to spin up the server via `startServer(0)`. Keep the singleton export for the app; add nothing the app doesn't need.
- Coverage: register/login (happy + rejects), invite-code gate, channel create/join, message send/edit/delete over socket, rate-limit 429, upload accept/reject, admin guard. Target meaningful smoke coverage, not 100%.
- `npm test` script. `.github/workflows/ci.yml`: matrix on Node 24; `npm ci`, `npm test`, `docker build` (no push).

**1.7 Minor hardening (only real gaps)**
- Add a permissive-by-default but configurable Socket.IO/CORS story (same-origin today; document `ORIGIN` if needed). Confirm no open CORS regression.
- Confirm error handler never leaks stack to client (already returns generic msg — verify).
- Ensure `express.json` limit and message-length caps are consistent; add basic per-socket send throttle if trivial (else defer).

---

## Phase 2 — File & image uploads

**Storage:** local disk under `UPLOADS_DIR` (default `<data>/uploads`), volume-mounted. Random unguessable stored filename; original name kept in DB.

**Server:**
- Dep: `multer` (multipart parsing) with limits — `MAX_UPLOAD_MB` (default 10), MIME allowlist (images + common docs), reject executables. One dep, widely used, well understood.
- Schema: `attachments(id, message_id, stored_name, original_name, mime, size, created_at)`; FK to `messages` with `ON DELETE CASCADE`. Message may carry 0..N attachments.
- `POST /api/upload` (auth): accepts a file, stores it, returns an attachment token/id the client includes when sending the message. Message send links pending attachments to the new message.
- `GET /api/files/:id` (auth + channel-membership check): streams the file with `Content-Disposition` and correct `Content-Type`; images inline, others attachment. No static directory exposure — access is authorized per request.
- Cleanup: deleting a message deletes its attachment rows (cascade) and unlinks files.

**Client:** file button in composer, drag/drop optional, inline `<img>` thumbnails for images, filename+size links for other files, download via `/api/files/:id`.

**Security:** size + count limits, MIME allowlist, `nosniff` (already set), never serve from a web-root, randomized names, auth-gated download.

---

## Phase 3 — Admin / workspace management

**Roles & state:**
- `users.role TEXT DEFAULT 'member'` (`member` | `admin`), `users.is_active INTEGER DEFAULT 1`.
- Bootstrap owner: first successfully registered user becomes `admin`; or if `ADMIN_USERNAME` is set, that username is promoted on registration. Migration promotes the earliest user if none is admin.
- Deactivated users cannot log in and their tokens are rejected.

**`requireAdmin` middleware** guarding `/api/admin/*`.

**Admin abilities (no email needed):**
- List users with role/active/created.
- Deactivate / reactivate a user.
- Promote / demote admin (cannot demote the last admin).
- Set a user's password (admin-driven password reset).
- Delete any message; delete any channel (except protecting `general`).

**Client:** minimal admin panel (visible only to admins) — user table with actions, plus admin delete affordances on messages/channels. Keep UI small; reuse existing styles.

**Auth changes:** `login`/token verification reject inactive users; `publicUser` may expose `role` so the client can show admin UI; `requireAuth` loads active user only.

---

## Data model changes (summary)

- `users`: add `role`, `is_active` (with migration for existing rows).
- new `attachments` table.
- Idempotent migrations run at startup alongside existing `CREATE TABLE IF NOT EXISTS` (use `PRAGMA table_info` / `ALTER TABLE ADD COLUMN` guarded).

## Testing strategy (all phases)

`node:test` suites: `test/auth.test.js`, `test/routes.test.js`, `test/sockets.test.js`, `test/upload.test.js`, `test/admin.test.js`. Each spins a server on port 0 with a temp DB, exercises HTTP + socket paths, asserts status/payloads, tears down. CI gates merges.

## Risks / mitigations

- **Node 23 experimental `node:sqlite` warning** → Docker pins Node 24 (stable); README notes it for bare-metal.
- **DB singleton hinders tests** → tests set `DB_PATH` before import; keep refactor minimal.
- **Upload abuse (disk fill, malicious files)** → size/count/MIME limits, auth-gated, randomized names.
- **Locking out admin** → guard against demoting/deactivating the last admin.
- **Scope creep** → phases are independently shippable; verify + commit between phases.

## Definition of done

`git clone` → `cp .env.example .env` → `docker compose up` → working instance at the configured port, with registration, chat, uploads, and an admin owner. CI green. Docs let a stranger operate, back up, and upgrade the instance without reading the source.
