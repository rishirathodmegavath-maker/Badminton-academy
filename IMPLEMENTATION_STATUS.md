# Training Studio delivery evidence

Verified on 16 October 2026, Asia/Kolkata, in the connected local repository. No deployment, Git push, external messaging or paid integration was performed.

The original package's initial training workflow is implemented. This is the first working slice across stages 1–3, with the remaining scope itemised in README.md; the entire delivery checklist is not complete.

## Evidence

- `npm run db:migrate`: passed against explicit, file-backed local PGlite PostgreSQL. SQL migrations are under `migrations/`.
- `npm run db:seed`: passed. Two fictional academies, staff memberships, batch assignments, ten fictional players per academy, seven shared sample drills, and an unassigned staff login. No real child data or production secrets.
- `npm run typecheck`: passed. Strict TypeScript; the additional `--noUnusedLocals --noUnusedParameters` check also passed.
- `npm test`: **13 passed, 0 failed**. Uses isolated PostgreSQL storage. Covers incomplete drafts, tenant and batch permissions, database composite constraints, duration validation, UTC/DST conversion, optimistic concurrency, timer state, idempotent attendance with audit events, private observations, completion, cancellation, clean duplication, custom-drill privacy, and historical snapshots after batch/source changes.
- `npm run build`: passed with Next.js 16.4.1. On this Windows environment the sandbox denied package junction creation; rerunning with the required filesystem access passed.
- `npm run test:e2e`: **2 passed, 0 failed** in the final run, including the complete workflow, HTTP permission checks, mobile navigation open/close and the 375px no-horizontal-overflow assertion. The final run respected the persistent login limiter and took about 1.3 minutes. Desktop/mobile screenshots were visually inspected after dialog focus and mobile navigation refinements.
- npm install audit after the targeted development dependency override: **0 known vulnerabilities**. The override and its purpose are documented in README.md.

## Browser story

Staff signs in → server resolves active membership → search/detail drill → create and save draft → reload the saved draft → reject mismatched publication → correct duration and publish → start without marking attendance → pause and reload timer → record attendance with an excused player → save private observation → review actual activity outcome and attendance exceptions → complete → duplicate onto a new date with no attendance, notes or actual results copied.

The second browser test independently confirms anonymous HTTP 401, valid nonmember HTTP 403, another academy's session mutation HTTP 404, and a foreign-origin mutation HTTP 403. Browser page exceptions are collected and must be empty for the workflow test to pass.

## Visual evidence

- `artifacts/training-library-desktop.png`
- `artifacts/training-library-mobile.png` (375px wide; document width must not exceed viewport width)
- `artifacts/training-live-desktop.png`

The interface uses the reference palette and workflow layout, with original schematic illustrations, a text wordmark, real form controls and clear demonstration empty states. Screenshots contain fictional browser-test records. No generated reference image is used as an operational video.

## Boundaries

Only the embedded local PostgreSQL adapter has runtime evidence. Hosted PostgreSQL and production authentication cookies require separate staging verification. There is no production account recovery/onboarding, guardian access, upload storage, report generation, parent approval or provider integration. Later navigation items are labelled unfinished. See README.md for feature gaps and pilot prerequisites.
