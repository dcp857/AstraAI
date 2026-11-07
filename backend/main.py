from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

import asyncpg
import httpx
from dotenv import load_dotenv
from docx import Document
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel
from pypdf import PdfReader
from io import BytesIO

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

COOKIE_NAME = "chat_session"
SESSION_AGE = 7 * 24 * 60 * 60
MAX_REQUEST_BYTES = 24 * 1024 * 1024
MAX_TOTAL_DOCUMENT_CHARS = 80_000
IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
DOC_EXTENSIONS = {"pdf", "docx", "txt", "md", "csv", "json"}
PROVIDERS = {
    "openai": {"label": "OpenAI", "model": os.getenv("OPENAI_MODEL", "gpt-5.6-sol"), "env": "OPENAI_API_KEY"},
    "anthropic": {"label": "Claude", "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"), "env": "ANTHROPIC_API_KEY"},
    "ollama": {"label": "Ollama · Local", "model": os.getenv("OLLAMA_MODEL", "qwen3.5:4b"), "env": None},
}


def db_url() -> str:
    value = os.getenv("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL is not configured.")
    value = value.replace("postgresql://", "postgres://", 1)
    parsed = urlparse(value)
    query = urlencode([(key, item) for key, item in parse_qsl(parsed.query, keep_blank_values=True) if key != "channel_binding"])
    return urlunparse(parsed._replace(query=query))


async def init_db(pool: asyncpg.Pool) -> None:
    # Names and types match the tables already created by the previous Prisma backend.
    await pool.execute('''
      CREATE TABLE IF NOT EXISTS "Conversation" (
        "id" TEXT PRIMARY KEY, "title" TEXT NOT NULL DEFAULT 'New chat',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS "Message" (
        "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
        "role" TEXT NOT NULL, "content" TEXT NOT NULL, "provider" TEXT, "model" TEXT,
        "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS "Attachment" (
        "id" TEXT PRIMARY KEY, "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
        "groupId" TEXT NOT NULL, "fileName" TEXT NOT NULL, "mimeType" TEXT NOT NULL,
        "kind" TEXT NOT NULL, "byteSize" INTEGER NOT NULL, "frameIndex" INTEGER, "frameTime" DOUBLE PRECISION,
        "data" BYTEA, "extractedText" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
      CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
      CREATE INDEX IF NOT EXISTS "Attachment_messageId_idx" ON "Attachment"("messageId");
      CREATE INDEX IF NOT EXISTS "Attachment_groupId_idx" ON "Attachment"("groupId");
    ''')


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = None
    if os.getenv("DATABASE_URL"):
        app.state.pool = await asyncpg.create_pool(db_url(), min_size=1, max_size=10, command_timeout=60)
        await init_db(app.state.pool)
    yield
    if app.state.pool:
        await app.state.pool.close()


