import { NextResponse } from "next/server";
import { hasSession, isSameOrigin } from "@/lib/auth";
import { processAttachment, type AttachmentDescriptor } from "@/lib/attachments";
import { streamModel, type ChatTurn } from "@/lib/ai";
import { prisma } from "@/lib/db";
import { isProviderId, PROVIDERS } from "@/lib/models";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_ATTACHMENT_GROUPS = 5;
const MAX_ATTACHMENT_PARTS = 25;
const MAX_TOTAL_DOCUMENT_CHARS = 80_000;

type StoredAttachmentInfo = { id: string; groupId: string; fileName: string; mimeType: string; kind: string; byteSize: number; frameIndex: number | null; frameTime: number | null };

function event(name: string, data: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseDescriptor(value: unknown): AttachmentDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.groupId !== "string" || !/^[\w-]{8,80}$/.test(item.groupId)) return null;
  if (typeof item.fileName !== "string" || item.fileName.length > 220) return null;
  if (item.kind !== "image" && item.kind !== "document" && item.kind !== "video") return null;
  if (typeof item.mimeType !== "string" || item.mimeType.length > 100) return null;
  return {
    groupId: item.groupId,
    fileName: item.fileName,
    kind: item.kind,
    mimeType: item.mimeType,
    ...(typeof item.frameIndex === "number" ? { frameIndex: item.frameIndex } : {}),
    ...(typeof item.frameTime === "number" ? { frameTime: item.frameTime } : {}),
  };
}

