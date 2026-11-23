import type { Metadata } from "next";
import "./globals.css";
import './operations.css';
import './redesign.css';
import './tokens.css';
import './shell.css';
import './auth.css';
export const metadata: Metadata = {
  title: { default: "Sportozen · Badminton Academy", template: "%s · Sportozen" },
  description:
    "The badminton academy workspace: training, players, attendance, reports, fees and family communication in one private place.",
};
// Browser extensions (translators, dark-mode and colour tools, password managers) add attributes to <html> and <body> before React
// starts. suppressHydrationWarning tells React not to report that one-level difference as a hydration error; nothing else is hidden.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
