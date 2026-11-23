import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <main className="loading ax-notfound" id="main">
      <section className="ax-state" aria-labelledby="nf-title">
        <Compass size={30} aria-hidden="true" />
        <h1 id="nf-title">We couldn’t find that page</h1>
        <p>The address may be mistyped or the page may have moved. Your records are safe.</p>
        <div className="button-row">
          <Link className="primary" href="/">
            Go to my workspace
          </Link>
          <Link className="secondary" href="/login">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
