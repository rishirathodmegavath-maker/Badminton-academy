"use client";

import { useEffect, useState } from "react";

/**
 * False on the server and until React has attached the page's handlers, then true.
 *
 * Every credential form disables its submit button until this is true. Before hydration a native submit would be
 * handled by the browser, not by the page's handler, and a form without a method sends its fields (password,
 * code) to the address bar as a query string. A disabled default submit button also blocks "press Enter in a
 * field", so there is no way to send the form natively. The forms also say method="post" as a second line of defence.
 */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
