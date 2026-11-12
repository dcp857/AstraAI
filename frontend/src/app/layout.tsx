import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Astra — Your AI workspace",
  description: "A thoughtful AI workspace for questions, ideas, and the work ahead.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
