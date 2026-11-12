"use client";

import { Children, FormEvent, isValidElement, KeyboardEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ModelOption } from "@/lib/models";
import { apiUrl, readApiJson } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";

type ConversationSummary = { id: string; title: string; updatedAt: string };
type AttachmentInfo = { id: string; groupId: string; fileName: string; mimeType: string; kind: "image" | "document" | "video"; byteSize: number; frameIndex?: number | null; frameTime?: number | null };
type UploadPart = { file: File; frameIndex?: number; frameTime?: number };
type PendingAttachment = { groupId: string; fileName: string; kind: "image" | "document" | "video"; parts: UploadPart[]; previewUrl?: string };
type Message = { id?: string; role: "user" | "assistant"; content: string; model?: string; attachments?: AttachmentInfo[]; pendingAttachments?: PendingAttachment[] };

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "csv", "json"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_ATTACHMENTS = 5;

function createGroupId() {
  return crypto.randomUUID();
}

function sampleVideo(file: File, groupId: string): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;
    video.onloadedmetadata = async () => {
      try {
        if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 600) {
          throw new Error("Videos must be 10 minutes or shorter.");
        }
        const count = Math.min(5, Math.max(1, Math.ceil(video.duration / 15)));
        const parts: UploadPart[] = [];
        for (let index = 0; index < count; index++) {
          const frameTime = Math.min(video.duration - 0.05, video.duration * ((index + 0.5) / count));
          await new Promise<void>((ready, failed) => {
            video.onseeked = () => ready();
            video.onerror = () => failed(new Error("This video could not be decoded in your browser."));
            video.currentTime = Math.max(0, frameTime);
          });
          const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Your browser could not process this video frame.");
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob>((ready, failed) => canvas.toBlob((value) => value ? ready(value) : failed(new Error("Could not capture a video frame.")), "image/jpeg", 0.76));
          parts.push({ file: new File([blob], `${file.name}-frame-${index + 1}.jpg`, { type: "image/jpeg" }), frameIndex: index + 1, frameTime });
        }
        resolve({ groupId, fileName: file.name, kind: "video", parts, previewUrl: URL.createObjectURL(parts[0].file) });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
        video.removeAttribute("src");
        video.load();
      }
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This video format could not be opened by your browser."));
    };
  });
}

function PendingAttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove: (groupId: string) => void }) {
  if (!items.length) return null;
  return <div className="attachment-tray">{items.map((item) => <div className="pending-attachment" key={item.groupId}>
    {item.previewUrl ? <img src={item.previewUrl} alt=""/> : <span className="attachment-file-icon">{item.kind === "document" ? "DOC" : "VID"}</span>}
    <span className="pending-attachment-name"><strong>{item.fileName}</strong><small>{item.kind === "video" ? `Video · ${item.parts.length} sampled frames` : item.kind === "image" ? "Image" : "Document"}</small></span>
    <button type="button" onClick={() => onRemove(item.groupId)} aria-label={`Remove ${item.fileName}`}>×</button>
  </div>)}</div>;
}

function MessageAttachments({ items }: { items: AttachmentInfo[] }) {
  const groups = new Map<string, AttachmentInfo[]>();
  for (const item of items) groups.set(item.groupId, [...(groups.get(item.groupId) || []), item]);
  return <div className="message-attachments">{[...groups.values()].map((group, index) => {
    const first = group[0];
    const key = first.groupId || first.id || `${first.kind}-${first.fileName}-${index}`;
    if (first.kind === "document") return <div className="document-attachment" key={key}><span className="attachment-file-icon">{first.fileName.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}</span><span><strong>{first.fileName}</strong><small>{(first.byteSize / 1024).toFixed(0)} KB · text extracted</small></span></div>;
    if (first.kind === "video") return <div className="video-attachment" key={key}><div className="video-frames">{group.slice().sort((a, b) => (a.frameIndex || 0) - (b.frameIndex || 0)).map((frame) => <img key={frame.id} src={apiUrl(`/api/attachments/${frame.id}`)} alt={`${first.fileName}, frame ${frame.frameIndex}`} loading="lazy"/>)}</div><div className="video-attachment-label"><span className="video-play-icon">▶</span><span><strong>{first.fileName}</strong><small>Video · {group.length} sampled frames · audio not transcribed</small></span></div></div>;
    return <img className="image-attachment" key={key} src={apiUrl(`/api/attachments/${first.id}`)} alt={first.fileName} loading="lazy"/>;
  })}</div>;
}

