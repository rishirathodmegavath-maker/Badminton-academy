# Maintainable architecture

## Structure
Suggested layout (adapt names to the repository):

```text
src/
  app/                         # thin routes, layouts, transport entrypoints
  modules/
    identity/ academies/ admissions/ players/ calendar/
    training/ reports/ nutrition/ fees/ communications/ subscriptions/
  shared/
    ui/ config/ permissions/ validation/ money/ time/ errors/
  infrastructure/
    database/ storage/ jobs/ audit/ providers/
prisma/ or equivalent migrations/
tests/ domain/ integration/ e2e/
references/
```

Within each feature use domain/, application/, infrastructure/, ui/ as warranted. Domain rules do not import React, route handlers, ORM clients or provider SDKs. Application services enforce permissions and transactions. Repositories encapsulate persistence. UI calls typed application boundaries; it does not access the database. Avoid meaningless wrappers around every function or a generic repository that obscures tenant scope.

## Core model
Academy, Branch, User, Membership, Role/Permission, Player, GuardianLink, Batch, Enrollment, CoachAssignment, Drill, DrillVersion, DrillMedia, PlanTemplate, TemplateVersion, Session, SessionActivity, SessionRoster, IndividualGoal, SessionAdjustment, Attendance, Observation, AssessmentDefinition, AssessmentResult, SessionProgress, Report, ReportRevision, Approval, MediaAsset, ConsentRecord, Invoice, InvoiceLine, Payment, PaymentAllocation, Refund, CreditLedgerEntry, MessageDraft, OutboxMessage, DeliveryAttempt, NutritionPlanVersion, FeatureEntitlement, AuditEvent.

Tenant-owned records carry academyId. Use tenant-qualified unique keys and composite relations to prevent accidental cross-academy references. Shared library drills have explicit platform ownership/read policy; academy drills remain private unless intentionally published through a separate reviewed workflow.

SessionActivity stores an immutable/versioned drill reference and editable session-specific snapshot. SessionRoster snapshots eligible players; attendance is unique per session/player. Publishing uses a transaction and expected-version check. Dates, times and enrolment changes do not rewrite history. Reports retain published revisions. Archive rather than destructive deletion where history depends on a record.

## State machines
Session: DRAFT -> PUBLISHED -> IN_PROGRESS -> COMPLETED; cancellation supported with policy; edits after publication create auditable revisions. Completed corrections require permission, reason and history, never silent rewriting.
Observation: PRIVATE_DRAFT -> REVIEWED -> optionally SHARED. Sharing needs appropriate child/guardian scope.
Report: DRAFT -> IN_REVIEW -> APPROVED -> PUBLISHED; amendments create a new revision.
Payment reference: SUBMITTED -> VERIFIED or REJECTED. Ledger records reconcile independently of screenshots.
Message: DRAFT -> APPROVED -> SCHEDULED -> PROCESSING -> provider acceptance/delivery/failure, with idempotent retries. Changes invalidate prior approval as appropriate.
Drill content: DRAFT -> IN_REVIEW -> APPROVED -> ARCHIVED. Only approved appropriate demonstrations should be assigned for family practice.

## Extension points
StorageAdapter, MessagingProvider, PaymentProvider, ReportRenderer and JobScheduler live behind typed interfaces. Runtime validated environment configuration selects adapters explicitly. No secret-dependent fallback to fake success. Feature policy combines deployment capability, country policy, subscription entitlement, academy opt-in and actor permission. Enforce the result at service level, not just the menu.

## Permissions
Owner: academy configuration and authorised financial/staff actions.
Admin: assigned operational actions, not platform entitlements.
Head coach: curriculum and coaching approvals as configured.
Coach: assigned batches/players, plans, attendance and private notes.
Nutrition professional: assigned nutrition records and authorised review.
Guardian: linked children's published records and authorised billing actions.
Adult player: own published records and authorised actions.
Sportozen operator: separately governed platform administration; no default unrestricted child-data browsing.

## Future changes
Add a module without changing unrelated domains. Version assessment definitions and reusable drill content. Use additive migrations/backfills; do not drop production columns casually. Separate external IDs from internal identity. API validation schemas and explicit serializers prevent accidental field exposure. Optimistic concurrency prevents lost updates. Financial and messaging actions use idempotency keys and audit events. Use an outbox for work that must happen after a successful transaction.
