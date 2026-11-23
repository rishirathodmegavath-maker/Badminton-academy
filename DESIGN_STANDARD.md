# Design standard (Wave 5)

The written standard for the Badminton app's look (UX-D4, option A: a written standard plus a tokens file). The tokens live in
`src/app/tokens.css`; the breakpoint widths are also in `src/shell/breakpoints.ts`. `tests/design-standard.test.ts` keeps the rules below
true. `npm run check:contrast` keeps the colour pairs accessible.

## 1. Rules
1. **Colours come from tokens.** Do not write a hex colour in a stylesheet. A test counts hard-coded colours per stylesheet and fails if
   any count rises. When you replace some, lower the number in `tests/fixtures/design-colour-baseline.json` in the same change.
2. **Font sizes come from the type scale** (`var(--fs-*)`). A test fails on any `font-size` in px or rem.
3. **Widths in `@media` come from the breakpoint scale.** A test fails on any other width.
4. **Controls are at least 44 px on touch screens** (`--touch`). New buttons that set a smaller `min-height` must also set 44 px under
   `@media (pointer: coarse)`.
5. **Nothing may scroll sideways** at 320, 390, 768, 1024 or 1440 px.

## 2. The scales

| Thing | Tokens |
|---|---|
| Brand | `--navy`, `--navy-deep`, `--navy-soft`, `--green`, `--green-dark`, `--green-graphic` (icons only), `--mint`, `--mint-strong`, `--lime` |
| Surfaces | `--bg` (page), `--surface` (cards), `--surface-sunken`, `--hover-bg`, `--white` (text on dark or coloured surfaces) |
| Text | `--ink`, `--text-muted`, `--disabled-text`, `--link` |
| Borders | `--line` (card edges), `--line-soft` (faint separators inside a card), `--border-strong` (form controls, 3:1) |
| Status | `--success`/`--success-bg`, `--warning`/`--warning-bg`, `--error`/`--error-bg`, `--info`/`--info-bg` (text colour on its tint) |
| Focus | `--focus`, `--focus-on-dark`, `--focus-ring` |
| Type | `--fs-2xs` 11, `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 14, `--fs-base` 16, `--fs-lg` 18, `--fs-xl` 20, `--fs-2xl` 24, `--fs-3xl` 28, `--fs-4xl` 32 (px). One font: Noto Sans |
| Space | `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 24, `--space-6` 32, `--space-7` 40, `--space-8` 48 (px) |
| Shape | `--radius-sm` 7, `--radius` 10, `--radius-lg` 14; `--shadow`, `--shadow-raised`, `--lift-shadow`, `--lift-shadow-strong` |
| Touch | `--touch` 44 |

Breakpoints (write max-width as the step minus 1 and min-width as the step, so queries never overlap or leave a gap):

| Name | max-width | min-width | What changes |
|---|---|---|---|
| phone-small | 479 | 480 | tightest paddings |
| phone | 767 | 768 | drawer menu and bottom bar; one panel at a time in Training |
| tablet | 1023 | 1024 | phone and tablet layouts end here; the header drops the account name |
| laptop | 1279 | 1280 | **the sidebar is a drawer up to here and stays on screen from 1280** (owner decision, 23 Nov 2026) |
| wide | 1535 | 1536 | extra columns on wide screens |

## 3. What is deliberately not done
- **The report studio and the printed report card keep their own palette** (`--rs-*` in `redesign.css`), because they are meant to look like
  the Football report. They are inside `.report-studio` and `.rs-sheet` only.
- **About 370 older hard-coded colours remain** (they were 506 before Wave 5). They are frozen by the ratchet and should be replaced when
  the rule they sit in is next touched; replacing them in bulk would change how screens look.
- **Spacing is a scale for new code, not enforced.** Existing padding, margin and gap values were left alone: the same number of pixels, a
  different spelling, and a very large diff to review.
- **Attendance screens were not changed** (they wait for the coach trial).
