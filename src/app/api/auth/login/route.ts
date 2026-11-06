import { NextResponse } from "next/server";
import { checkPassword, createSession, hasAuthConfiguration, isSameOrigin } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  if (!hasAuthConfiguration()) return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  let body: { password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (!checkPassword(body.password)) return NextResponse.json({ error: "That password did not match." }, { status: 401 });
  await createSession();
  return NextResponse.json({ ok: true });
}
