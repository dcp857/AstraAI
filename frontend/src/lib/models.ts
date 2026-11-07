export type ProviderId = "openai" | "anthropic" | "ollama";

export const PROVIDERS: Array<{
  id: ProviderId;
  label: string;
  model: string;
  envKey?: string;
}> = [
  {
    id: "openai",
    label: "OpenAI",
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Claude",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "ollama",
    label: "Ollama · Local",
    model: process.env.OLLAMA_MODEL || "qwen3.5:4b",
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return value === "openai" || value === "anthropic" || value === "ollama";
}
