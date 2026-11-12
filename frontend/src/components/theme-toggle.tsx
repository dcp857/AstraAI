"use client";

import { useEffect, useState } from "react";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const initial = localStorage.getItem("astra-theme") === "dark";
    setDark(initial);
    document.documentElement.dataset.theme = initial ? "dark" : "light";
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    localStorage.setItem("astra-theme", next ? "dark" : "light");
  }

  return <button
    type="button"
    className={`theme-toggle ${className}`.trim()}
    onClick={toggleTheme}
    aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
    title={`Switch to ${dark ? "light" : "dark"} theme`}
  ><span aria-hidden="true">{dark ? "☼" : "☾"}</span></button>;
}
