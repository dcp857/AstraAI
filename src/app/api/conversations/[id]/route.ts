import { NextResponse } from "next/server";
import { hasSession, isSameOrigin } from "@/lib/auth";
import { prisma } from "@/lib/db";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await context.params;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" }, select: {
        id: true, role: true, content: true, provider: true, model: true, createdAt: true,
        attachments: { select: { id: true, groupId: true, fileName: true, mimeType: true, kind: true, byteSize: true, frameIndex: true, frameTime: true } },
      } } },
    });
    if (!conversation) return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    return NextResponse.json({ conversation });
  } catch {
    return NextResponse.json({ error: "Could not load this chat." }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await context.params;
  let body: { title?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 100) {
    return NextResponse.json({ error: "Title must be between 1 and 100 characters." }, { status: 400 });
  }
  try {
    const conversation = await prisma.conversation.update({ where: { id }, data: { title: body.title.trim() }, select: { id: true, title: true, updatedAt: true } });
    return NextResponse.json({ conversation });
  } catch {
    return NextResponse.json({ error: "Could not update this chat." }, { status: 404 });
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await context.params;
  try {
    await prisma.conversation.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not delete this chat." }, { status: 404 });
  }
}
