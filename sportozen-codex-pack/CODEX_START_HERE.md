# Codex task: implement Sportozen Badminton Academy

Act as the implementing engineer. Build working software, not another mockup or architecture-only response. Read repository instructions first. Preserve existing working architecture where suitable; do not rewrite an existing app without evidence. Inspect installed packages and current official documentation before choosing exact package versions. Do not claim tests, integrations or production readiness without evidence.

## Product and scope
A subscription SaaS for independent badminton academies in India and the US. Each academy has private data, branding, branches, staff, players and guardians. Training is organised by batch and player. There is NO court booking, court allocation or court rotation module in this scope. Calendar schedules sessions, batches, coaches and closures.

Navigation: Overview, Admissions, Players, Calendar, Training, Reports, Nutrition, Video & AI Analysis, Fees, Communications, Settings.

Initial delivery: working Training Studio from drill discovery through saving, publishing, running and completing a session. Do not defer persistence, validation, tenant permissions or error handling to the end. Other navigation routes may initially show clearly labelled unfinished states, never fake operational functionality. Continue subsequent stages after this slice passes its checks.

## Architecture
Follow ARCHITECTURE.md. Prefer a modular monolith with TypeScript, a React web framework, PostgreSQL, a migration-capable ORM, server-side validation and accessible UI primitives. For an existing repo, retain compatible conventions. A conventional Next.js application is a proposed default, not a mandate to change frameworks. Keep hosting adapters separate; do not assume Node-only packages work on every host.

Use real authentication and academy memberships. Development demo mode, if needed, must be explicit and disabled by default in production. Never silently fall back to an unrestricted demo identity. No production secrets or real child data in seeds.

## Design references
- references/training-studio.png: visual drill catalogue, preview and multi-drill session builder.
- references/training-plan-prepare.png: discovery, detail, creation and builder.
- references/training-run-session.png: weekly planning, live session, attendance, observations.
- references/training-review-develop.png: player goals, completion, parent preview, saved plans.
- references/training-today.png: daily sessions overview.
- references/fees.png, nutrition.png, communications.png: later modules.
Written rules override image inconsistencies. Do not copy invented image logos. Use a text Sportozen wordmark until approved brand assets are supplied. No association logo or endorsement without authorisation.

Use semantic tokens for colours, spacing and typography. Desktop can have three columns; tablet collapses preview; mobile uses stacked panels or a drawer. No horizontal scrolling for core workflows at 375px. Provide keyboard operation and labelled controls; reordering needs up/down alternatives to drag-and-drop. Define loading, empty, error and disabled states.

## Training screens and behaviour
1. Today: session cards with Draft, Published, In progress, Completed or Cancelled. Filter by branch, batch, coach and date. One clear next action.
2. Drill library: search and filters for technique, level, singles/doubles, suggested duration, player count and equipment. Seed representative overhead, net, defence, serve/return, movement and doubles drills. Support add/remove, favourites and academy-private custom drills. Never imply sample content is federation approved.
3. Drill details: objective, setup, equipment, steps, coaching cues, common mistakes, easier/harder variations and media provenance/review status. Playback controls only when a valid media source exists. If no original/licensed animation exists, show a labelled illustration and 'Demonstration not available'; never present an inert screenshot as a video.
4. Create session: batch, branch/venue, coach, local date/time, duration, theme, custom theme and objective. Optional saved plan. Save incomplete drafts; required publish fields differ from draft fields. Validate safely and preserve entered values on errors.
5. Builder: add multiple drills, duplicates only intentionally, reorder, edit durations and cues, add custom activities. Show total duration, with a clear mismatch warning requiring correction or explicit session-duration update before publication. Include transitions/rest explicitly when used. Save draft, preview, publish.
6. Weekly planner: scheduled sessions grouped by batch and coach, duplicate plan/week with new dates, no duplicate attendance or observations copied. Distinguish goal reuse from performance evidence.
7. Individual adjustments: shared plan applies by default; attach optional selected-player or small-group focus. Reuse active goals across sessions. No required per-player/per-drill paperwork.
8. Live session: current/next activity, elapsed time, pause/resume/next, demonstration, focus cues and quick notes. Starting does not mark attendance or completion. Persist resumable session progress; avoid multiple browser tabs corrupting state. Timer is a coaching aid, not proof of work or performance.
9. Attendance: Present, Absent, Excused, Not marked. Saving is idempotent and auditable. Mark-all action must not overwrite exceptions without explicit confirmation. Historical roster snapshots survive batch transfers.
10. Observations: optional text or a defined drill measurement, author, date, session, drill, conditions and optional attachment. Missing evidence is not poor performance. Private by default; review before parent sharing. Do not generate unexplained overall scores.
11. Player development: active/reviewed goals, linked observations, assessment method and history. Compare only compatible measures and conditions. Clearly separate family-reported practice from coach evidence.
12. Complete session: mark actual activities completed/modified/not completed, optional recap, attendance exceptions and carried-forward goals. Completion does not imply every goal improved. Preserve plan versus actual records.
13. Parent preview: approved schedule/focus and reviewed outcomes for that guardian's children only; exclude internal notes and other players. Explicit preview, recipient review and approved scheduling. Never auto-send on session completion.
14. History and saved plans: filter, view, duplicate, archive, create custom drills, version templates. Editing a source drill must not rewrite old sessions or reports.

