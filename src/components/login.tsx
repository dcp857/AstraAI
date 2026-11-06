"use client";

import { FormEvent, useState } from "react";

export function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not sign in.");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.");
    } finally { setBusy(false); }
  }

  return <main className="login-screen">
    <section className="login-card">
      <div className="brand-lockup"><div className="brand-mark">✳</div><span>astra</span></div>
      <p className="eyebrow">YOUR PRIVATE AI WORKSPACE</p>
      <h1>A little space<br />to think out loud.</h1>
      <p className="muted login-copy">A clear mind starts with a good conversation.</p>
      <form onSubmit={submit} className="login-form">
        <label htmlFor="password">Workspace password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Opening your space…" : "Continue"}<span aria-hidden="true">↗</span></button>
      </form>
      <p className="login-foot"><span className="status-dot" /> Private by design · Only you can access this space</p>
    </section>
    <div className="login-orbit orbit-one"/><div className="login-orbit orbit-two"/>
  </main>;
}
