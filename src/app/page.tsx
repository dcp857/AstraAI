"use client";

import { useEffect, useState } from "react";
import { Chat } from "@/components/chat";
import { Login } from "@/components/login";
import { apiUrl } from "@/lib/api";

type Status = { configured: boolean; authenticated: boolean };

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(apiUrl("/api/status"), { credentials: "include" })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Could not connect to the Python backend.");
        setStatus(value);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not connect to the backend."));
  }, []);
  if (error) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">✳</div><p className="eyebrow">BACKEND CONNECTION</p><h1>Start Astra’s Python service</h1><p className="muted">{error}</p><p className="muted">From the project folder, run <code>python -m uvicorn backend.main:app --reload --port 8000</code>.</p></div></main>;
  if (!status) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">✳</div><p className="muted">Connecting to Astra…</p></div></main>;
  if (!status.configured) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">✳</div><p className="eyebrow">A quick setup first</p><h1>Secure your workspace</h1><p className="muted">Configure <code>APP_PASSWORD</code>, a random <code>SESSION_SECRET</code> of at least 32 characters, and <code>DATABASE_URL</code> in the root <code>.env</code> file.</p><p className="muted">Add at least one model API key, or run Ollama locally, to start chatting.</p></div></main>;
  return status.authenticated ? <Chat /> : <Login />;
}
