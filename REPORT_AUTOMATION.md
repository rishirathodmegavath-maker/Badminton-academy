# Report automation: batch drafts, owner batch approval, parent-wise sending

Status: implemented in this project (badminton). Not committed, not deployed. No migration was needed or run.

## What it does

1. **Batch or single player.** Reports → *Batch reports*. Pick a batch (or "all my players") and a month (the previous month is
   already chosen). Tick specific players to work on only them, or leave every box empty to work on everyone listed.
2. **Create drafts.** One click makes a draft for every selected player who has none for that month. A draft is the ordinary
   report: recorded sessions and the player's recorded attendance only, plus a one-line *facts* sentence made from counts
   ("Aadi attended 2 of 3 recorded sessions between … (1 absent). Skills practised: Overhead (2), Doubles (1)."). The coach's
   own sections (summary, strengths, improvements) are never written for them. The facts line becomes the summary only when the
   coach presses *Use this as the summary*.
3. **Ready or flagged.** Every row says *Ready* or lists why not. A flagged report is excluded from batch approval.
4. **Owner batch approval.** The owner opens any row to read or edit the report, then presses *Approve and publish ready
   reports*. A confirmation lists exactly who will be published. Flagged reports are left untouched.
5. **Parent-wise list.** *Send to parents* lists each parent once (a parent with two children in the batch gets one row naming
   both) with WhatsApp, Mail app, Gmail and Outlook buttons that open the sender's own app with the message ready. A missing
   WhatsApp number can be added in the row. Nothing is sent automatically and nothing claims "delivered".

## Rules (one place: `src/modules/reports/domain/batch-rules.ts`)

A report is **not ready** when any of these is true:

| Code | Meaning |
| --- | --- |
| `NO_PRESENT_SESSION` | The player was not recorded present in any session in the period. |
| `ATTENDANCE_NOT_MARKED` | At least one session has no attendance mark for the player. |
| `SUMMARY_EMPTY` | The coach summary is empty. |
| `STRENGTHS_EMPTY` | Strengths are not written. |
| `IMPROVEMENTS_EMPTY` | Areas to improve are not written. |

Older drafts that carry no attendance snapshot are judged only on what the coach wrote. A flagged report can still be fixed and
approved by hand through the existing single-report flow.

## Evidence: what the code did before, and what was reused

| Need | Existing code reused | Where |
| --- | --- | --- |
| Draft assembly from recorded sessions | `createReport` (unchanged logic; it now also stores `facts`) | `src/modules/reports/application/service.ts` |
| Lifecycle DRAFT → IN_REVIEW → APPROVED → PUBLISHED, versions, history, attribution | `updateReport` (batch approval calls it, one step at a time) | same file |
| Who may see which player | `accessiblePlayers` (owner/admin/head coach: all; coach: own batches) | `academy/application/access.ts` |
| Parents of a player and how to reach them | `parentsOf` / `linkedRecipients` | `communications/application/share-targets.ts` |
| WhatsApp / Mail / Gmail / Outlook buttons, add-a-number | `ShareList` (now exported) | `academy/ui/sharing.tsx` |
| Storage | `player_report.data` (jsonb). `facts` is one optional key, so **no migration** | `infrastructure/database/schema.ts` |

New code: `reports/domain/batch-rules.ts` (pure rules), `reports/application/batch.ts` (view, create drafts, approve),
`reportBatchShare` in `share-targets.ts`, the *Batch reports* screen, four routes (`reports/batch-view`,
`reports/batch-drafts`, `reports/batch-approve`, `communications/report-batch-share`).

## Guarantees

- **No duplicates.** A report for the same player and period is never made twice (a withdrawn one does not count).
- **Per report, never all-or-nothing.** Each report is approved in its own transaction with the existing version check. One
  failure never undoes or blocks the others; the result lists each report's outcome.
