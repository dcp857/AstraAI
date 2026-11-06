import { NextResponse } from "next/server";
import { hasSession, isSameOrigin } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const conversations = await prisma.conversation.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, updatedAt: true },
    });
    return NextResponse.json({ conversations });
  } catch {
    return NextResponse.json({ error: "Could not load chats. Check your database connection and run npm run db:push." }, { status: 503 });
  }
}
