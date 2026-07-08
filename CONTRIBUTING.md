# Contributing to SlackLite

Thanks for your interest in contributing! SlackLite aims to stay small, dependency-light, and easy to self-host.

## Development setup

Requirements: **Node.js 23.4+** (Node 24 LTS recommended — uses the built-in `node:sqlite` module).

```bash
git clone https://github.com/Rillmo/slacklite.git
cd slacklite
npm install
npm run dev        # server with auto-restart at http://localhost:3000
```

For the macOS desktop app:

```bash
npm run app        # Electron in dev mode
npm run dist       # package .app / .dmg into release/
```

## Running tests

```bash
npm test
```

Tests use the built-in `node:test` runner against a real server instance on an ephemeral port with an isolated temporary database. Please add tests for new endpoints or socket events.

## Project principles

- **Zero native build dependencies.** SQLite comes from `node:sqlite`; auth uses pure-JS `bcryptjs`. Keep it that way so `npm install` never needs a compiler.
- **No frontend build step.** The client is vanilla JS served statically. No bundlers, no transpilers.
- **Single process.** Server, WebSockets, and DB live in one Node.js process. Horizontal scaling is out of scope; small-team self-hosting is the target.
- **Escape all user content.** Messages are rendered with HTML escaping — never introduce `innerHTML` of raw user input.

## Pull requests

1. Fork and create a feature branch.
2. Keep changes focused; one topic per PR.
3. Make sure `npm test` passes.
4. Describe *why*, not just *what*, in the PR description.

## Reporting bugs

Open a GitHub issue with reproduction steps, expected vs. actual behavior, and your Node.js/OS version. For security issues, see [SECURITY.md](SECURITY.md).
