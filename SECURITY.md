# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository, or contact the maintainer directly. You should receive a response within a few days.

## Deployment recommendations

SlackLite is designed for small-team self-hosting. When exposing an instance to the internet:

- **Always run behind HTTPS.** Use a reverse proxy (Caddy handles TLS automatically) and set `TRUST_PROXY=1`.
- **Set `INVITE_CODE`** to prevent strangers from registering on your instance.
- **Back up the data directory** (`data.db` and `.jwt-secret`). If `.jwt-secret` leaks, rotate it (all sessions are invalidated).
- Login/registration endpoints are rate-limited per IP (30 requests / 15 minutes) out of the box.

## Scope notes

- Message content is HTML-escaped on render; user input is passed to SQLite via parameterized statements only.
- Passwords are hashed with bcrypt (cost 10).
- Sessions are stateless JWTs (30-day expiry); there is no server-side revocation list. Rotate `JWT_SECRET`/`.jwt-secret` to force-invalidate all sessions.