## Later modules
Admissions: enquiries, trials, follow-ups, conversion preserving identity, waiting lists and capacity.
Players: juniors/adults, multiple guardians/children, age category distinct from training placement, transfers and temporary pauses.
Reports: draft from recorded evidence, coach approval, academy branding, private PDF, revision history. Monthly reports are not silently republished after edits.
Fees: academy fee plans, invoices, partial payments, manual verification, receipts, refunds and separate lesson/make-up credit ledgers. Use currency plus integer minor units; no floating-point money. Parent payment reference is not verified payment. Pending includes overdue; do not add both in headline totals. Sportozen subscription billing is separate.
Nutrition: dietary preferences/restricted information, professional-reviewed plans, review history and private parent questions. No autonomous prescriptions, supplements, calorie targets or medical recommendations. Ordinary coaches cannot approve personalised clinical guidance.
Communications: individual/selected/all-batch recipients, guardian deduplication, channel preferences/consent, draft preview, templates, scheduled outbox and delivery states. Provider adapters disabled until configured. No actual send without explicit approved action. Scheduled worker rechecks consent/access at delivery time. Provider receipt is not evidence of a human reading.
AI Analysis: visible Coming Soon, no active analysis/payment action or fabricated results. Manual video review works independently.
Settings: branding, branches, roles, regional defaults, academy policies, feature entitlements, integrations, subscription. One shared product; country defaults, plan entitlements and academy settings combine server-side. Privileged overrides auditable. Academy admins cannot grant paid/locked capabilities to themselves.

## Security and integration rules
Enforce academy scope on every query, mutation, export and media URL. Do not trust a client-supplied academy ID. Resolve guardian-child links server-side. No public child profiles or public report URLs. Use least privilege, expiring signed media URLs and explicit retention configuration. Background jobs carry academy context. Log consequential changes without storing secrets or sensitive message bodies unnecessarily.
Validate MIME/type/size and use private object storage for uploads. Provider credentials remain server-side. Add gateway/messaging interfaces, webhook signature validation, replay protection and idempotency when integrations are implemented. Never mock successful delivery in production.
Timezone: store instants in UTC plus academy IANA timezone; handle daylight-saving ambiguity explicitly for US recurring sessions. Currency/timezone defaults do not determine guardian rights or feature permissions.

## How to work and deliver
Implement in small coherent stages using DELIVERY_CHECKLIST.md. Create migrations and fictional seeds. Maintain .env.example without values. Document setup/run/test/migrate commands and blockers. Run meaningful domain, cross-tenant permission and end-to-end tests. Report the exact stage delivered and what is unfinished. Do not describe disabled placeholders as connected services. Stop only for genuinely missing credentials/decisions; continue independent implementation. Never deploy or connect paid integrations merely to satisfy a screenshot.