app = FastAPI(title="Astra Python API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in os.getenv("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if item.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(HTTPException)
async def http_error_response(request: Request, error: HTTPException):
    detail = error.detail if isinstance(error.detail, str) else "Request failed."
    return JSONResponse({"error": detail}, status_code=error.status_code, headers=error.headers)


def pool(request: Request) -> asyncpg.Pool:
    value = request.app.state.pool
    if value is None:
        raise HTTPException(503, "DATABASE_URL is not configured.")
    return value


def same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return False
    allowed = {item.strip().rstrip("/").lower() for item in os.getenv("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")}
    return origin.rstrip("/").lower() in allowed


def auth_configured() -> bool:
    return bool(os.getenv("APP_PASSWORD") and len(os.getenv("SESSION_SECRET", "")) >= 32)


def session_signature(expiry: str) -> str:
    secret = os.getenv("SESSION_SECRET", "")
    if len(secret) < 32:
        raise ValueError("SESSION_SECRET must contain at least 32 characters.")
    digest = hmac.new(secret.encode(), expiry.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def has_session(request: Request) -> bool:
    raw = request.cookies.get(COOKIE_NAME, "")
    try:
        expiry, signature = raw.split(".", 1)
        return expiry.isdigit() and int(expiry) >= int(datetime.now(timezone.utc).timestamp()) and hmac.compare_digest(signature, session_signature(expiry))
    except (ValueError, TypeError):
        return False


def require_session(request: Request) -> None:
    if not has_session(request):
        raise HTTPException(401, "Unauthorized.")


def json_error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.get("/api/status")
async def status(request: Request):
    return {"configured": auth_configured() and bool(os.getenv("DATABASE_URL")), "authenticated": has_session(request)}


class LoginBody(BaseModel):
    password: str


@app.post("/api/auth/login")
async def login(body: LoginBody, request: Request):
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    if not auth_configured():
        raise HTTPException(503, "Authentication is not configured.")
    if not hmac.compare_digest(body.password.encode(), os.getenv("APP_PASSWORD", "").encode()):
        raise HTTPException(401, "That password did not match.")
    expiry = str(int(datetime.now(timezone.utc).timestamp()) + SESSION_AGE)
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE_NAME, f"{expiry}.{session_signature(expiry)}", httponly=True, secure=os.getenv("COOKIE_SECURE", "false").lower() == "true", samesite="strict", path="/", max_age=SESSION_AGE)
    return response


@app.post("/api/auth/logout")
async def logout(request: Request):
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@app.get("/api/conversations")
async def list_conversations(request: Request):
    require_session(request)
    rows = await pool(request).fetch('SELECT "id", "title", "updatedAt" FROM "Conversation" ORDER BY "updatedAt" DESC')
    return {"conversations": [{"id": row["id"], "title": row["title"], "updatedAt": row["updatedAt"].isoformat()} for row in rows]}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    require_session(request)
    db = pool(request)
    conversation = await db.fetchrow('SELECT "id", "title", "updatedAt" FROM "Conversation" WHERE "id"=$1', conversation_id)
    if not conversation:
        raise HTTPException(404, "Chat not found.")
    rows = await db.fetch('''SELECT m."id", m."role", m."content", m."model", m."createdAt",
      COALESCE(json_agg(json_build_object('id', a."id", 'groupId', a."groupId", 'fileName', a."fileName", 'mimeType', a."mimeType", 'kind', a."kind", 'byteSize', a."byteSize", 'frameIndex', a."frameIndex", 'frameTime', a."frameTime")) FILTER (WHERE a."id" IS NOT NULL), '[]') AS attachments
      FROM "Message" m LEFT JOIN "Attachment" a ON a."messageId"=m."id"
      WHERE m."conversationId"=$1 GROUP BY m."id" ORDER BY m."createdAt" ASC''', conversation_id)
    messages = [{"id": row["id"], "role": row["role"], "content": row["content"], "model": row["model"], "createdAt": row["createdAt"].isoformat(), "attachments": row["attachments"]} for row in rows]
    return {"conversation": {"id": conversation["id"], "title": conversation["title"], "updatedAt": conversation["updatedAt"].isoformat(), "messages": messages}}


class RenameBody(BaseModel):
    title: str


@app.patch("/api/conversations/{conversation_id}")
async def rename_conversation(conversation_id: str, body: RenameBody, request: Request):
    require_session(request)
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    title = body.title.strip()
    if not title or len(title) > 100:
        raise HTTPException(400, "Title must be between 1 and 100 characters.")
    row = await pool(request).fetchrow('UPDATE "Conversation" SET "title"=$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 RETURNING "id", "title", "updatedAt"', conversation_id, title)
    if not row:
        raise HTTPException(404, "Chat not found.")
    return {"conversation": {"id": row["id"], "title": row["title"], "updatedAt": row["updatedAt"].isoformat()}}


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request):
    require_session(request)
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    result = await pool(request).execute('DELETE FROM "Conversation" WHERE "id"=$1', conversation_id)
    if result.endswith("0"):
        raise HTTPException(404, "Chat not found.")
    return {"ok": True}


def sanitize_name(name: str) -> str:
    base = re.split(r"[/\\]", name)[-1] or "attachment"
    return re.sub(r"[^\w.() -]", "_", base, flags=re.UNICODE)[:180] or "attachment"


