from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
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
    schema_path = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
    await pool.execute(schema_path.read_text(encoding="utf-8"))


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
logger = logging.getLogger("astra.api")
local_dev_origin_regex = r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?$" if os.getenv("COOKIE_SECURE", "false").lower() != "true" else None
app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in os.getenv("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if item.strip()],
    allow_origin_regex=local_dev_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(HTTPException)
async def http_error_response(request: Request, error: HTTPException):
    detail = error.detail if isinstance(error.detail, str) else "Request failed."
    return JSONResponse({"error": detail}, status_code=error.status_code, headers=error.headers)


@app.exception_handler(Exception)
async def unexpected_error_response(request: Request, error: Exception):
    logger.exception("Unhandled API error for %s %s", request.method, request.url.path)
    client_host = request.client.host if request.client else ""
    if client_host in {"127.0.0.1", "::1"}:
        detail = f"{type(error).__name__}: {error}"[:500]
    else:
        detail = "Internal server error. Check the Python backend terminal for details."
    return JSONResponse({"error": detail}, status_code=500)


def pool(request: Request) -> asyncpg.Pool:
    value = request.app.state.pool
    if value is None:
        raise HTTPException(503, "DATABASE_URL is not configured.")
    return value


def same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return False
    normalized = origin.rstrip("/").lower()
    allowed = {item.strip().rstrip("/").lower() for item in os.getenv("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")}
    if normalized in allowed:
        return True
    return bool(local_dev_origin_regex and re.fullmatch(local_dev_origin_regex, normalized))


def auth_configured() -> bool:
    return len(os.getenv("SESSION_SECRET", "")) >= 32


def session_signature(expiry: str, user_id: str) -> str:
    secret = os.getenv("SESSION_SECRET", "")
    if len(secret) < 32:
        raise ValueError("SESSION_SECRET must contain at least 32 characters.")
    digest = hmac.new(secret.encode(), f"{expiry}.{user_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def current_user_id(request: Request) -> str | None:
    raw = request.cookies.get(COOKIE_NAME, "")
    try:
        expiry, user_id, signature = raw.split(".", 2)
        valid = expiry.isdigit() and int(expiry) >= int(datetime.now(timezone.utc).timestamp()) and hmac.compare_digest(signature, session_signature(expiry, user_id))
        return user_id if valid else None
    except (ValueError, TypeError):
        return None


def has_session(request: Request) -> bool:
    return current_user_id(request) is not None


def require_session(request: Request) -> None:
    if current_user_id(request) is None:
        raise HTTPException(401, "Unauthorized.")


def owner_id(request: Request) -> str:
    value = current_user_id(request)
    if value is None:
        raise HTTPException(401, "Sign in to continue.")
    return value


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return f"scrypt${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(hashed).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt_value, hash_value = stored.split("$", 2)
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_value.encode())
        expected = base64.urlsafe_b64decode(hash_value.encode())
        actual = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


async def discover_models() -> tuple[list[dict[str, str]], str | None]:
    models: list[dict[str, str]] = []
    for provider in ("openai", "anthropic"):
        config = PROVIDERS[provider]
        if os.getenv(config["env"]):
            models.append({
                "id": f"{provider}:{config['model']}",
                "provider": provider,
                "label": config["label"],
                "model": config["model"],
                "kind": "hosted",
            })

    ollama_base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
    ollama_root = ollama_base[:-3] if ollama_base.endswith("/v1") else ollama_base
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3, connect=2)) as client:
            response = await client.get(f"{ollama_root}/api/tags")
            response.raise_for_status()
            entries = response.json().get("models", [])
        for entry in entries:
            name = entry.get("name") or entry.get("model")
            if isinstance(name, str) and name:
                models.append({
                    "id": f"ollama:{name}",
                    "provider": "ollama",
                    "label": name,
                    "model": name,
                    "kind": "local",
                })
        return models, None
    except (httpx.HTTPError, ValueError, TypeError):
        return models, "Ollama isn't responding. Start Ollama, then refresh the model list."


def json_error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.get("/api/status")
async def status(request: Request):
    return {"configured": auth_configured() and bool(os.getenv("DATABASE_URL")), "authenticated": has_session(request)}


@app.get("/api/models")
async def list_models(request: Request):
    require_session(request)
    models, local_error = await discover_models()
    return {"models": models, "localError": local_error}


class AuthBody(BaseModel):
    email: str
    password: str
    name: str = ""


def set_session(response: JSONResponse, user_id: str) -> JSONResponse:
    expiry = str(int(datetime.now(timezone.utc).timestamp()) + SESSION_AGE)
    token = f"{expiry}.{user_id}.{session_signature(expiry, user_id)}"
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=os.getenv("COOKIE_SECURE", "false").lower() == "true", samesite="strict", path="/", max_age=SESSION_AGE)
    return response


@app.post("/api/auth/register")
async def register(body: AuthBody, request: Request):
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    if not auth_configured():
        raise HTTPException(503, "SESSION_SECRET must be set to at least 32 characters.")
    email = body.email.strip().lower()
    name = re.sub(r"\s+", " ", body.name.strip())[:80]
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        raise HTTPException(400, "Enter a valid email address.")
    if len(body.password) < 10 or len(body.password) > 256:
        raise HTTPException(400, "Use a password between 10 and 256 characters.")
    if not name:
        raise HTTPException(400, "Enter your name.")
    user_id = str(uuid.uuid4())
    db = pool(request)
    try:
        async with db.acquire() as conn:
            async with conn.transaction():
                await conn.execute('INSERT INTO "User" ("id", "name", "email", "passwordHash") VALUES ($1,$2,$3,$4)', user_id, name, email, password_hash(body.password))
                # Preserve the existing single-user workspace for the first account.
                await conn.execute('UPDATE "Conversation" SET "ownerId"=$1 WHERE "ownerId" IS NULL', user_id)
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "An account with this email already exists.")
    response = JSONResponse({"ok": True, "user": {"id": user_id, "name": name, "email": email}})
    return set_session(response, user_id)


