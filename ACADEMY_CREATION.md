# Starting an academy (self-service)

Until this change the only way to get an academy owner was for an operator to write one into the database. A person who signed
up (with email or Google) landed on "Not part of an academy yet" with nothing they could do. They can now start an academy of
their own.

## What the person sees
- Signed in with no academy: the `/academies` page shows **Create academy** (academy name and time zone). The time zone starts as
  the browser's own.
- Signed in with academies: a **Start another academy** button under the list.
- After creating, the academy opens straight away and the person is its **Owner**.
- Joining someone else's academy still works through an **invitation link** from that academy's owner.

## What the server does (`POST /api/auth/account/create-academy`)
- Needs a signed-in, ungated session. The request carries only a name and a time zone; the role is always `OWNER`, and any
  other field is ignored.
- Name: whitespace collapsed, 2 to 80 characters, no control characters. Time zone: an IANA zone the runtime knows.
- Writes the academy and its first OWNER membership in one transaction (the database refuses an academy without an owner), then
  chooses the academy for the session.
- One person can own at most 5 academies (`ACADEMY_LIMIT`); creation is rate limited to 5 a minute per client.
- Recorded as `ACADEMY_CREATED` in the academy's security log.
- A new academy is empty (no players, batches or other members). The built-in 50-drill badminton library is available at once
  because it lives in code (see `DRILL_LIBRARY.md`).

## After creating
The owner adds people the usual way: coaches, admins, families and players by invitation link, or by hand in the Players and
settings screens.

## Tests
`tests/academy-creation.test.ts` (name and zone checks, creation over real HTTP, empty academy, bad input, role never taken from
the request, signed-out refusal, the 5-academy limit) and the pinned endpoint list in `tests/auth-endpoint-surface.test.ts`.