- **Authority unchanged.** Drafting needs `reports.author`; approving needs `reports.approve` (a coach is refused with 403);
  the parent list needs `comms.author`. Approver attribution comes from the signed-in session, as before.
- **Scope unchanged.** A coach sees only their own batch. Another academy's players never appear and cannot be drafted or approved.
- **Privacy unchanged.** Only a published report reaches a parent. The message carries a link to the private sign-in page, never
  the report's content. Players are under 18; their parents are the recipients.
- **No automatic sending of any kind.** No WhatsApp API, no e-mail provider, no credentials.

## Shared design with the football app

The two apps are separate code bases with no shared package, so they cannot literally import the same module. What is shared is
the **contract**, kept identical so football can adopt it without redesign:

1. *Assemble* a draft per player and period from recorded sessions and attendance only (football: `assembleMonthly`).
2. *Judge* a draft with a pure `reportIssues(draft)` list (the table above). Football's monthly report has the same needs
   (attendance, evidence, an approver) and already has a review workspace; it needs only the issue list and a batch approve.
3. *Approve a batch* by calling the existing single-report approval per report and returning per-report outcomes.
4. *Group recipients by parent* so one message covers all of a parent's children.

Football today: monthly reports are prepared one player at a time (`monthlyPrepare`), weekly plans are prepared per batch
(`weeklyPrepare` with `playerIds`), there is a review workspace and a report-sharing list. Football adoption is a separate,
later step (see below); football was not changed here.

## Dependencies and risks (identified before building)

- The report feature must be enabled for the academy (`requireFeature("reports")`).
- Players need recorded, completed sessions with attendance marked; without them a player is skipped with a plain reason.
- Parents need a linked parent account. A parent without a WhatsApp number is still listed; the number is added in the row.
- A report can be edited only while it is a DRAFT. Approving by batch publishes: families see it from that moment.
- Payload snapshots (`role-payload`, `family-portal-isolation`) pin the academy payload exactly, so nothing was added to it.

## Not in this step (roadmap, in order)

1. Football adoption of the same contract (issues list, batch approve, parent-wise list) after the football monthly report
   design work is complete.
2. Reminders to coaches for sessions finished without attendance.
3. Fee reminders and fee automation.
4. Weekly digest for parents.
5. Birthday and age-category flags.
6. Nudges for unused invitations.
7. Scheduled delivery of messages without anyone pressing a button.
8. Automated e-mail (needs a chosen sender and credentials; deliberately deferred).

## What the family sees: progress against the period before (acceptance hardening)

The published report and its PDF are drawn from ONE model (`reports/domain/report-sheet.ts`), so the screen and the PDF carry the
same facts. Since this step that model includes a section, **Progress compared with the period before**, built from the analysis
snapshotted when the draft was made (so it is covered by the report's approval and its version history, and a revision keeps it):

- attendance as "n of N sessions (x%)" for this period and the period before, and the difference in percentage points;
- practice minutes by area (technical, tactical, physical, other) for both periods, with a total;
- the count of reviewed coaching observations per category, and each reviewed observation shown with its category;
- a **"Not recorded in this period"** list: no earlier period to compare with, sessions whose attendance was never marked, no practice
  time recorded, areas with no reviewed observation, observations without a category;
- the coach's summary, strengths, areas to improve, development priorities and closing note, as before.

The percentage is attended / sessions with a recorded status, the same rule as the headline figure, so the two can never disagree.
Wording is numbers only ("50 percentage points higher than before"): never "improved", "struggled", a score or a rating.

Never shown to a family: private working notes, the session recap, any observation the coach did not review, the counts-only
"facts" drafting aid (removed from the family's data as well as from the screen and PDF), or any other family's report. A report
made before the comparison existed has no analysis and simply shows no such section. Tests: `report-sheet`, `report-progress`
(publish → family payload → PDF text, equal on both; privacy; revision keeps the snapshot) and the browser test in
`tests/e2e/dispatch-reports.spec.ts`.