@app.post("/api/auth/login")
async def login(body: AuthBody, request: Request):
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    if not auth_configured():
        raise HTTPException(503, "Authentication is not configured.")
    user = await pool(request).fetchrow('SELECT "id", "name", "email", "passwordHash" FROM "User" WHERE "email"=$1', body.email.strip().lower())
    if not user or not verify_password(body.password, user["passwordHash"]):
        raise HTTPException(401, "Email or password is incorrect.")
    response = JSONResponse({"ok": True, "user": {"id": user["id"], "name": user["name"], "email": user["email"]}})
    return set_session(response, user["id"])


@app.post("/api/auth/logout")
async def logout(request: Request):
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@app.get("/api/conversations")
async def list_conversations(request: Request):
    user_id = owner_id(request)
    rows = await pool(request).fetch('SELECT "id", "title", "updatedAt" FROM "Conversation" WHERE "ownerId"=$1 ORDER BY "updatedAt" DESC', user_id)
    return {"conversations": [{"id": row["id"], "title": row["title"], "updatedAt": row["updatedAt"].isoformat()} for row in rows]}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    user_id = owner_id(request)
    db = pool(request)
    conversation = await db.fetchrow('SELECT "id", "title", "updatedAt" FROM "Conversation" WHERE "id"=$1 AND "ownerId"=$2', conversation_id, user_id)
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
    user_id = owner_id(request)
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    title = body.title.strip()
    if not title or len(title) > 100:
        raise HTTPException(400, "Title must be between 1 and 100 characters.")
    row = await pool(request).fetchrow('UPDATE "Conversation" SET "title"=$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "ownerId"=$3 RETURNING "id", "title", "updatedAt"', conversation_id, title, user_id)
    if not row:
        raise HTTPException(404, "Chat not found.")
    return {"conversation": {"id": row["id"], "title": row["title"], "updatedAt": row["updatedAt"].isoformat()}}


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request):
    user_id = owner_id(request)
    if not same_origin(request):
        raise HTTPException(403, "Invalid request origin.")
    result = await pool(request).execute('DELETE FROM "Conversation" WHERE "id"=$1 AND "ownerId"=$2', conversation_id, user_id)
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
    if provider == "ollama" and model.lower().startswith("gemma4"):
        # Gemma 4 thinks by default; on this machine that can leave the
        # OpenAI-compatible stream idle long enough for the dev proxy to drop it.
        body["reasoning_effort"] = "none"
        body["max_tokens"] = 2048
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
    user_id = owner_id(request)
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
        if provider == "ollama":
            model = body.get("model")
            available_models, _ = await discover_models()
            if not isinstance(model, str) or not any(item["provider"] == "ollama" and item["model"] == model for item in available_models):
                raise HTTPException(400, "That local model isn't available in Ollama. Refresh the model list and choose an installed model.")
        else:
            model = config["model"]
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
                exists = await conn.fetchval('SELECT "id" FROM "Conversation" WHERE "id"=$1 AND "ownerId"=$2', str(conversation_id), user_id)
                if not exists:
                    raise HTTPException(404, "Chat not found.")
            else:
                conversation_id = str(uuid.uuid4())
                title = re.sub(r"\s+", " ", content or (names[0] if names else "New chat"))[:56]
                await conn.execute('INSERT INTO "Conversation" ("id", "title", "updatedAt", "ownerId") VALUES ($1,$2,CURRENT_TIMESTAMP,$3)', conversation_id, title or "New chat", user_id)
            user_message_id = str(uuid.uuid4())
            await conn.execute('INSERT INTO "Message" ("id", "conversationId", "role", "content") VALUES ($1,$2,$3,$4)', user_message_id, conversation_id, "user", stored_content)
            for attachment in processed:
                await conn.execute('''INSERT INTO "Attachment" ("id", "messageId", "groupId", "fileName", "mimeType", "kind", "byteSize", "frameIndex", "frameTime", "data", "extractedText") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)''', attachment["id"], user_message_id, attachment["groupId"], attachment["fileName"], attachment["mimeType"], attachment["kind"], attachment["byteSize"], attachment["frameIndex"], attachment["frameTime"], attachment["data"], attachment["extractedText"])
            await conn.execute('UPDATE "Conversation" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "ownerId"=$2', conversation_id, user_id)
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
            await db.execute('UPDATE "Conversation" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "ownerId"=$2', conversation_id, user_id)
            yield sse("done", {"conversationId": conversation_id})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message = "The response was interrupted. The partial answer was not saved." if request.is_disconnected() else str(error)
            yield sse("error", {"message": message})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.get("/api/attachments/{attachment_id}")
async def get_attachment(attachment_id: str, request: Request):
    user_id = owner_id(request)
    row = await pool(request).fetchrow('''SELECT a."data", a."mimeType" FROM "Attachment" a
      JOIN "Message" m ON m."id"=a."messageId"
      JOIN "Conversation" c ON c."id"=m."conversationId"
      WHERE a."id"=$1 AND c."ownerId"=$2''', attachment_id, user_id)
    if not row or row["data"] is None:
        raise HTTPException(404, "Image not found.")
    return Response(row["data"], media_type=row["mimeType"], headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@app.get("/health")
async def health():
    return {"ok": True}