def extract_doc(name: str, data: bytes) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in DOC_EXTENSIONS:
        raise ValueError(f"{name} is not a supported document. Use PDF, DOCX, TXT, MD, CSV, or JSON.")
    if ext == "pdf":
        if not data.startswith(b"%PDF-"):
            raise ValueError(f"{name} is not a valid PDF file.")
        text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(data)).pages)
    elif ext == "docx":
        if not data.startswith(b"PK"):
            raise ValueError(f"{name} is not a valid DOCX file.")
        text = "\n".join(paragraph.text for paragraph in Document(BytesIO(data)).paragraphs)
    else:
        text = data.decode("utf-8", errors="replace")
    text = text.replace("\x00", "").strip()
    if not text:
        raise ValueError(f"{name} contains no extractable text. Scanned PDFs need OCR, which is not included yet.")
    return text[:40_000] + ("\n\n[Document text was shortened to fit the chat context.]" if len(text) > 40_000 else "")


async def process_files(payload: dict[str, Any], uploads: list[UploadFile]):
    descriptors = payload.get("attachments", [])
    if not isinstance(descriptors, list) or len(descriptors) != len(uploads) or len(descriptors) > 25:
        raise ValueError("Attachment count does not match the uploaded files.")
    if len({item.get("groupId") for item in descriptors if isinstance(item, dict)}) > 5:
        raise ValueError("Attach up to five files per message.")
    total = 0
    remaining = MAX_TOTAL_DOCUMENT_CHARS
    processed = []
    for desc, upload in zip(descriptors, uploads):
        if not isinstance(desc, dict) or desc.get("kind") not in {"image", "document", "video"} or not re.fullmatch(r"[\w-]{8,80}", str(desc.get("groupId", ""))):
            raise ValueError("One or more attachments have invalid details.")
        name = sanitize_name(str(desc.get("fileName", upload.filename or "attachment")))
        data = await upload.read(MAX_REQUEST_BYTES + 1)
        total += len(data)
        if total > MAX_REQUEST_BYTES:
            raise ValueError("Attachments are too large. Keep the total upload below 24 MB.")
        kind, mime = desc["kind"], str(desc.get("mimeType", "")).lower()
        extracted = None
        stored = None
        if kind in {"image", "video"}:
            signatures = {"image/png": data.startswith(bytes([137,80,78,71,13,10,26,10])), "image/jpeg": data.startswith(b"\xff\xd8\xff"), "image/gif": data.startswith((b"GIF87a", b"GIF89a")), "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP"}
            limit = 2 * 1024 * 1024 if kind == "video" else 8 * 1024 * 1024
            if mime not in IMAGE_TYPES or len(data) > limit or not signatures.get(mime, False):
                raise ValueError(f"{name} is not a valid supported image/frame or exceeds its size limit.")
            stored = data
        else:
            if len(data) > 10 * 1024 * 1024:
                raise ValueError(f"{name} is over the 10 MB document limit.")
            extracted = extract_doc(name, data)
            if len(extracted) > remaining:
                extracted = extracted[:remaining] + "\n[Further document text omitted to fit the chat context.]" if remaining > 0 else "[Document text omitted because the message reached the total document text limit.]"
            remaining -= len(extracted)
            ext = name.rsplit(".", 1)[-1].lower()
            mime = "application/pdf" if ext == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document" if ext == "docx" else "text/plain"
        processed.append({"id": str(uuid.uuid4()), "groupId": desc["groupId"], "fileName": name, "mimeType": mime, "kind": kind, "byteSize": len(data), "frameIndex": desc.get("frameIndex"), "frameTime": desc.get("frameTime"), "data": stored, "extractedText": extracted})
    return processed


def image_data(mime: str, data: bytes) -> str:
    return base64.b64encode(data).decode()


