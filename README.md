# Astra — a private AI chat workspace

Astra is organized by responsibility:

```text
astra/
├── backend/       Python FastAPI API and Python dependencies
├── database/      PostgreSQL schema and database assets
├── frontend/      Next.js, React, and TypeScript web app
├── .env.example   Backend secrets and runtime configuration template
├── .gitignore
└── README.md
```

The Python API handles authentication, PostgreSQL persistence, attachment processing, model-provider requests, and streamed responses. The frontend provides the chat interface, conversation history, Markdown rendering, and attachment controls. PostgreSQL stores conversations, messages, and attachment data.

## Requirements

- Node.js 20.9 or newer
- Python 3.11 or newer
- PostgreSQL (Neon works)
- A provider API key, or Ollama installed locally

## Run locally

1. Copy root `.env.example` to `.env`. Set `DATABASE_URL`, `APP_PASSWORD`, and a random `SESSION_SECRET` with at least 32 characters. Add a provider key or configure Ollama. Keep `.env` private.
2. In a terminal at the project root, create the Python environment and install the API packages:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r backend\requirements.txt
   py -m uvicorn backend.main:app --reload --port 8000
   ```

   The API applies `database/schema.sql` when it starts. Existing tables and chat records are retained.
3. In another terminal, install and start the frontend:

   ```powershell
   cd frontend
   Copy-Item .env.example .env.local
   npm install
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

The frontend API URL defaults to `http://localhost:8000`. Configure `NEXT_PUBLIC_API_URL` in `frontend/.env.local` if the API is hosted elsewhere. Set the API's `FRONTEND_ORIGINS` to the frontend origin, and set `COOKIE_SECURE=true` when serving over HTTPS. Since authentication uses cookies, host frontend and API on the same site where possible.

## Models

Set `OPENAI_MODEL`, `ANTHROPIC_MODEL`, or `OLLAMA_MODEL` in the root `.env` to a model ID supported by the selected provider. Ollama defaults to `http://localhost:11434/v1` and `qwen3.5:4b`; run `ollama run qwen3.5:4b` first. Provider credentials stay in the Python server environment.

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
