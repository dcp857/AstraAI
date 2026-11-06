import type { ProviderId } from "./models";

export type ChatImage = { mimeType: string; data: string };
export type ChatTurn = { role: "user" | "assistant"; content: string; images?: ChatImage[] };

function openAIMessages(messages: ChatTurn[]) {
  return messages.map((message) => message.images?.length
    ? {
        role: message.role,
        content: [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" } })),
        ],
      }
    : { role: message.role, content: message.content });
}

function anthropicMessages(messages: ChatTurn[]) {
  return messages.map((message) => message.images?.length
    ? {
        role: message.role,
        content: [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
        ],
      }
    : { role: message.role, content: message.content });
}

async function* parseSse(body: ReadableStream<Uint8Array>, provider: ProviderId): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
        if (provider !== "anthropic") {
          const choices = event.choices as Array<{ delta?: { content?: unknown } }> | undefined;
          const content = choices?.[0]?.delta?.content;
          if (typeof content === "string") yield content;
        } else {
          const delta = event.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") yield delta.text;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamModel(
  provider: ProviderId,
  model: string,
  messages: ChatTurn[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined;
  if (provider !== "ollama" && !apiKey) throw new Error(`${provider === "openai" ? "OpenAI" : "Anthropic"} API key is not configured.`);

  const openAI = provider !== "anthropic";
  const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/$/, "");
  const response = await fetch(
    provider === "ollama" ? `${ollamaBaseUrl}/chat/completions` : openAI ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      signal,
      headers: openAI
        ? { authorization: `Bearer ${provider === "ollama" ? "ollama" : apiKey}`, "content-type": "application/json" }
        : { "x-api-key": apiKey as string, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(openAI
        ? { model, messages: openAIMessages(messages), stream: true }
        : { model, max_tokens: 4096, messages: anthropicMessages(messages), stream: true }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model provider returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("The model provider returned an empty stream.");
  yield* parseSse(response.body, provider);
}
