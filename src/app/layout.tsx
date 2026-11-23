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
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
