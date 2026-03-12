import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AgentAttachment, ChatMessage } from "../types";
import { useAppStore } from "../stores/appStore";
import { debugLogger } from "./debugLogger";

interface LlmResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface LlmStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
}

interface LlmMessagePayload {
  role: string;
  content: string;
}

interface StreamCallbacks {
  onToken?: (token: string) => void;
  onReasoning?: (token: string) => void;
  signal?: AbortSignal;
}

interface RequestOptions {
  extraPayload?: Record<string, unknown>;
}

const DEFAULT_TRANSLATION_PROMPT =
  "You are an academic translator. Translate the input into polished Chinese. Output only the final translation content. Do not include explanations, notes, headings, or reasoning.";

const resolveChatEndpoint = (rawBaseUrl: string) => {
  const base = rawBaseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  try {
    const url = new URL(base);
    if (!url.pathname || url.pathname === "/") return `${base}/v1/chat/completions`;
    return `${base}/chat/completions`;
  } catch {
    return `${base}/chat/completions`;
  }
};

const throwAbortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
};

const getRequestContext = (messages: LlmMessagePayload[], stream: boolean, options: RequestOptions = {}) => {
  const { baseUrl, apiKey, model } = useAppStore.getState().settings;
  if (!baseUrl) throw new Error("Base URL is required.");
  if (!apiKey) throw new Error("API key is required.");

  const endpoint = resolveChatEndpoint(baseUrl);
  if (messages.length === 0) throw new Error("messages is empty; cannot send chat request.");

  const payload = { model, messages, stream, ...options.extraPayload };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  debugLogger.info(
    `[LLM] POST ${endpoint} model=${model} messages=${messages.length} stream=${stream} firstRole=${messages[0]?.role ?? "n/a"}`
  );

  return {
    endpoint,
    apiKey,
    model,
    messages,
    headers,
    body: JSON.stringify(payload)
  };
};