export async function POST(request: Request) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Attachments are too large. Keep the total upload below 24 MB." }, { status: 413 });
  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Use the attachment form to send chat messages." }, { status: 400 });
  }

  let payload: { conversationId?: unknown; content?: unknown; provider?: unknown; model?: unknown; attachments?: unknown[] };
  let uploads: File[];
  try {
    const form = await request.formData();
    const rawPayload = form.get("payload");
    if (typeof rawPayload !== "string") throw new Error("Missing chat message data.");
    payload = JSON.parse(rawPayload);
    uploads = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid attachment request." }, { status: 400 });
  }

  const descriptors = Array.isArray(payload.attachments) ? payload.attachments.map(parseDescriptor) : [];
  if (descriptors.some((item) => item === null)) return NextResponse.json({ error: "One or more attachments have invalid details." }, { status: 400 });
  const validDescriptors = descriptors as AttachmentDescriptor[];
  if (validDescriptors.length > MAX_ATTACHMENT_PARTS || validDescriptors.length !== uploads.length) {
    return NextResponse.json({ error: "Attachment count does not match the uploaded files." }, { status: 400 });
  }
  if (new Set(validDescriptors.map((item) => item.groupId)).size > MAX_ATTACHMENT_GROUPS) {
    return NextResponse.json({ error: "Attach up to five files per message." }, { status: 400 });
  }
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (content.length > 12000) return NextResponse.json({ error: "Message must be 12,000 characters or fewer." }, { status: 400 });
  if (!content && validDescriptors.length === 0) return NextResponse.json({ error: "Write a message or attach a file." }, { status: 400 });
  if (!isProviderId(payload.provider)) return NextResponse.json({ error: "Choose a supported model provider." }, { status: 400 });

  const provider = payload.provider;
  const configured = PROVIDERS.find((item) => item.id === provider)!;
  const model = typeof payload.model === "string" && payload.model === configured.model ? payload.model : configured.model;
  const apiKey = configured.envKey ? process.env[configured.envKey] : "ollama";
  if (!apiKey) return NextResponse.json({ error: `${configured.label} is not configured yet. Add ${configured.envKey} to your .env file.` }, { status: 503 });

  let processedAttachments;
  try {
    const totalBytes = uploads.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_REQUEST_BYTES) throw new Error("Attachments are too large. Keep the total upload below 24 MB.");
    processedAttachments = [];
    let remainingDocumentChars = MAX_TOTAL_DOCUMENT_CHARS;
    for (const [index, file] of uploads.entries()) {
      const processed = await processAttachment(file, validDescriptors[index]);
      if (processed.extractedText) {
        if (remainingDocumentChars <= 0) {
          processed.extractedText = "[Document text omitted because the message reached the total document text limit.]";
        } else if (processed.extractedText.length > remainingDocumentChars) {
          processed.extractedText = `${processed.extractedText.slice(0, remainingDocumentChars)}\n[Further document text omitted to fit the chat context.]`;
          remainingDocumentChars = 0;
        } else {
          remainingDocumentChars -= processed.extractedText.length;
        }
      }
      processedAttachments.push(processed);
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not process an attachment." }, { status: 400 });
  }

  const attachmentNames = [...new Set(processedAttachments.map((item) => item.fileName))];
  const storedContent = content || `Please examine the attached file${attachmentNames.length === 1 ? "" : "s"} and help me understand it: ${attachmentNames.join(", ")}`;
  let conversationId: string;
  let userMessage: { id: string; attachments: StoredAttachmentInfo[] };
  try {
    if (typeof payload.conversationId === "string") {
      const existing = await prisma.conversation.findUnique({ where: { id: payload.conversationId }, select: { id: true } });
      if (!existing) return NextResponse.json({ error: "Chat not found." }, { status: 404 });
      conversationId = existing.id;
    } else {
      const title = (content || attachmentNames[0] || "New chat").replace(/\s+/g, " ").slice(0, 56);
      const created = await prisma.conversation.create({ data: { title } });
      conversationId = created.id;
    }
    userMessage = await prisma.message.create({
      data: {
        conversationId,
        role: "user",
        content: storedContent,
        attachments: { create: processedAttachments.map(({ groupId, fileName, mimeType, kind, byteSize, frameIndex, frameTime, data, extractedText }) => ({
          groupId, fileName, mimeType, kind, byteSize, frameIndex, frameTime, data: data ? Buffer.from(data) : null, extractedText,
        })) },
      },
      include: { attachments: { select: { id: true, groupId: true, fileName: true, mimeType: true, kind: true, byteSize: true, frameIndex: true, frameTime: true } } },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  } catch {
    return NextResponse.json({ error: "Could not save this message. Check your database connection." }, { status: 503 });
  }

  let history: ChatTurn[];
  try {
    const storedMessages = await prisma.message.findMany({
      where: { conversationId }, orderBy: { createdAt: "desc" }, take: 24,
      include: { attachments: { select: { fileName: true, mimeType: true, kind: true, data: true, extractedText: true, frameIndex: true } } },
    });
    history = storedMessages.reverse().flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const documents = message.attachments.filter((item) => item.extractedText).map((item) => `\n\n[Attached document: ${item.fileName}]\n${item.extractedText}`);
      const images = message.attachments
        .filter((item) => item.data && (item.kind === "image" || item.kind === "video"))
        .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0))
        .map((item) => ({ mimeType: item.mimeType, data: Buffer.from(item.data!).toString("base64") }));
      return [{ role: message.role, content: `${message.content}${documents.join("")}`, ...(images.length ? { images } : {}) }];
    });
  } catch {
    return NextResponse.json({ error: "Could not read this chat from the database." }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = "";
      try {
        controller.enqueue(encoder.encode(event("meta", { conversationId, messageId: userMessage.id, attachments: userMessage.attachments })));
        for await (const token of streamModel(provider, model, history, request.signal)) {
          answer += token;
          controller.enqueue(encoder.encode(event("token", { text: token })));
        }
        if (!answer.trim()) throw new Error("The model returned an empty response.");
        await prisma.message.create({ data: { conversationId, role: "assistant", content: answer, provider, model } });
        await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        controller.enqueue(encoder.encode(event("done", { conversationId })));
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "The response was interrupted. The partial answer was not saved."
          : error instanceof Error ? error.message : "The model could not complete this response.";
        try { controller.enqueue(encoder.encode(event("error", { message }))); } catch { /* client disconnected */ }
      } finally {
        try { controller.close(); } catch { /* client disconnected */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
