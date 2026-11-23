# Withdrawing reports and nutrition plans (Phase 6)

How staff take a published report or a shared nutrition plan back from families, and how that differs from revising it.
This is an engineering description, not legal advice.

## Revise is not withdraw

| | REVISE (`reports/update` action `revise`, `nutrition/plan` action `revise`) | WITHDRAW (`reports/withdraw`, `nutrition/withdraw`) |
| --- | --- | --- |
| Working copy | goes back to `DRAFT` for editing | unchanged if a revision is in progress; becomes `WITHDRAWN` if the record itself was published |
| Families | **keep** seeing the last published revision until a new one is approved and published | **stop** seeing it at once: not in the portal, not by id, not as a PDF |
| History | one new revision | one new *withdrawal marker* revision (earlier revisions are never edited or deleted) |
| Needs | a reason (reports) | a real written reason, an explicit confirmation in the screen, the current record version |

## Rule that decides what a family sees

`academy/domain/withdrawal.ts` (`publicationState`): a family sees the **newest published revision that is newer than the newest
withdrawal marker**. Revising never creates a marker; publishing/sharing again after a withdrawal creates a newer published revision
and so is a new, deliberate decision. The same rule is used for the portal payload (`bootstrapAcademy`), direct report access and the PDF
(`reportAccess`), so there is one answer everywhere. PDFs are generated on demand from that answer; nothing stored can outlive a withdrawal.

## Who may withdraw (server-side)

* **Report:** OWNER, ADMIN, HEAD_COACH (the same people who may approve and publish), for players they can see. Coaches may draft and submit but not publish, so not withdraw.
* **Nutrition plan:** OWNER, ADMIN, HEAD_COACH and the NUTRITION_PRO (the same people who may share), the professional only for players they have an **active** assignment to.
* Nobody else: coach, finance, guardian and adult player get 403; another academy's id or a guessed id gets 404; a deactivated membership has no session.
* The academy is taken from the session, never from the request.

## What is recorded

* The marker revision (`record_revision`, kind `report` / `nutrition-plan`): `withdrawal = {contentType, withdrawnVersion, actorId, actorRole, at, reason}` plus the record's data and status, at the new record version. Visible to staff who may already see that record's history.
* `audit_event` row `report-withdrawn` / `nutrition-plan-withdrawn` (record id, version, actor).
* Security events `REPORT_WITHDRAWN` / `NUTRITION_PLAN_WITHDRAWN` (Settings -> Security events; owner/admin of the same academy): content kind, record id, withdrawn version and actor role only. **No** child name, content or reason.
* All of this commits or rolls back together with the status change, under the academy lock (the same one every other change takes). A second request for the same version gets `409`; a repeat on the current version gets `409 ALREADY_WITHDRAWN`; a record that was never published gets `409 NOT_PUBLISHED`; a missing/filler reason gets `422 WITHDRAWAL_REASON_REQUIRED`.

## Existing data and migration

No migration. The existing status columns are text and the existing revision history is used, so nothing is backfilled and nothing existing is marked withdrawn. Records published before this change (including ones later revised) can be withdrawn like any other.
`WITHDRAWN` is a new record status; a withdrawn report or plan can be revised again (back to `DRAFT`) and re-published through the normal approval steps.

## Limits

* Withdrawal stops access in this application. It cannot recall a PDF a family member already downloaded, or anything a person copied.
* Re-publication is not blocked; if a withdrawn item must never return, do not approve the revision.
* Reading withdrawn history is not itself logged (Phase 7).
* Erasing withdrawn content is Phase 8, not here.