const readJsonResponse = async (response: Response) => {
  if (!response.ok) {
    const text = await response.text();
    debugLogger.error(`[LLM] HTTP ${response.status} ${text}`);
    throw new Error(`LLM request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as LlmResponse;
  const content = data.choices?.[0]?.message?.content ?? "";
  debugLogger.info(`[LLM] response ok chars=${content.length}`);
  return content;
};

const postChat = async (messages: LlmMessagePayload[], signal?: AbortSignal, options: RequestOptions = {}) => {
  const { endpoint, apiKey, model, messages: safeMessages, headers, body } = getRequestContext(messages, false, options);
  let response: Response;

  try {
    response = await fetch(endpoint, { method: "POST", headers, body, signal });
  } catch (nativeError: unknown) {
    const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
    throwAbortIfNeeded(signal);
    debugLogger.warn(`[LLM] native fetch failed, fallback to rust proxy: ${nativeMessage}`);
    try {
      const content = await invoke<string>("llm_chat_proxy", {
        endpoint,
        apiKey,
        model,
        messages: safeMessages
      });
      debugLogger.info(`[LLM] rust proxy response ok chars=${content.length}`);
      return content;
    } catch (proxyError: unknown) {
      const proxyMessage = proxyError instanceof Error ? proxyError.message : String(proxyError);
      debugLogger.warn(`[LLM] rust proxy failed, fallback to tauri-http: ${proxyMessage}`);
      response = await tauriFetch(endpoint, { method: "POST", headers, body });
    }
  }

  return readJsonResponse(response);
};

const processSseBuffer = (buffer: string, onChunk: (data: string) => void) => {
  let nextBuffer = buffer;
  let boundaryIndex = nextBuffer.indexOf("\n\n");

  while (boundaryIndex !== -1) {
    const eventBlock = nextBuffer.slice(0, boundaryIndex);
    nextBuffer = nextBuffer.slice(boundaryIndex + 2);
    const dataLines = eventBlock
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    for (const line of dataLines) {
      if (line) onChunk(line);
    }

    boundaryIndex = nextBuffer.indexOf("\n\n");
  }

  return nextBuffer;
};

const postChatStream = async (messages: LlmMessagePayload[], callbacks: StreamCallbacks = {}, options: RequestOptions = {}) => {
  const { endpoint, headers, body } = getRequestContext(messages, true, options);
  const { onToken, onReasoning, signal } = callbacks;
  let fullContent = "";

  try {
    const response = await fetch(endpoint, { method: "POST", headers, body, signal });
    if (!response.ok) {
      const text = await response.text();
      debugLogger.error(`[LLM] stream HTTP ${response.status} ${text}`);
      throw new Error(`LLM request failed: ${response.status} ${text}`);
    }
    if (!response.body) {
      debugLogger.warn("[LLM] streaming response has no body; fallback to non-stream");
      const content = await postChat(messages, signal, options);
      if (content) onToken?.(content);
      return content;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      throwAbortIfNeeded(signal);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      buffer = processSseBuffer(buffer, (data) => {
        if (data === "[DONE]") return;
        const parsed = JSON.parse(data) as LlmStreamChunk;
        const delta = parsed.choices?.[0]?.delta;
        const reasoning = delta?.reasoning_content ?? "";
        const content = delta?.content ?? "";
        if (reasoning) onReasoning?.(reasoning);
        if (content) {
          fullContent += content;
          onToken?.(content);
        }
      });
    }

    buffer += decoder.decode().replace(/\r\n/g, "\n");
    processSseBuffer(buffer, (data) => {
      if (data === "[DONE]") return;
      const parsed = JSON.parse(data) as LlmStreamChunk;
      const delta = parsed.choices?.[0]?.delta;
      const reasoning = delta?.reasoning_content ?? "";
      const content = delta?.content ?? "";
      if (reasoning) onReasoning?.(reasoning);
      if (content) {
        fullContent += content;
        onToken?.(content);
      }
    });

    debugLogger.info(`[LLM] stream response ok chars=${fullContent.length}`);
    return fullContent;
  } catch (error) {
    throwAbortIfNeeded(signal);
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(`[LLM] streaming failed, fallback to non-stream: ${message}`);
    const content = await postChat(messages, signal, options);
    if (content) {
      const remainder = fullContent ? content.slice(fullContent.length) : content;
      if (remainder) onToken?.(remainder);
    }
    return content;
  }
};

const buildAttachmentContext = (attachments: AgentAttachment[]) =>
  `Attached reference files:\n${attachments.map((item) => `### ${item.name}\n${item.content.slice(0, 12000)}`).join("\n\n")}`;

const buildProjectContext = () => {
  const state = useAppStore.getState();
  const blocks: string[] = [];

  if (state.pdfPath) {
    const pdfText = Object.entries(state.pageTextCache)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, 8)
      .map(([page, text]) => `Page ${page}\n${text.slice(0, 1800)}`)
      .join("\n\n");
    if (pdfText.trim()) {
      blocks.push(`Current PDF: ${state.pdfName || state.pdfPath}\n${pdfText}`);
    }
  }

  if (state.notes.trim()) {
    blocks.push(`Current markdown notes:\n${state.notes.slice(0, 16000)}`);
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "";
};

const buildChatPayload = (messages: ChatMessage[]) => {
  const { settings, attachments } = useAppStore.getState();
  const rawPayload = messages
    .filter((message) => (message.source ?? "chat") === "chat")
    .map((message) => ({ role: message.role, content: message.content }));
  const firstNonAssistantIndex = rawPayload.findIndex((message) => message.role !== "assistant");
  const payload = firstNonAssistantIndex >= 0 ? rawPayload.slice(firstNonAssistantIndex) : rawPayload;
  const prefix: LlmMessagePayload[] = [];

  if (settings.chatSystemPrompt.trim()) {
    prefix.push({ role: "system", content: settings.chatSystemPrompt.trim() });
  }
  if (settings.glossary.trim()) {
    prefix.push({ role: "system", content: `Glossary / preferred terminology:\n${settings.glossary.trim()}` });
  }
  if (settings.enableAgentAttachments && attachments.length > 0) {
    prefix.push({ role: "system", content: buildAttachmentContext(attachments) });
  }
  if (settings.includeProjectContextInChat) {
    const projectContext = buildProjectContext();
    if (projectContext) {
      prefix.push({ role: "system", content: projectContext });
    }
  }

  return [...prefix, ...payload];
};

const buildTranslationPayload = (text: string) => {
  const { translationPrompt, glossary } = useAppStore.getState().settings;
  return [
    { role: "system", content: translationPrompt.trim() || DEFAULT_TRANSLATION_PROMPT },
    ...(glossary.trim() ? [{ role: "system", content: `Use this glossary consistently:\n${glossary.trim()}` }] : []),
    { role: "user", content: text || "No extractable text on this page." }
  ];
};

export const llmService = {
  async sendChat(messages: ChatMessage[]): Promise<string> {
    return postChat(buildChatPayload(messages));
  },

  async sendChatStream(messages: ChatMessage[], callbacks?: StreamCallbacks): Promise<string> {
    return postChatStream(buildChatPayload(messages), callbacks);
  },

  async translatePage(text: string, signal?: AbortSignal): Promise<string> {
    return postChat(buildTranslationPayload(text), signal, { extraPayload: { enable_thinking: false } });
  },

  async translatePageStream(text: string, callbacks?: StreamCallbacks): Promise<string> {
    return postChatStream(buildTranslationPayload(text), callbacks, { extraPayload: { enable_thinking: false } });
  },

  async testConnection(): Promise<string> {
    return postChat([
      { role: "system", content: "Reply briefly." },
      { role: "user", content: "connection test" }
    ]);
  }
};