function CopyableCodeBlock({ children }: { children: ReactNode }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const codeElement = Children.toArray(children).find(isValidElement);
  const codeProps = codeElement?.props as { className?: string; children?: ReactNode } | undefined;
  const language = codeProps?.className?.match(/language-([\w+-]+)/)?.[1] || "code";
  const source = Children.toArray(codeProps?.children).map((part) => typeof part === "string" ? part : "").join("");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return <div className="code-block">
    <div className="code-toolbar"><span>{language}</span><button type="button" onClick={() => void copyCode()} aria-label="Copy code">
      <span aria-hidden="true">{copyState === "copied" ? "✓" : "▢"}</span>{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code"}
    </button></div>
    <pre>{children}</pre>
  </div>;
}

function relativeDate(date: string) {
  const age = Date.now() - new Date(date).getTime();
  if (age < 86_400_000) return "Today";
  if (age < 172_800_000) return "Yesterday";
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ProviderMark({ provider }: { provider: ModelOption["provider"] }) {
  const mark = provider === "openai" ? "∞" : provider === "anthropic" ? "✳" : "◉";
  return <span className={`provider-mark ${provider}`} aria-hidden="true">{mark}</span>;
}

function ModelPicker({
  value,
  models,
  message,
  loading,
  onChange,
  onRefresh,
}: {
  value: ModelOption | null;
  models: ModelOption[];
  message: string;
  loading: boolean;
  onChange: (model: ModelOption) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const hostedModels = models.filter((item) => item.kind === "hosted");
  const localModels = models.filter((item) => item.kind === "local");

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return <div className="model-picker" ref={pickerRef}>
    <button
      type="button"
      className={`model-picker-trigger ${open ? "is-open" : ""}`}
      onClick={() => setOpen((current) => !current)}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={value ? `Choose model. Current model: ${value.label}, ${value.model}` : "Choose a model"}
    >
      {value ? <ProviderMark provider={value.provider}/> : <span className="provider-mark ollama" aria-hidden="true">✳</span>}
      <span className="model-trigger-copy"><strong>{value?.label || (loading ? "Finding models…" : "Choose a model")}</strong><small>{value?.model || "Available on this PC"}</small></span>
      <span className="model-trigger-caret" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="model-popover">
      <div className="model-popover-heading"><strong>Choose a model</strong><button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh available models" title="Refresh available models">{loading ? "…" : "↻"}</button></div>
      <div className="model-options" role="listbox" aria-label="Available models">
        {hostedModels.map((item) => <button
          type="button"
          role="option"
          aria-selected={item.id === value?.id}
          className={`model-option ${item.id === value?.id ? "selected" : ""}`}
          key={item.id}
          onClick={() => { onChange(item); setOpen(false); }}
        >
          <ProviderMark provider={item.provider}/>
          <span className="model-option-copy"><strong>{item.label}</strong><small>{item.model}</small></span>
          <span className="model-host-type hosted">Hosted</span>
          {item.id === value?.id && <span className="model-selected-check" aria-label="Selected">✓</span>}
        </button>)}
        {localModels.length > 0 && <div className="model-group-label">On this PC <span>{localModels.length} installed</span></div>}
        {!localModels.length && models.length > 0 && message && <div className="model-local-notice">{message}</div>}
        {localModels.map((item) => <button
          type="button"
          role="option"
          aria-selected={item.id === value?.id}
          className={`model-option ${item.id === value?.id ? "selected" : ""}`}
          key={item.id}
          onClick={() => { onChange(item); setOpen(false); }}
        >
          <ProviderMark provider={item.provider}/>
          <span className="model-option-copy"><strong>{item.label}</strong><small>Ollama · Open-weight</small></span>
          <span className="model-host-type local">Local</span>
          {item.id === value?.id && <span className="model-selected-check" aria-label="Selected">✓</span>}
        </button>)}
        {!models.length && <div className="model-empty-state">{message || (loading ? "Checking available models…" : "No models found.")}</div>}
      </div>
      {models.length > 0 && <p className="model-popover-foot">Local models run on this PC. Your chat history stays in Astra.</p>}
    </div>}
  </div>;
}

export function Chat() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [modelMessage, setModelMessage] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingChats, setLoadingChats] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [processingFiles, setProcessingFiles] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshConversations() {
    const response = await fetch(apiUrl("/api/conversations"), { credentials: "include" });
    const result = await readApiJson(response);
    if (!response.ok) throw new Error(result.error || "Could not load chats.");
    setConversations(result.conversations);
  }

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    setModelMessage("");
    try {
      const response = await fetch(apiUrl("/api/models"), { credentials: "include" });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || "Could not load available models.");
      const available = Array.isArray(result.models) ? result.models as ModelOption[] : [];
      setModels(available);
      setModelMessage(result.localError || (available.length ? "" : "No configured providers or installed Ollama models were found."));
      const savedId = localStorage.getItem("astra-selected-model");
      setSelectedModel(available.find((model) => model.id === savedId)
        || available.find((model) => model.provider === "ollama" && model.model === "qwen3.5:4b")
        || available[0]
        || null);
    } catch (reason) {
      setModelMessage(reason instanceof Error ? reason.message : "Could not load available models.");
      setModels([]);
      setSelectedModel(null);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  function chooseModel(model: ModelOption) {
    setSelectedModel(model);
    localStorage.setItem("astra-selected-model", model.id);
  }

  useEffect(() => {
    refreshConversations().catch((reason) => setError(reason.message)).finally(() => setLoadingChats(false));
  }, []);
  useEffect(() => { void refreshModels(); }, [refreshModels]);
  useEffect(() => {
    if (isAtBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  function handleChatScroll() {
    const element = chatScrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    isAtBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }

  function jumpToLatest() {
    isAtBottomRef.current = true;
    setShowJumpToLatest(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  async function openConversation(id: string) {
    setError("");
    isAtBottomRef.current = true;
    setShowJumpToLatest(false);
    setActiveId(id);
    setSidebarOpen(false);
    try {
      const response = await fetch(apiUrl(`/api/conversations/${id}`), { credentials: "include" });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || "Could not open this chat.");
      setMessages(result.conversation.messages.map((message: Message) => ({ ...message })));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this chat."); }
  }

  function newConversation() {
    isAtBottomRef.current = true;
    setShowJumpToLatest(false);
    setActiveId(null);
    setMessages([]);
    setDraft("");
    attachments.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
    setAttachments([]);
    setError("");
    setSidebarOpen(false);
    textareaRef.current?.focus();
  }

  async function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    if (selected.length + attachments.length > MAX_ATTACHMENTS) {
      setError("Attach up to five files per message.");
      return;
    }
    setProcessingFiles(true);
    setError("");
    const accepted: PendingAttachment[] = [];
    for (const file of selected) {
      try {
        const extension = file.name.split(".").pop()?.toLowerCase() || "";
        const groupId = createGroupId();
        if (IMAGE_MIME_TYPES.has(file.type)) {
          if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} is over the 8 MB image limit.`);
          accepted.push({ groupId, fileName: file.name, kind: "image", parts: [{ file }], previewUrl: URL.createObjectURL(file) });
        } else if (DOCUMENT_EXTENSIONS.has(extension)) {
          if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is over the 10 MB document limit.`);
          accepted.push({ groupId, fileName: file.name, kind: "document", parts: [{ file }] });
        } else if (VIDEO_MIME_TYPES.has(file.type) || ["mp4", "webm", "mov"].includes(extension)) {
          if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} is over the 100 MB video limit.`);
          accepted.push(await sampleVideo(file, groupId));
        } else {
          throw new Error(`${file.name} is not supported. Attach an image, PDF, DOCX, TXT, MD, CSV, JSON, or MP4/WebM/MOV video.`);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not add this file.");
      }
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) break;
    }
    setAttachments((current) => [...current, ...accepted].slice(0, MAX_ATTACHMENTS));
    setProcessingFiles(false);
  }

  function removeAttachment(groupId: string) {
    setAttachments((current) => {
      const item = current.find((attachment) => attachment.groupId === groupId);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((attachment) => attachment.groupId !== groupId);
    });
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = draft.trim();
    if ((!content && attachments.length === 0) || busy || processingFiles) return;
    if (!selectedModel) { setError(modelMessage || "Choose an available model before sending a message."); return; }
    const submittedAttachments = attachments;
    const uploadParts = submittedAttachments.flatMap((group) => group.parts.map((part) => ({ ...part, group })));
    setDraft("");
    setError("");
    setBusy(true);
    isAtBottomRef.current = true;
    setShowJumpToLatest(false);
    setMessages((current) => [...current, { role: "user", content, pendingAttachments: submittedAttachments }, { role: "assistant", content: "" }]);
    let responseId = activeId;
    try {
      const form = new FormData();
      form.append("payload", JSON.stringify({
        conversationId: activeId,
        content,
        provider: selectedModel.provider,
        model: selectedModel.model,
        attachments: uploadParts.map(({ file, group, frameIndex, frameTime }) => ({
          groupId: group.groupId,
          fileName: group.fileName,
          kind: group.kind,
          mimeType: group.kind === "video" ? file.type : group.kind === "image" ? file.type : file.type || "application/octet-stream",
          frameIndex,
          frameTime,
        })),
      }));
      uploadParts.forEach(({ file }) => form.append("files", file, file.name));
      const response = await fetch(apiUrl("/api/chat"), { method: "POST", credentials: "include", body: form });
      if (!response.ok || !response.body) {
        const result = await readApiJson(response);
        throw new Error(result.error || "Could not send this message.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let serverError = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const eventName = block.match(/^event: (.+)$/m)?.[1];
          const dataLine = block.match(/^data: (.+)$/m)?.[1];
          if (!eventName || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (eventName === "meta") {
            responseId = data.conversationId;
            setActiveId(responseId);
            setMessages((current) => current.map((message, index) => index === current.length - 2
              ? { ...message, id: data.messageId, attachments: data.attachments, pendingAttachments: undefined }
              : message));
            submittedAttachments.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
            setAttachments((current) => current.filter((item) => !submittedAttachments.some((submitted) => submitted.groupId === item.groupId)));
          } else if (eventName === "token") {
            assistantText += data.text;
            setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, content: assistantText } : message));
          } else if (eventName === "error") serverError = data.message;
        }
        if (done) break;
      }
      if (serverError) {
        setMessages((current) => current.slice(0, -1));
        throw new Error(serverError);
      }
      if (responseId) setActiveId(responseId);
      await refreshConversations();
    } catch (reason) {
      setMessages((current) => current.at(-1)?.role === "assistant" ? current.slice(0, -1) : current);
      const fetchFailed = reason instanceof TypeError && /fetch/i.test(reason.message);
      setError(fetchFailed
        ? `Could not reach Astra's Python API at ${apiUrl("")} through the local proxy. Check that the backend is running on port 8000.`
        : reason instanceof Error ? reason.message : "The response could not be completed.");
      refreshConversations().catch(() => undefined);
    } finally { setBusy(false); textareaRef.current?.focus(); }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  }

  async function deleteConversation(id: string) {
    const response = await fetch(apiUrl(`/api/conversations/${id}`), { method: "DELETE", credentials: "include" });
    if (!response.ok) { const result = await readApiJson(response); setError(result.error || "Could not delete this chat."); return; }
    setConversations((current) => current.filter((conversation) => conversation.id !== id));
    if (activeId === id) newConversation();
  }

  async function saveRename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const title = renamingTitle.trim();
    if (!title) return;
    const response = await fetch(apiUrl(`/api/conversations/${id}`), {
      method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
    });
    const result = await readApiJson(response);
    if (!response.ok) { setError(result.error || "Could not rename this chat."); return; }
    setConversations((current) => current.map((item) => item.id === id ? result.conversation : item));
    setRenamingId(null);
  }

  async function logout() {
    await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
    window.location.reload();
  }

  async function copyResponse(message: Message, index: number) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessage(message.id || `message-${index}`);
      window.setTimeout(() => setCopiedMessage(null), 1800);
    } catch {
      setError("Could not copy the response. Check your browser clipboard permissions.");
    }
  }

  return <main className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-top">
        <a className="brand-lockup" href="/" aria-label="Astra home"><div className="brand-mark">✳</div><span>astra</span></a>
        <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">×</button>
      </div>
      <button className="new-chat-button" onClick={newConversation}><span className="plus-icon">＋</span> New conversation</button>
      <div className="history-label">Recent chats</div>
      <div className="conversation-list">
        {loadingChats ? <div className="sidebar-empty">Loading conversations…</div> : conversations.length === 0
          ? <div className="sidebar-empty">Your conversations<br />will live here.</div>
          : conversations.map((conversation) => <div className={`conversation-item ${activeId === conversation.id ? "selected" : ""}`} key={conversation.id}>
            {renamingId === conversation.id ? <form className="rename-form" onSubmit={(event) => void saveRename(event, conversation.id)}>
              <input value={renamingTitle} onChange={(event) => setRenamingTitle(event.target.value)} maxLength={100} aria-label="New conversation title" autoFocus onKeyDown={(event) => { if (event.key === "Escape") setRenamingId(null); }} />
              <button type="submit" aria-label="Save title">↵</button>
            </form> : <>
              <button className="conversation-link" onClick={() => void openConversation(conversation.id)}>
                <span className="conversation-title">{conversation.title}</span><span className="conversation-date">{relativeDate(conversation.updatedAt)}</span>
              </button>
              <button className="edit-chat" onClick={() => { setRenamingId(conversation.id); setRenamingTitle(conversation.title); }} aria-label={`Rename ${conversation.title}`} title="Rename">✎</button>
              <button className="delete-chat" onClick={() => void deleteConversation(conversation.id)} aria-label={`Delete ${conversation.title}`} title="Delete">×</button>
            </>}
          </div>)}
      </div>
      <div className="sidebar-bottom">
        <div className="profile-avatar" aria-hidden="true">A</div><div className="profile-copy"><strong>Your account</strong><span>Private conversations</span></div>
        <button className="logout-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><span aria-hidden="true">↗</span><span>Sign out</span></button>
      </div>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
    <section className="main-panel">
      <header className="topbar">
        <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">☰</button>
        <div className="workspace-crumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activeId ? conversations.find((item) => item.id === activeId)?.title || "Conversation" : "New conversation"}</strong></div>
        <div className="topbar-right"><span className="online-indicator"/>Private workspace<ThemeToggle/></div>
      </header>
      <div ref={chatScrollRef} onScroll={handleChatScroll} className={`chat-scroll ${messages.length === 0 ? "chat-empty" : ""}`}>
        {messages.length === 0 ? <div className="welcome-block">
          <div className="welcome-symbol">✳</div>
          <p className="eyebrow">A FRESH PERSPECTIVE</p>
          <h1>Good ideas start<br />with <em>a conversation.</em></h1>
          <p className="welcome-description">Ask a question, untangle a thought, or explore something new.<br className="desktop-break"/> I’m here to help you think it through.</p>
          <div className="suggestion-grid">
            {["Help me think through a big decision", "Explain a complex idea simply", "Give me a fresh perspective", "Help me get started on a project"].map((suggestion, index) => <button key={suggestion} className="suggestion-card" onClick={() => { setDraft(suggestion); textareaRef.current?.focus(); }}><span className="suggestion-icon">{["◇", "◌", "✳", "↗"][index]}</span><span>{suggestion}</span><span className="suggestion-arrow">↗</span></button>)}
          </div>
        </div> : <div className="message-thread">
          {messages.map((message, index) => <article className={`message-row ${message.role}`} key={message.id || `${index}-${message.role}`}>
            <div className={`message-avatar ${message.role}`}>{message.role === "user" ? "Y" : "✳"}</div>
            <div className="message-body"><div className="message-author">{message.role === "user" ? "You" : "Astra"}{message.role === "assistant" && message.model ? <span className="model-note">· {message.model}</span> : null}</div><div className={`message-content ${message.role === "assistant" ? "markdown-content" : ""}`}>{message.content ? message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock> }}>{message.content}</ReactMarkdown> : message.content : busy && index === messages.length - 1 ? <span className="typing-indicator"><i/><i/><i/></span> : ""}</div>
              {message.attachments?.length ? <MessageAttachments items={message.attachments}/> : null}
              {message.pendingAttachments?.length ? <PendingAttachmentTray items={message.pendingAttachments} onRemove={removeAttachment}/> : null}
              {message.role === "assistant" && message.content && <div className="message-actions"><button type="button" onClick={() => void copyResponse(message, index)} disabled={busy && index === messages.length - 1} aria-label="Copy response"><span aria-hidden="true">{copiedMessage === (message.id || `message-${index}`) ? "✓" : "▢"}</span>{copiedMessage === (message.id || `message-${index}`) ? "Copied" : "Copy response"}</button></div>}
            </div>
          </article>)}
          <div ref={bottomRef}/>
        </div>}
      </div>
      {showJumpToLatest && <button type="button" className="jump-to-latest" onClick={jumpToLatest}><span aria-hidden="true">↓</span> Latest reply</button>}
      <div className="composer-area">
        {error && <div className="error-banner" role="alert"><span>!</span>{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.txt,.md,.csv,.json,video/mp4,video/webm,video/quicktime" onChange={(event) => void handleFilesSelected(event)} />
          <PendingAttachmentTray items={attachments} onRemove={removeAttachment}/>
          {processingFiles && <div className="processing-attachments"><span className="send-spinner"/> Preparing attachments…</div>}
          <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={attachments.length ? "Ask something about these files…" : "Message Astra…"} rows={1} maxLength={12000} aria-label="Your message" />
          <div className="composer-toolbar">
            <div className="composer-tools"><button type="button" className="attach-button" onClick={() => fileInputRef.current?.click()} disabled={busy || processingFiles} aria-label="Attach image, video, or document" title="Attach image, video, or document">＋<span>Attach</span></button>
              <ModelPicker value={selectedModel} models={models} message={modelMessage} loading={loadingModels} onChange={chooseModel} onRefresh={() => void refreshModels()}/></div>
            <div className="composer-actions"><span className="enter-hint">↵ to send · shift + ↵ for new line</span><button type="submit" className="send-button" disabled={busy || processingFiles || (!draft.trim() && attachments.length === 0)} aria-label="Send message">{busy ? <span className="send-spinner"/> : "↑"}</button></div>
          </div>
        </form>
        <p className="disclaimer">AI can make mistakes. Take a moment to verify important information. Video audio is not transcribed.</p>
      </div>
    </section>
  </main>;
}
