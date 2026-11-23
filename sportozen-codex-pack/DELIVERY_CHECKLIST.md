# Delivery stages and checks

1. Foundation: app shell matching references, design tokens, responsive layout, authentication, academy membership, migrations, typed config, seeded two fictional academies. Test member and nonmember access.
2. Training vertical slice: drill catalogue/detail, fictional players, draft creation, builder, versioned persistence, publish validation. Reload preserves changes; cross-academy reads/writes fail; total minutes and empty drafts behave correctly.
3. Coaching execution: weekly planner, timer progress, roster, attendance, optional observations, goals, completion and history. Test idempotent attendance, cancelled sessions, invalid transitions and concurrent edits. Duplicate plan must not copy actual results.
4. Parent loop: guardian links, approved preview, secure reports/demonstrations and communication drafts. Test parent cannot see another child or private notes, revoked access stops media access, missing media shows a real empty state.
5. Operations: admissions, trials, player transfers, fee ledgers/credits, report approval, nutrition permissions and regional entitlements. Test money arithmetic, partial payments, duplicate references and negative/refund invariants.
6. Providers: configure real email/WhatsApp/payment adapters only when credentials and authorised test recipients are provided. Validate signed callbacks, retry idempotency and consent changes. Keep disabled features honestly labelled.
7. Pilot readiness: account recovery, staff security, backups with restore test, monitoring, privacy/retention setup, accessibility and independent security review appropriate to real children. AI stays Coming Soon.

## Handoff evidence
Document completed stages, commands run, passing/failing tests, screenshots at desktop/mobile if browser QA is available, configuration still required and known limitations. A good-looking screen is not evidence of secure permissions or a production service. Generated reference thumbnails are not real drill videos. All sport-specific instructional content requires qualified coaching review before external presentation as validated curriculum.