async def provider_tokens(provider: str, model: str, messages: list[dict[str, Any]]) -> AsyncIterator[str]:
    config = PROVIDERS[provider]
    key = os.getenv(config["env"]) if config["env"] else "ollama"
    if not key:
        raise RuntimeError(f"{config['label']} is not configured yet. Add {config['env']} to your .env file.")
    openai = provider != "anthropic"
    if openai:
        formatted = []
        for msg in messages:
            if msg.get("images"):
                content = [{"type": "text", "text": msg["content"]}]
                content += [{"type": "image_url", "image_url": {"url": f"data:{img['mimeType']};base64,{img['data']}", "detail": "auto"}} for img in msg["images"]]
                formatted.append({"role": msg["role"], "content": content})
            else:
                formatted.append({"role": msg["role"], "content": msg["content"]})
        url = f"{os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434/v1').rstrip('/')}/chat/completions" if provider == "ollama" else "https://api.openai.com/v1/chat/completions"
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        body = {"model": model, "messages": formatted, "stream": True}
    else:
        formatted = []
        for msg in messages:
            if msg.get("images"):
                content = [{"type": "text", "text": msg["content"]}]
                content += [{"type": "image", "source": {"type": "base64", "media_type": img["mimeType"], "data": img["data"]}} for img in msg["images"]]
                formatted.append({"role": msg["role"], "content": content})
            else:
                formatted.append({"role": msg["role"], "content": msg["content"]})
        url = "https://api.anthropic.com/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        body = {"model": model, "max_tokens": 4096, "messages": formatted, "stream": True}
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20)) as client:
        async with client.stream("POST", url, headers=headers, json=body) as response:
            if response.status_code >= 400:
                detail = (await response.aread()).decode(errors="replace")
                raise RuntimeError(f"Model provider returned {response.status_code}: {detail[:500]}")
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if openai:
                    content = (event.get("choices") or [{}])[0].get("delta", {}).get("content")
                    if isinstance(content, str) and content:
                        yield content
                else:
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                        yield delta["text"]


