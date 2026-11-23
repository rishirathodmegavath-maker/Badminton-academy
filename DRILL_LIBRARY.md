# Badminton drill library (50 drills)

Written for: the academy owner and the coaches who will review the drills.

This copy of the badminton app has a built-in library of **50 drills**, shown the same way the football app shows its library: groups with counts, a card for each drill, and a detail view with the objective, set-up, steps, coaching cues, common mistakes, easier and harder versions, safety notes and a suggested minimum age.

| Group                             | Drills | Numbers |
| --------------------------------- | ------ | ------- |
| Footwork & agility                | 10     | 1–10    |
| Multi-shuttle feeding             | 10     | 11–20   |
| Shot consistency & rallies        | 10     | 21–30   |
| Solo & wall practice              | 5      | 31–35   |
| Off-court strength & conditioning | 15     | 36–50   |

## Where it lives

- `src/modules/training/domain/catalogue/` holds the drills as code (one file per group, `define.ts` for the shared helper and safety lines, `index.ts` for the combined list). It is read-only at run time and changes only with a reviewed release, like the football library.
- The training service returns the 50 drills first, then the academy's own private drills. A session can use a library drill by its id (`bd-01` to `bd-50`); the session keeps a snapshot of the drill as it was.
- The original eight sample drills (`sample-drills.ts`) are unchanged. They are only used by the fictional development seed and the existing tests.

## Skills and reports

Each drill has one of the existing skills so the monthly report keeps grouping work by skill. The off-court drills use a new skill, **Fitness**, shown in reports as "Strength & conditioning". Academies can also pick Fitness for their own private drills.

## Content and review status

- The drill names and the one-line ideas come from a list the owner supplied. **All descriptions, steps, cues, mistakes, variations and safety lines were written for Sportozen in original wording.** No text was copied from the web pages the list was taken from, and none of those pages was opened or verified.
- Every drill is labelled "Original Sportozen wording · qualified badminton coach review required". **A qualified badminton coach must review the drills before anyone relies on them.**
- Drills with jumping, loading or heavier exercise carry a suggested minimum age and safety lines (landing, load, band check, warm-up). These are statements for the coach to adapt, not medical advice.
- The court picture on a drill is a generic schematic for its skill, not a drawing of that particular drill.

## Tests

`tests/badminton-catalogue.test.ts` checks: exactly 50 drills numbered 1–50 with unique ids and titles; the group counts 10 / 10 / 10 / 5 / 15; every field filled in; every skill known to the report; minimum ages on the off-court drills; no medical or guaranteed-result wording; lookup by id and version.
