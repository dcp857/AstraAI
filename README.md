# Astra — a private AI chat workspace

Astra's **frontend** is Next.js, React, and TypeScript. Its **backend** is a Python FastAPI service. The Python API handles authentication, PostgreSQL persistence, attachment processing, model-provider requests, and streamed responses. PostgreSQL keeps conversations, messages, and attachment data. The API supports OpenAI, Anthropic, and local Ollama.

## Requirements

- Node.js 20.9 or newer
- Python 3.11 or newer
- PostgreSQL (Neon works)
- A provider API key, or Ollama installed locally

## Run locally

1. Copy `.env.example` to `.env` in the project root. Fill in `DATABASE_URL`, `APP_PASSWORD`, and a random `SESSION_SECRET` with at least 32 characters. Add a provider key or configure Ollama. Keep `.env` private.
2. Install frontend packages with `npm install`.
3. Create a Python environment and install the API packages:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r backend\requirements.txt
   ```

4. Start the API in one terminal: `npm run backend:dev` (or `py -m uvicorn backend.main:app --reload --port 8000`). On startup it creates any missing Astra tables in `DATABASE_URL`; existing tables and chat records are retained.
5. Start the web app in another terminal with `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

The frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). `FRONTEND_ORIGINS` controls which frontend origins the API accepts. For a deployment, set the public API URL to the deployed Python service and include the frontend URL in `FRONTEND_ORIGINS`. Set `COOKIE_SECURE=true` when serving over HTTPS. Since browser cookies are used, host the frontend and API on the same site where possible.

## Models

Set `OPENAI_MODEL`, `ANTHROPIC_MODEL`, or `OLLAMA_MODEL` to a model ID supported by the chosen provider. Ollama defaults to `http://localhost:11434/v1` and `qwen3.5:4b`; run `ollama run qwen3.5:4b` first. Provider credentials stay in the Python server environment.

## Attachments

- Images: JPEG, PNG, GIF, and WebP; up to 8 MB each.
- Documents: PDF, DOCX, TXT, Markdown, CSV, and JSON; text is extracted for the model. Scanned PDFs need OCR and are not supported yet.
- Video: MP4, WebM, and MOV; the browser samples up to five frames and sends them as images. Audio is not transcribed, and the source video is not uploaded.
- Up to five file groups per message. Image frames and document text are stored in PostgreSQL.

## API routes

- `GET /api/status`
- `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/conversations`
- `GET`, `PATCH`, `DELETE /api/conversations/{id}`
- `POST /api/chat` — multipart message and files, streamed server-sent events
- `GET /api/attachments/{id}` — authenticated image preview
- `GET /health`

This prototype uses one shared password and one private workspace. It is not configured for multiple accounts or public signup.
