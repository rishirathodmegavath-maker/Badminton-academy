"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="loading" id="main">
      <section className="ax-state" role="alert">
        <h1>This page couldn’t open</h1>
        <p>Check your connection and the server configuration, then try again. Nothing you entered was lost on the server.</p>
        <div className="button-row">
          <button className="primary" onClick={reset}>
            Try again
          </button>
          <a className="secondary" href="/login">
            Sign in
          </a>
        </div>
      </section>
    </main>
  );
}
