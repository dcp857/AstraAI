export type ProviderId = "openai" | "anthropic" | "ollama";

export type ModelOption = {
  id: string;
  provider: ProviderId;
  label: string;
  model: string;
  kind: "hosted" | "local";
};
