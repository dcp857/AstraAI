import { NextResponse } from "next/server";
import { clearSession, isSameOrigin } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  await clearSession();
  return NextResponse.json({ ok: true });
}
