import { hasAuthConfiguration, hasSession } from "@/lib/auth";
import { Login } from "@/components/login";
import { Chat } from "@/components/chat";

export default async function Home() {
  if (!hasAuthConfiguration()) {
    return <main className="setup-screen"><div className="setup-card">
      <div className="brand-mark">✳</div><p className="eyebrow">A quick setup first</p>
      <h1>Secure your workspace</h1>
      <p className="muted">Open the <code>.env</code> file in your project folder. Set an app password and a random session secret with at least 32 characters.</p>
      <p className="muted">Add your PostgreSQL connection strings and at least one model API key there to start chatting. Keep these values private.</p>
    </div></main>;
  }
  return await hasSession() ? <Chat /> : <Login />;
}
