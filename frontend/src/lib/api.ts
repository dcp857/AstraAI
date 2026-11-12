function apiBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  const localHosts = new Set(["localhost", "127.0.0.1"]);
  if (typeof window === "undefined") {
    if (process.env.NODE_ENV === "development") {
      const serverUrl = configured ? new URL(configured) : null;
      if (!serverUrl || localHosts.has(serverUrl.hostname)) return "";
    }
    return (configured || "http://localhost:8000").replace(/\/$/, "");
  }
  const parsed = configured ? new URL(configured, window.location.href) : null;

  // Route local requests through Next.js so the browser never has to resolve
  // localhost:8000 itself (Windows may resolve it to ::1 while Uvicorn only
  // listens on 127.0.0.1). This also keeps auth cookies same-origin.
  if (!parsed || (localHosts.has(parsed.hostname) && localHosts.has(window.location.hostname))) return "";
  return parsed.toString().replace(/\/$/, "");
}

export function apiUrl(path: string) {
  const base = apiBaseUrl();
  if (path) return `${base}${path}`;
  return base || "http://127.0.0.1:8000";
}

export async function readApiJson<T = any>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) {
      throw new Error(`Astra API request failed (HTTP ${response.status}). Check the Python backend terminal for details.`);
    }
    throw new Error("Astra API returned an invalid response.");
  }
}