def sse(name: str, value: Any) -> str:
    return f"event: {name}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(request: Request, payload: str = Form(...), files: list[UploadFile] = File(default=[])):
    require_session(request)
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    if int(request.headers.get("content-length", "0") or 0) > MAX_REQUEST_BYTES:
        raise HTTPException(413, "Attachments are too large. Keep the total upload below 24 MB.")
    try:
        body = json.loads(payload)
        if not isinstance(body, dict):
            raise ValueError("Invalid chat message data.")
        content = body.get("content", "")
        content = content.strip() if isinstance(content, str) else ""
        if len(content) > 12_000:
            raise ValueError("Message must be 12,000 characters or fewer.")
        if not content and not files:
            raise ValueError("Write a message or attach a file.")
        provider = body.get("provider")
        if provider not in PROVIDERS:
            raise ValueError("Choose a supported model provider.")
        config = PROVIDERS[provider]
        model = body.get("model") if body.get("model") == config["model"] else config["model"]
        if config["env"] and not os.getenv(config["env"]):
            raise HTTPException(503, f"{config['label']} is not configured yet. Add {config['env']} to your .env file.")
        processed = await process_files(body, files)
    except HTTPException:
        raise
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(400, str(error))
    names = list(dict.fromkeys(item["fileName"] for item in processed))
    stored_content = content or f"Please examine the attached file{'s' if len(names) != 1 else ''} and help me understand it: {', '.join(names)}"
    db = pool(request)
    conversation_id = body.get("conversationId")
    async with db.acquire() as conn:
        async with conn.transaction():
            if conversation_id:
                exists = await conn.fetchval('SELECT "id" FROM "Conversation" WHERE "id"=$1', str(conversation_id))
                if not exists:
                    raise HTTPException(404, "Chat not found.")
            else:
                conversation_id = str(uuid.uuid4())
                title = re.sub(r"\s+", " ", content or (names[0] if names else "New chat"))[:56]
                await conn.execute('INSERT INTO "Conversation" ("id", "title") VALUES ($1,$2)', conversation_id, title or "New chat")
            user_message_id = str(uuid.uuid4())
            await conn.execute('INSERT INTO "Message" ("id", "conversationId", "role", "content") VALUES ($1,$2,$3,$4)', user_message_id, conversation_id, "user", stored_content)
            for attachment in processed:
                await conn.execute('''INSERT INTO "Attachment" ("id", "messageId", "groupId", "fileName", "mimeType", "kind", "byteSize", "frameIndex", "frameTime", "data", "extractedText") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)''', attachment["id"], user_message_id, attachment["groupId"], attachment["fileName"], attachment["mimeType"], attachment["kind"], attachment["byteSize"], attachment["frameIndex"], attachment["frameTime"], attachment["data"], attachment["extractedText"])
            await conn.execute('UPDATE "Conversation" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', conversation_id)
    stored = await db.fetch('''SELECT m."id",m."role",m."content",a."fileName",a."mimeType",a."kind",a."data",a."extractedText",a."frameIndex"
      FROM (SELECT * FROM "Message" WHERE "conversationId"=$1 ORDER BY "createdAt" DESC LIMIT 24) m
      LEFT JOIN "Attachment" a ON a."messageId"=m."id" ORDER BY m."createdAt" ASC''', conversation_id)
    history, current, docs_remaining = [], None, MAX_TOTAL_DOCUMENT_CHARS
    for row in stored:
        if current is None or current["id"] != row["id"]:
            if current:
                current["content"] += "".join(current.pop("documents"))
                if current["images"] == []:
                    current.pop("images")
                history.append(current)
            if row["role"] not in {"user", "assistant"}:
                current = None
                continue
            current = {"id": row["id"], "role": row["role"], "content": row["content"], "images": [], "documents": []}
        if current is not None:
            if row["extractedText"]:
                text = row["extractedText"][:docs_remaining]
                docs_remaining -= len(text)
                current["documents"].append(f"\n\n[Attached document: {row['fileName']}]\n{text}")
            if row["data"] and row["kind"] in {"image", "video"}:
                current["images"].append({"mimeType": row["mimeType"], "data": image_data(row["mimeType"], row["data"]), "frameIndex": row["frameIndex"] or 0})
    if current:
        current["content"] += "".join(current.pop("documents"))
        if current["images"]:
            current["images"].sort(key=lambda image: image["frameIndex"])
            for image in current["images"]:
                image.pop("frameIndex", None)
        else:
            current.pop("images")
        history.append(current)
    for message in history[:-1]:
        if message.get("images"):
            message["images"].sort(key=lambda image: image.pop("frameIndex", 0))

    async def generate():
        answer = ""
        attachments_response = [{key: value for key, value in item.items() if key in {"id", "groupId", "fileName", "mimeType", "kind", "byteSize", "frameIndex", "frameTime"}} for item in processed]
        yield sse("meta", {"conversationId": conversation_id, "messageId": user_message_id, "attachments": attachments_response})
        try:
            async for token in provider_tokens(provider, model, history):
                if await request.is_disconnected():
                    return
                answer += token
                yield sse("token", {"text": token})
            if not answer.strip():
                raise RuntimeError("The model returned an empty response.")
            await db.execute('INSERT INTO "Message" ("id","conversationId","role","content","provider","model") VALUES ($1,$2,$3,$4,$5,$6)', str(uuid.uuid4()), conversation_id, "assistant", answer, provider, model)
            await db.execute('UPDATE "Conversation" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', conversation_id)
            yield sse("done", {"conversationId": conversation_id})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message = "The response was interrupted. The partial answer was not saved." if request.is_disconnected() else str(error)
            yield sse("error", {"message": message})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.get("/api/attachments/{attachment_id}")
async def get_attachment(attachment_id: str, request: Request):
    require_session(request)
    row = await pool(request).fetchrow('SELECT "data", "mimeType" FROM "Attachment" WHERE "id"=$1', attachment_id)
    if not row or row["data"] is None:
        raise HTTPException(404, "Image not found.")
    return Response(row["data"], media_type=row["mimeType"], headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@app.get("/health")
async def health():
    return {"ok": True}
