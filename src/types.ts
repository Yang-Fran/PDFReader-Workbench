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
  titleEdited?: boolean;
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

export interface PdfExportMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PdfExportSlotKind = "none" | "title" | "date" | "pageNumber" | "pageNumberTotal" | "custom";

export interface PdfExportSlot {
  kind: PdfExportSlotKind;
  text: string;
}

export interface PdfExportHeaderFooter {
  enabled: boolean;
  left: PdfExportSlot;
  center: PdfExportSlot;
  right: PdfExportSlot;
}

export interface PdfExportSettings {
  pageSize: "A4" | "Letter";
  landscape: boolean;
  scale: number;
  includeToc: boolean;
  sourcePath: string;
  margins: PdfExportMargins;
  header: PdfExportHeaderFooter;
  footer: PdfExportHeaderFooter;
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
  enableAgentStreaming: boolean;
  enableTranslationStreaming: boolean;
  translationHighlightKeyPoints: boolean;
  translationCarryover: boolean;
  chatSystemPrompt: string;
  translationPrompt: string;
  glossary: string;
  pdfExport: PdfExportSettings;
}

export type TranslationExecutionMode = "stream" | "expli";

export interface TranslationTaskState {
  active: boolean;
  phase: "preparing" | "translating";
  completedPages: number;
  totalPages: number;
  mode: TranslationExecutionMode;
  warning: string;
}

export type ViewerMode = "single" | "dual";

export type TranslationStatus = "idle" | "queued" | "translating" | "done" | "error";

export interface PdfViewState {
  zoomScale: number;
  textLayerVisible: boolean;
  pdfLayerVisible: boolean;
  scrollLinked: boolean;
  scrollPosition?: PageScrollState;
}

export interface TranslationPageMetrics {
  pdfWidth: number;
  pdfHeight: number;
  translationCardHeight: number;
  translationContentHeight: number;
}

export interface PageScrollState {
  page: number;
  progress: number;
}

export interface NotesViewState {
  editorScrollTop: number;
  previewScrollTop: number;
  selectionAnchor: number;
}

export interface TranslationDocumentCache {
  pdfPath: string;
  pdfName: string;
  currentPage: number;
  pageTextCache: Record<number, string>;
  pageTranslationCache: Record<number, string>;
  pageTranslationStatus: Record<number, TranslationStatus>;
  pageMetrics: Record<number, TranslationPageMetrics>;
  pageCarryover: Record<number, string>;
  viewState: PageScrollState;
}

export interface ProjectSnapshot {
  version: 2 | 3 | 4;
  savedAt: string;
  pdfPath: string;
  pdfName: string;
  notesPath?: string;
  currentPage: number;
  viewerMode: ViewerMode;
  pdfViewState?: PdfViewState;
  pdfViewDocuments?: Record<string, PdfViewState>;
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
  notesViewState?: NotesViewState;
  settings?: Pick<AppSettings, "baseUrl" | "model">;
}
