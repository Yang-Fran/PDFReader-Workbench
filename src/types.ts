export type ChatRole = "user" | "assistant" | "system";
export type ChatSource = "chat" | "command" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  createdAt: number;
  source?: ChatSource;
}

export interface AgentDialog {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface PdfQuote {
  text: string;
  page: number;
  pdfPath: string;
  pdfName: string;
}

export interface AgentAttachment {
  id: string;
  name: string;
  content: string;
  page?: number;
  sourcePath?: string;
}

export interface WorkspaceFileRef {
  id: string;
  path: string;
  name: string;
  relativePath: string;
  kind: "pdf" | "md";
  mounted: boolean;
}

export interface CacheFileRecord {
  name: string;
  bytes: number;
}

export interface CacheSummary {
  translationCacheBytes: number;
  translationCacheFiles: number;
  llmCacheBytes: number;
  llmCacheFiles: number;
  translationFiles: CacheFileRecord[];
  llmFiles: CacheFileRecord[];
}

export interface ApiQuotaInfo {
  remainingRequests?: string;
  remainingTokens?: string;
  limitRequests?: string;
  limitTokens?: string;
  resetRequests?: string;
  resetTokens?: string;
}

export interface AppSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: "zh" | "en";
  accentColor: string;
  themeMode: "light" | "dark";
  showThinking: boolean;
  enableAgentAttachments: boolean;
  includeProjectContextInChat: boolean;
  hideCommandMessages: boolean;
  chatSystemPrompt: string;
  translationPrompt: string;
  glossary: string;
}

export type ViewerMode = "single" | "dual";

export type TranslationStatus = "idle" | "queued" | "translating" | "done" | "error";

export interface TranslationDocumentCache {
  pdfPath: string;
  pdfName: string;
  currentPage: number;
  pageTextCache: Record<number, string>;
  pageTranslationCache: Record<number, string>;
  pageTranslationStatus: Record<number, TranslationStatus>;
}

export interface ProjectSnapshot {
  version: 2 | 3;
  savedAt: string;
  pdfPath: string;
  pdfName: string;
  notesPath?: string;
  currentPage: number;
  viewerMode: ViewerMode;
  notes: string;
  dialogs: AgentDialog[];
  activeDialogId: string;
  lastAIReply: string;
  pageTextCache: Record<number, string>;
  pageTranslationCache: Record<number, string>;
  pageTranslationStatus: Record<number, TranslationStatus>;
  translationDocuments?: Record<string, TranslationDocumentCache>;
  workspaceFiles: WorkspaceFileRef[];
  translationCacheIndex: string[];
  llmCacheIndex: string[];
  projectStateCache?: string;
  settings: Pick<AppSettings, "baseUrl" | "model">;
}
