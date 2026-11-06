import { NextResponse } from "next/server";
import { hasSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await context.params;
  try {
    const attachment = await prisma.attachment.findUnique({ where: { id }, select: { data: true, mimeType: true } });
    if (!attachment?.data || !attachment.mimeType.startsWith("image/")) return NextResponse.json({ error: "Image not found." }, { status: 404 });
    return new Response(attachment.data, {
      headers: {
        "content-type": attachment.mimeType,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not load this attachment." }, { status: 503 });
  }
}
