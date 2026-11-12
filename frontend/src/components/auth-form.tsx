"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { apiUrl, readApiJson } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const registering = mode === "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/auth/${mode}`), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || "Could not continue.");
      window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not continue."); }
    finally { setBusy(false); }
  }

  return <main className="auth-page">
    <div className="auth-aside"><Link className="brand-lockup" href="/"><span className="brand-mark">✳</span><span>astra</span></Link><div className="auth-aside-copy"><p>“A little space can change the way you see a problem.”</p><span>Your ideas have somewhere to go.</span></div><span className="auth-aside-foot">A private workspace for curious minds.</span></div>
    <section className="auth-main"><ThemeToggle className="auth-theme"/><div className="auth-card">
      <Link className="auth-back" href="/">← Back to Astra</Link>
      <p className="auth-kicker">{registering ? "A workspace of your own" : "Welcome back"}</p>
      <h1>{registering ? "Start with a thought." : "Good to see you again."}</h1>
      <p className="auth-subtitle">{registering ? "Create your account and make room for what’s next." : "Sign in to return to your conversations."}</p>
      <form className="auth-form" onSubmit={submit}>
        {registering && <label>Your name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How should we address you?" required maxLength={80}/></label>}
        <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required maxLength={254}/></label>
        <label>Password<input type="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={registering ? "At least 10 characters" : "Your password"} required minLength={registering ? 10 : 1} maxLength={256}/></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="auth-submit" disabled={busy}>{busy ? "One moment…" : registering ? "Create account" : "Sign in"}<span>↗</span></button>
      </form>
      <p className="auth-switch">{registering ? "Already have an account?" : "New to Astra?"} <Link href={registering ? "/login" : "/register"}>{registering ? "Sign in" : "Create an account"}</Link></p>
      {registering && <p className="auth-terms">Your conversations are private to your account. Choose a password you can keep secure.</p>}
    </div></section>
  </main>;
}
