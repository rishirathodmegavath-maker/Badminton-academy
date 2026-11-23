# UI reference redesign — 26 October 2026

Source specification: the user's pasted redesign request and the 13-page Sportozen Academy UI Reference PDF. The PDF has a cover, 11 screen concepts and a handoff page. Sample people, values, invented logos and apparent video controls are illustrative, not operational requirements.

| PDF page / screen | Existing reusable logic | Presentation change |
|---|---|---|
| 2 Overview | scoped summaries, sessions, events, invoices, follow-ups | four summary cards; daily sessions beside attention; events below |
| 3 Admissions | enquiry, trial, feedback, conversion and revision services | stage cards, searchable enquiry roster and selected detail panel |
| 4 Players | scoped profiles, guardian links, transfers, session history | roster/profile workspace with profile, development, fees and report tabs |
| 5 Calendar | shared Training sessions, events, recurrence, conflict services | week/month calendar with selected-session panel |
| 6 Training | existing library, builder, live/session workflows | persistent library / drill preview / builder desktop columns |
| 7 Reports | reviewed evidence, approvals, versions, private PDFs | report roster / report preview / review controls |
| 8 Nutrition | private records, professional approval, shared revisions | player roster / structured guidance / review and parent questions |
| 9 Fees | integer money, invoices, verification, refunds, credits | invoice table beside selected family account; verification and credits separated |
| 10 Communications | deduplicated recipients, consent, draft/approval/outbox | inline composition beside channel preview and private conversations |
| 11 Video | private typed uploads, signed access, coach feedback | media viewer / timestamped coaching notes / honest AI Coming Soon panel |
| 12 Settings | academy settings, roles, branches, feature policy | inline settings with regional / modules / integrations panels |

Before screenshots: `artifacts/redesign/before/` (11 desktop + 11 mobile). Rendered reference pages: `artifacts/redesign/reference/`. After screenshots and verification results are available below. Preserve all current records; do not reset the local database. External communication processing is not part of redesign tests.

## Implemented presentation

All 11 reference sections now use their own connected workspace layouts. The original operational controllers and service endpoints are reused. Training keeps the library, selected drill preview and builder visible together on desktop; smaller screens use panel tabs. Calendar uses the same Training records with an hourly week grid, month view, filters and a selected-session panel.

Reports expose a roster, report paper and review checklist together. Nutrition adds optional meal, hydration and training-day sections while preserving the original guidance and prior published revisions. Fees separates invoices, account details, verification and lesson credits. Communications has inline composition, channel preview, recipient preview and the existing approval/scheduling lifecycle. Settings separates regional defaults, academy preferences and platform entitlements. Manual media has native playback, session context, timestamp notes and explicit sharing.

## Data and service changes

- Applied migration 0003: nullable media session link, empty timestamp-note/tag arrays for existing media, and a record-revision uniqueness constraint including entity kind. Existing records and revision contents are preserved.
- Nutrition uses optional structured fields in its existing JSON column; old plans and revision guidance are not rewritten.
- Timestamp submissions validate role, academy/player scope, video type, version and an idempotent note ID. New notes revoke family sharing until explicitly reviewed again.
- Private video transport supports authenticated single-byte ranges and rejects invalid seeks. Every request still checks membership, signed link and retention.
- Message approval digests now use canonical JSON key order, fixing mismatches after database JSONB round trips. Exact content/recipient approval and consent rechecks remain enforced. Older pending approvals made with the prior hash may require revision and fresh approval.

## Verification

- TypeScript, including noUnusedLocals and noUnusedParameters: passed.
- Service/unit suite: 25 passed, 0 failed. Covers admission conversion; Calendar conflicts, rescheduling and timezones; Training lifecycle and immutable snapshots; payment/refund/receipt/credit logic; reviewed reports and private PDFs; professional nutrition approval and privacy; consent/deduplication/approval; media typing/signatures/revocation/timestamp idempotency; byte ranges; tenant isolation and locked entitlements.
- Browser workflows: Training discovery/save/publish/attendance/observations/completion/duplication; authentication/tenant/nonmember/origin checks; operational report/nutrition/fees/announcement/video forms; admission follow-up/settings/player-development navigation and tablet layout. Final full browser run: 4 passed, 0 failed (4.9 minutes), using Webpack.
- Captured 11 desktop and 11 mobile after screens. Every screen completed without a page exception or horizontal page overflow at 390px. Additional tablet check at 820px.
- Screenshot index and comparison viewer: artifacts/redesign/README.md and artifacts/redesign/index.html. Before screenshots reconstruct the archived UI with its original CSS against authenticated local fictional records; QA additions can change counts between captures.

Commands actually used: npx drizzle-kit generate; npm run db:migrate; npm run typecheck -- --noUnusedLocals --noUnusedParameters; npm test; npm run test:e2e (plus focused reruns while correcting issues); node scripts/redesign/capture.mjs; npm run build.

## Remaining differences and configuration

- The composition follows the reference, while operational content reflects available authorised records. Missing portraits use initials. Drill demonstrations use the existing honest illustration state; licensed demonstration media is still needed. Report practice/evidence is shown as recorded text rather than invented photographs or performance scores.
- AI Analysis remains Coming Soon with no analysis, payment or fabricated-result action.
- Email, WhatsApp and subscription checkout remain Not configured. The tests save private drafts and fictional ledger records; they do not send external messages or charge money. The outbox service tests use isolated local databases.
- The working preview uses the existing local PGlite database and private-file adapter. Production still requires PostgreSQL, durable private storage, secrets, backups and genuine provider configuration. No deployment was made.
- Local browser tests add clearly labelled QA records and a real FFmpeg test-pattern video. They do not reset the existing academy.
- Development uses the supported Webpack compiler (npm run dev) and .next-webpack-dev; production uses Turbopack and .next-redesign. This avoids the repeated Turbopack development-watcher reloads observed in this OneDrive workspace. First cold development compilation can still be slow on the local 8 GB machine.

Final build: passed without warnings. Final strict type check: passed. Final browser suite: 4/4 passed. Additional smoke check: multi-drill draft persistence, preview retention, reorder/remove, custom activity and duration editing passed; outbox processing control present and deliberately not invoked.

Additional verification command: node scripts/redesign/smoke.mjs. Production builds were run with native Windows filesystem access because the restricted sandbox blocks Next.js package junctions. Runtime private media is explicitly excluded from build tracing.

Delivery: exports/Sportozen-Redesigned-App.zip contains application source, public assets, migrations, scripts, tests and documentation. exports/Sportozen-Redesign-Review.zip contains the 44 before/after screenshots, comparison viewer and verification notes. Neither archive includes .env.local, databases, private uploads, node_modules or authentication traces.
