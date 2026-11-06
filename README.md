# Astra — a private AI chat workspace

A small Next.js chat app with a private single-user password gate, streamed answers from OpenAI, Anthropic, or local Ollama, and PostgreSQL-backed conversation history. Hosted provider keys remain on the server. The provider interface is intentionally small so another model service can be added later.

## Requirements

- Node.js 20.9 or newer (Node.js 22 LTS recommended)
- A PostgreSQL database, such as Prisma Postgres
- Either a provider API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) or a local Ollama installation and downloaded model

## Run locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL` (pooled app connection), `DIRECT_URL` (direct database connection for Prisma schema commands), `APP_PASSWORD`, and a random `SESSION_SECRET` of at least 32 characters. Add at least one provider API key. For a database without separate pooled/direct URLs, use the same connection string for both.
2. Install packages with `npm install`.
3. Generate the Prisma client and create the tables with `npm run db:generate` and `npm run db:push`.
4. Start the app with `npm run dev`, then visit [http://localhost:3000](http://localhost:3000).

The available provider/model IDs are configurable through `OPENAI_MODEL` and `ANTHROPIC_MODEL` in `.env`. The defaults are `gpt-5.6-sol` and `claude-sonnet-5`; use model IDs available to your API account.

### Use a local open-weight model with Ollama

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. In PowerShell, download and start a compact model: `ollama run qwen3.5:4b`.
3. Leave `OLLAMA_BASE_URL` and `OLLAMA_MODEL` at their defaults in `.env`. Ollama exposes an OpenAI-compatible local API, so Astra streams the response without sending the prompt to a hosted model provider.

The Qwen 3.5 4B model download is about 3.3–4.0 GB. Larger variants may answer better but require more disk space and memory; actual speed depends on your computer. [Ollama model details](https://ollama.com/library/qwen3.5:4b), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

## Attachments

- Images: JPEG, PNG, GIF, and WebP; up to 8 MB each.
- Documents: PDF, DOCX, TXT, Markdown, CSV, and JSON; text is extracted for the model. Scanned PDFs need OCR and are not supported yet.
- Video: MP4, WebM, and MOV; up to five representative frames are sampled in the browser and sent as images. Audio is not transcribed. The original video file is not uploaded.
- Up to five files per message. Images and sampled video frames are stored in PostgreSQL so they remain available in chat history; documents store extracted text and the filename.

Attachments are sent to the selected model provider. With Ollama, model inference stays on the local computer, while conversation history and attached image data are still saved in the configured PostgreSQL database.

## Deploy

Deploy the Next.js app to Vercel and provision a managed PostgreSQL database. Set the environment variables in both local development and the deployment environment, then run `npm run db:push` against the production database once. Never commit `.env` or provider API keys.

## Routes

- `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/conversations`
- `GET`, `PATCH`, `DELETE /api/conversations/:id`
- `POST /api/chat` — accepts multipart chat messages and streams server-sent events (`meta`, `token`, `done`, `error`)
- `GET /api/attachments/:id` — serves an authenticated image preview

This prototype uses one shared password and one private workspace. It is not configured for multiple accounts or public signup.
