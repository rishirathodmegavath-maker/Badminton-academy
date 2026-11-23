/**
 * The one breakpoint scale (Wave 5). It mirrors the table in src/app/tokens.css; tests/design-standard.test.ts fails if a
 * stylesheet uses a width that is not on it, or if these numbers stop matching the stylesheets that rely on them.
 *
 * Write max-width queries as (step - 1) and min-width queries as the step itself, so two queries never overlap or leave a gap.
 */
export const BREAKPOINTS = {
  phoneSmall: 479,
  phone: 767,
  tablet: 1023,
  laptop: 1279,
  wide: 1535,
} as const;

/** Phones: the drawer menu and the bottom bar. One panel at a time in Training. */
export const PHONE_QUERY = `(max-width: ${BREAKPOINTS.phone}px)`;
/** Phones, tablets and laptops below 1280 px: the sidebar is a drawer; from 1280 px it is always on screen (owner decision, shell.css uses the same width). */
export const DRAWER_QUERY = `(max-width: ${BREAKPOINTS.laptop}px)`;
