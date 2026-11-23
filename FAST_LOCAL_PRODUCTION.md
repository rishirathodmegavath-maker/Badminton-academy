# Fast local mode (production build on PostgreSQL)

`npm run dev` compiles each page the first time it is opened (5 to 30 seconds on a modest PC) and runs React's slower
development build. The production build opens the same pages in 150 to 500 ms. It needs PostgreSQL, because production mode
refuses the embedded development database.

```powershell
# Docker Desktop must be running.
powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1 -Seed      # first run, fictional demo data
powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1            # later runs (add -SkipBuild if nothing changed)
```

What it does: creates two random secrets in `.local\` (never committed), starts a PostgreSQL 17 container on 127.0.0.1 only
(`sportozen-pg`, data in a Docker volume), applies the migrations, optionally seeds the fictional academies, builds and runs
the app on `-Port` (default 3100). Sign in as `admin@greenfield.example`; the demo password is in `.local\seed-password.txt`.

Notes
- Real data: never pass `-Seed`.
- Memory: the build needs a few GB. On a PC with about 8 GB, close other servers and Docker apps while it builds.
- Each port gets its own session cookie name (`sz-bd-<port>`), so a Football and a Badminton server on one browser do not sign
  each other out.
- Looks and rules are unchanged; only the way the app is run differs. For a real deployment follow `PRODUCTION_READINESS_REPORT.md`
  (HTTPS `BETTER_AUTH_URL`, `TRUSTED_PROXIES`, `PRIVATE_MEDIA_PATH`, a managed PostgreSQL).
