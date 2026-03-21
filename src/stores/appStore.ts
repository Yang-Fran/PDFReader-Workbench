import { create } from "zustand";
import {
  AgentAttachment,
  AgentDialog,
  ApiQuotaInfo,
  AppSettings,
  ChatMessage,
  PdfExportSettings,
  PdfViewState,
  PdfQuote,
  ProjectSnapshot,
  TranslationPageMetrics,
  TranslationDocumentCache,
  TranslationTaskState,
  TranslationStatus,
  ViewerMode,
  WorkspaceFileRef
} from "../types";
import { createBeginnerGuideMessages, getBeginnerDialogTitle } from "../services/beginnerGuide";

const SETTINGS_KEY = "pdfreader_settings";

const createDialogId = () => `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createEmptyDialog = (title = "New dialog"): AgentDialog => {
  const now = Date.now();
  return {
    id: createDialogId(),
    title,
    titleEdited: false,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
};

const createBeginnerDialog = (language: "zh" | "en"): AgentDialog => {
  const messages = createBeginnerGuideMessages(language);
  const createdAt = messages[0]?.createdAt ?? Date.now();
  const updatedAt = messages[messages.length - 1]?.createdAt ?? createdAt;
  return {
    id: createDialogId(),
    title: getBeginnerDialogTitle(language),
    titleEdited: true,
    createdAt,
    updatedAt,
    messages
  };
};

const defaultSettings: AppSettings = {
  baseUrl: "http://127.0.0.1:1234",
  apiKey: "",
  model: "qwen/qwen3.5-9b",
  language: "zh",
  accentColor: "#2563eb",
  themeMode: "light",
  showThinking: true,
  enableAgentAttachments: true,
  includeProjectContextInChat: true,
  hideCommandMessages: false,
  enableAgentStreaming: true,
  enableTranslationStreaming: true,
  chatSystemPrompt: "",
  translationPrompt: "",
  glossary: "",
  pdfExport: {
    pageSize: "A4",
    landscape: false,
    scale: 1,
    sourcePath: "",
    margins: {
      top: 12,
      right: 12,
      bottom: 14,
      left: 12
    },
    header: {
      enabled: false,
      left: { kind: "none", text: "" },
      center: { kind: "title", text: "" },
      right: { kind: "date", text: "" }
    },
    footer: {
      enabled: true,
      left: { kind: "none", text: "" },
      center: { kind: "none", text: "" },
      right: { kind: "pageNumberTotal", text: "" }
    }
  }
};

const mergePdfExportSettings = (value?: Partial<PdfExportSettings> | null): PdfExportSettings => {
  const mergedHeader = {
    ...defaultSettings.pdfExport.header,
    ...(value?.header ?? {}),
    left: {
      ...defaultSettings.pdfExport.header.left,
      ...(value?.header?.left ?? {})
    },
    center: {
      ...defaultSettings.pdfExport.header.center,
      ...(value?.header?.center ?? {})
    },
    right: {
      ...defaultSettings.pdfExport.header.right,
      ...(value?.header?.right ?? {})
    }
  };

  const mergedFooter = {
    ...defaultSettings.pdfExport.footer,
    ...(value?.footer ?? {}),
    left: {
      ...defaultSettings.pdfExport.footer.left,
      ...(value?.footer?.left ?? {})
    },
    center: {
      ...defaultSettings.pdfExport.footer.center,
      ...(value?.footer?.center ?? {})
    },
    right: {
      ...defaultSettings.pdfExport.footer.right,
      ...(value?.footer?.right ?? {})
    }
  };

  return {
    pageSize: value?.pageSize ?? defaultSettings.pdfExport.pageSize,
    landscape: value?.landscape ?? defaultSettings.pdfExport.landscape,
    scale: value?.scale ?? defaultSettings.pdfExport.scale,
    sourcePath: value?.sourcePath ?? defaultSettings.pdfExport.sourcePath,
    margins: {
      ...defaultSettings.pdfExport.margins,
      ...(value?.margins ?? {})
    },
    header: mergedHeader,
    footer: mergedFooter
  };
};

const loadSettings = (): AppSettings => {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaultSettings,
      ...parsed,
      pdfExport: mergePdfExportSettings(parsed.pdfExport)
    };
  } catch {
    return defaultSettings;
  }
};

const inferDialogTitle = (messages: ChatMessage[], fallback: string) => {
  const userMessage = messages.find((item) => item.role === "user" && item.content.trim());
  if (!userMessage) return fallback;
  return userMessage.content.trim().slice(0, 24) || fallback;
};

const normalizeDialogTitleState = (dialog: AgentDialog): AgentDialog => {
  if (typeof dialog.titleEdited === "boolean") return dialog;
  const inferredTitle = inferDialogTitle(dialog.messages, dialog.title);
  return {
    ...dialog,
    titleEdited: dialog.messages.some((item) => item.role === "user" && item.content.trim()) && dialog.title.trim() !== inferredTitle.trim()
  };
};

const emptyTranslationDocument = (pdfPath = "", pdfName = ""): TranslationDocumentCache => ({
  pdfPath,
  pdfName,
  currentPage: 1,
  pageTextCache: {},
  pageTranslationCache: {},
  pageTranslationStatus: {},
  pageMetrics: {}
});

const defaultPdfViewState: PdfViewState = {
  zoomScale: 1.2,
  textLayerVisible: true,
  pdfLayerVisible: true,
  scrollLinked: true
};

const defaultTranslationTaskState: TranslationTaskState = {
  active: false,
  phase: "preparing",
  completedPages: 0,
  totalPages: 0,
  mode: "stream",
  warning: ""
};

interface AppState {
  settings: AppSettings;
  notes: string;
  notesFilePath: string;
  dialogs: AgentDialog[];
  activeDialogId: string;
  attachments: AgentAttachment[];
  workspaceFiles: WorkspaceFileRef[];
  lastAIReply: string;
  selectedPdfText: string;
  selectedPdfQuote: PdfQuote | null;
  currentPageText: string;
  currentPageTranslation: string;
  pageTextCache: Record<number, string>;
  pageTranslationCache: Record<number, string>;
  pageTranslationStatus: Record<number, TranslationStatus>;
  pageTranslationMetrics: Record<number, TranslationPageMetrics>;
  translationDocuments: Record<string, TranslationDocumentCache>;
  pdfViewDocuments: Record<string, PdfViewState>;
  translationQueue: number[];
  currentPage: number;
  totalPages: number;
  pdfPath: string;
  pdfName: string;
  projectPath: string;
  projectDirty: boolean;
  viewerMode: ViewerMode;
  pdfViewState: PdfViewState;
  translationTask: TranslationTaskState;
  apiQuotaInfo: ApiQuotaInfo | null;
  pdfOpenRequest: { path: string; preserveState: boolean; targetPage?: number; requestId: number } | null;
  setSettings: (patch: Partial<AppSettings>) => void;
  setNotes: (value: string) => void;
  appendToNotes: (value: string) => void;
  setNotesFilePath: (value: string) => void;
  setDialogs: (value: AgentDialog[]) => void;
  createDialog: (title?: string) => string;
  deleteDialog: (id: string) => void;
  renameDialog: (id: string, title: string) => void;
  setActiveDialog: (id: string) => void;
  replaceDialogMessages: (dialogId: string, messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage, dialogId?: string) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  clearMessages: (dialogId?: string) => void;
  setAttachments: (value: AgentAttachment[]) => void;
  addAttachment: (value: AgentAttachment) => void;
  removeAttachment: (id: string) => void;
  setWorkspaceFiles: (value: WorkspaceFileRef[]) => void;
  addWorkspaceFiles: (value: WorkspaceFileRef[]) => void;
  removeWorkspaceFile: (path: string) => void;
  setLastAIReply: (value: string) => void;
  setSelectedPdfText: (value: string) => void;
  setSelectedPdfQuote: (value: PdfQuote | null) => void;
  setCurrentPageText: (value: string) => void;
  setCurrentPageTranslation: (value: string) => void;
  setPageTextCache: (page: number, value: string) => void;
  setPageTranslationCache: (page: number, value: string) => void;
  setPageTranslationStatus: (page: number, value: TranslationStatus) => void;
  setPageTranslationMetrics: (page: number, value: Partial<TranslationPageMetrics>) => void;
  setTranslationQueue: (pages: number[]) => void;
  clearPageTextCache: () => void;
  clearPageTranslationCache: () => void;
  clearPageTranslationStatus: () => void;
  clearPageTranslationMetrics: () => void;
  restoreTranslationCacheForPdf: (pdfPath: string, pdfName?: string) => void;
  clearAllTranslationDocuments: () => void;
  setCurrentPage: (value: number) => void;
  setTotalPages: (value: number) => void;
  setPdfPath: (value: string) => void;
  setPdfName: (value: string) => void;
  setProjectPath: (value: string) => void;
  setProjectDirty: (value: boolean) => void;
  setViewerMode: (value: ViewerMode) => void;
  setPdfViewState: (patch: Partial<PdfViewState>) => void;
  setTranslationTask: (patch: Partial<TranslationTaskState>) => void;
  resetTranslationTask: () => void;
  setApiQuotaInfo: (value: ApiQuotaInfo | null) => void;
  requestPdfOpen: (path: string, options?: { preserveState?: boolean; targetPage?: number }) => void;
  clearPdfOpenRequest: () => void;
  hydrateProject: (snapshot: ProjectSnapshot, projectPath: string, notes: string) => void;
  resetWorkspace: (options?: { seedBeginner?: boolean }) => void;
}

const initialDialog = createEmptyDialog("Dialog 1");

export const useAppStore = create<AppState>((set) => ({
  settings: loadSettings(),
  notes: "",
  notesFilePath: "",
  dialogs: [initialDialog],
  activeDialogId: initialDialog.id,
  attachments: [],
  workspaceFiles: [],
  lastAIReply: "",
  selectedPdfText: "",
  selectedPdfQuote: null,
  currentPageText: "",
  currentPageTranslation: "",
  pageTextCache: {},
  pageTranslationCache: {},
  pageTranslationStatus: {},
  pageTranslationMetrics: {},
  translationDocuments: {},
  pdfViewDocuments: {},
  translationQueue: [],
  currentPage: 1,
  totalPages: 0,
  pdfPath: "",
  pdfName: "",
  projectPath: "",
  projectDirty: false,
  viewerMode: "single",
  pdfViewState: defaultPdfViewState,
  translationTask: defaultTranslationTaskState,
  apiQuotaInfo: null,
  pdfOpenRequest: null,
  setSettings: (patch) =>
    set((state) => {
      const next = {
        ...state.settings,
        ...patch,
        pdfExport: patch.pdfExport ? mergePdfExportSettings({ ...state.settings.pdfExport, ...patch.pdfExport }) : state.settings.pdfExport
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return { settings: next, projectDirty: true };
    }),
  setNotes: (value) =>
    set(() => ({ notes: value, projectDirty: true })),
  appendToNotes: (value) =>
    set((state) => {
      const next = state.notes ? `${state.notes}\n\n${value}` : value;
      return { notes: next, projectDirty: true };
    }),
  setNotesFilePath: (value) => set({ notesFilePath: value, projectDirty: true }),
  setDialogs: (value) =>
    set(() => {
      const next = (value.length > 0 ? value : [createEmptyDialog("Dialog 1")]).map(normalizeDialogTitleState);
      return {
        dialogs: next,
        activeDialogId: next[0].id,
        projectDirty: true
      };
    }),
  createDialog: (title) => {
    const dialog = createEmptyDialog(title || `Dialog ${Date.now() % 100000}`);
    if (title?.trim()) {
      dialog.titleEdited = true;
    }
    set((state) => ({
      dialogs: [...state.dialogs, dialog],
      activeDialogId: dialog.id,
      projectDirty: true
    }));
    return dialog.id;
  },
  deleteDialog: (id) =>
    set((state) => {
      if (state.dialogs.length <= 1) return state;
      const dialogs = state.dialogs.filter((dialog) => dialog.id !== id);
      if (dialogs.length === state.dialogs.length) return state;
      return {
        dialogs,
        activeDialogId: state.activeDialogId === id ? dialogs[Math.max(0, dialogs.length - 1)]?.id ?? dialogs[0].id : state.activeDialogId,
        projectDirty: true
      };
    }),
  renameDialog: (id, title) =>
    set((state) => ({
      dialogs: state.dialogs.map((dialog) =>
        dialog.id === id
          ? {
              ...dialog,
              title: title.trim() || dialog.title,
              titleEdited: true,
              updatedAt: Date.now()
            }
          : dialog
      ),
      projectDirty: true
    })),
  setActiveDialog: (id) => set({ activeDialogId: id }),
  replaceDialogMessages: (dialogId, messages) =>
    set((state) => ({
      dialogs: state.dialogs.map((dialog) =>
        dialog.id !== dialogId
          ? dialog
          : {
              ...dialog,
              title: dialog.titleEdited ? dialog.title : inferDialogTitle(messages, dialog.title),
              messages,
              updatedAt: Date.now()
            }
      ),
      projectDirty: true
    })),
  addMessage: (message, dialogId) =>
    set((state) => {
      const targetId = dialogId ?? state.activeDialogId;
      return {
        dialogs: state.dialogs.map((dialog) =>
          dialog.id !== targetId
            ? dialog
            : {
                ...dialog,
                title: dialog.titleEdited ? dialog.title : inferDialogTitle([...dialog.messages, message], dialog.title),
                updatedAt: Date.now(),
                messages: [...dialog.messages, message]
              }
        ),
        projectDirty: true
      };
    }),
  updateMessage: (id, patch) =>
    set((state) => ({
      dialogs: state.dialogs.map((dialog) => ({
        ...dialog,
        updatedAt: dialog.messages.some((message) => message.id === id) ? Date.now() : dialog.updatedAt,
        messages: dialog.messages.map((message) => (message.id === id ? { ...message, ...patch } : message))
      })),
      projectDirty: true
    })),
  clearMessages: (dialogId) =>
    set((state) => {
      const targetId = dialogId ?? state.activeDialogId;
      return {
        dialogs: state.dialogs.map((dialog) => (dialog.id === targetId ? { ...dialog, messages: [], updatedAt: Date.now() } : dialog)),
        projectDirty: true
      };
    }),
  setAttachments: (value) => set({ attachments: value, projectDirty: true }),
  addAttachment: (value) => set((state) => ({ attachments: [...state.attachments, value], projectDirty: true })),
  removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id), projectDirty: true })),
  setWorkspaceFiles: (value) => set({ workspaceFiles: value, projectDirty: true }),
  addWorkspaceFiles: (value) =>
    set((state) => {
      const existing = new Map(state.workspaceFiles.map((item) => [item.path, item]));
      for (const file of value) existing.set(file.path, file);
      return { workspaceFiles: Array.from(existing.values()), projectDirty: true };
    }),
  removeWorkspaceFile: (path) => set((state) => ({ workspaceFiles: state.workspaceFiles.filter((item) => item.path !== path), projectDirty: true })),
  setLastAIReply: (value) => set({ lastAIReply: value, projectDirty: true }),
  setSelectedPdfText: (value) => set({ selectedPdfText: value }),
  setSelectedPdfQuote: (value) => set({ selectedPdfQuote: value }),
  setCurrentPageText: (value) => set({ currentPageText: value }),
  setCurrentPageTranslation: (value) => set({ currentPageTranslation: value }),
  setPageTextCache: (page, value) =>
    set((state) => {
      const pageTextCache = { ...state.pageTextCache, [page]: value };
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus
            }
          }
        : state.translationDocuments;
      return { pageTextCache, translationDocuments, projectDirty: true };
    }),
  setPageTranslationCache: (page, value) =>
    set((state) => {
      const pageTranslationCache = { ...state.pageTranslationCache, [page]: value };
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus
            }
          }
        : state.translationDocuments;
      return { pageTranslationCache, translationDocuments, projectDirty: true };
    }),
  setPageTranslationStatus: (page, value) =>
    set((state) => {
      const pageTranslationStatus = { ...state.pageTranslationStatus, [page]: value };
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus,
              pageMetrics: state.pageTranslationMetrics
            }
          }
        : state.translationDocuments;
      return { pageTranslationStatus, translationDocuments, projectDirty: true };
    }),
  setPageTranslationMetrics: (page, value) =>
    set((state) => {
      const currentMetric = state.pageTranslationMetrics[page];
      const nextMetric = { ...(currentMetric ?? { pdfWidth: 0, pdfHeight: 0, translationCardHeight: 0, translationContentHeight: 0 }), ...value };
      if (
        currentMetric &&
        Math.abs(currentMetric.pdfWidth - nextMetric.pdfWidth) < 0.5 &&
        Math.abs(currentMetric.pdfHeight - nextMetric.pdfHeight) < 0.5 &&
        Math.abs(currentMetric.translationCardHeight - nextMetric.translationCardHeight) < 0.5 &&
        Math.abs(currentMetric.translationContentHeight - nextMetric.translationContentHeight) < 0.5
      ) {
        return state;
      }

      const pageTranslationMetrics = { ...state.pageTranslationMetrics, [page]: nextMetric };
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus,
              pageMetrics: pageTranslationMetrics
            }
          }
        : state.translationDocuments;

      return { pageTranslationMetrics, translationDocuments, projectDirty: true };
    }),
  setTranslationQueue: (pages) => set({ translationQueue: pages }),
  clearPageTextCache: () =>
    set((state) => {
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: {},
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus,
              pageMetrics: state.pageTranslationMetrics
            }
          }
        : state.translationDocuments;
      return { pageTextCache: {}, translationDocuments, projectDirty: true };
    }),
  clearPageTranslationCache: () =>
    set((state) => {
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: {},
              pageTranslationStatus: state.pageTranslationStatus,
              pageMetrics: state.pageTranslationMetrics
            }
          }
        : state.translationDocuments;
      return { pageTranslationCache: {}, translationDocuments, projectDirty: true };
    }),
  clearPageTranslationStatus: () =>
    set((state) => {
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: {},
              pageMetrics: state.pageTranslationMetrics
            }
          }
        : state.translationDocuments;
      return { pageTranslationStatus: {}, translationDocuments, projectDirty: true };
    }),
  clearPageTranslationMetrics: () =>
    set((state) => {
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: state.currentPage,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus,
              pageMetrics: {}
            }
          }
        : state.translationDocuments;
      return { pageTranslationMetrics: {}, translationDocuments, projectDirty: true };
    }),
  restoreTranslationCacheForPdf: (pdfPath, pdfName) =>
    set((state) => {
      const documentCache = state.translationDocuments[pdfPath] ?? emptyTranslationDocument(pdfPath, pdfName ?? "");
      return {
        pageTextCache: documentCache.pageTextCache,
        pageTranslationCache: documentCache.pageTranslationCache,
        pageTranslationStatus: documentCache.pageTranslationStatus,
        pageTranslationMetrics: documentCache.pageMetrics ?? {},
        currentPageText: documentCache.pageTextCache[documentCache.currentPage] ?? "",
        currentPageTranslation: documentCache.pageTranslationCache[documentCache.currentPage] ?? "",
        translationDocuments: {
          ...state.translationDocuments,
          [pdfPath]: {
            ...documentCache,
            pdfPath,
            pdfName: pdfName ?? documentCache.pdfName,
            pageMetrics: documentCache.pageMetrics ?? {}
          }
        },
        projectDirty: true
      };
    }),
  clearAllTranslationDocuments: () =>
    set({
      pageTextCache: {},
      pageTranslationCache: {},
      pageTranslationStatus: {},
      pageTranslationMetrics: {},
      currentPageText: "",
      currentPageTranslation: "",
      translationDocuments: {},
      projectDirty: true
    }),
  setCurrentPage: (value) =>
    set((state) => {
      const translationDocuments = state.pdfPath
        ? {
            ...state.translationDocuments,
            [state.pdfPath]: {
              ...(state.translationDocuments[state.pdfPath] ?? emptyTranslationDocument(state.pdfPath, state.pdfName)),
              pdfPath: state.pdfPath,
              pdfName: state.pdfName,
              currentPage: value,
              pageTextCache: state.pageTextCache,
              pageTranslationCache: state.pageTranslationCache,
              pageTranslationStatus: state.pageTranslationStatus,
              pageMetrics: state.pageTranslationMetrics
            }
          }
        : state.translationDocuments;
      return { currentPage: value, translationDocuments, projectDirty: true };
    }),
  setTotalPages: (value) => set({ totalPages: value }),
  setPdfPath: (value) => set({ pdfPath: value, projectDirty: true }),
  setPdfName: (value) => set({ pdfName: value, projectDirty: true }),
  setProjectPath: (value) => set({ projectPath: value }),
  setProjectDirty: (value) => set({ projectDirty: value }),
  setViewerMode: (value) => set({ viewerMode: value, projectDirty: true }),
  setPdfViewState: (patch) =>
    set((state) => {
      const pdfViewState = { ...state.pdfViewState, ...patch };
      const pdfViewDocuments = state.pdfPath
        ? {
            ...state.pdfViewDocuments,
            [state.pdfPath]: pdfViewState
          }
        : state.pdfViewDocuments;
      return {
        pdfViewState,
        pdfViewDocuments,
        projectDirty: true
      };
    }),
  setTranslationTask: (patch) =>
    set((state) => ({
      translationTask: { ...state.translationTask, ...patch }
    })),
  resetTranslationTask: () => set({ translationTask: defaultTranslationTaskState }),
  setApiQuotaInfo: (value) => set({ apiQuotaInfo: value }),
  requestPdfOpen: (path, options) =>
    set((state) => ({
      pdfOpenRequest: {
        path,
        preserveState: options?.preserveState ?? false,
        targetPage: options?.targetPage,
        requestId: (state.pdfOpenRequest?.requestId ?? 0) + 1
      }
    })),
  clearPdfOpenRequest: () => set({ pdfOpenRequest: null }),
  hydrateProject: (snapshot, projectPath, notes) =>
    set((state) => {
      const fallbackDialog = createEmptyDialog("Dialog 1");
      const dialogs = (snapshot.dialogs.length > 0 ? snapshot.dialogs : [fallbackDialog]).map(normalizeDialogTitleState);
      const activeDialogId = dialogs.some((dialog) => dialog.id === snapshot.activeDialogId) ? snapshot.activeDialogId : dialogs[0].id;
      return {
        settings: { ...state.settings, baseUrl: snapshot.settings.baseUrl, model: snapshot.settings.model },
        notes,
        notesFilePath: snapshot.notesPath ?? "",
        dialogs,
        activeDialogId,
        attachments: [],
        workspaceFiles: snapshot.workspaceFiles ?? [],
        lastAIReply: snapshot.lastAIReply,
        selectedPdfText: "",
        selectedPdfQuote: null,
        currentPageText: snapshot.pageTextCache[snapshot.currentPage] ?? "",
        currentPageTranslation: snapshot.pageTranslationCache[snapshot.currentPage] ?? "",
        pageTextCache: snapshot.pageTextCache,
        pageTranslationCache: snapshot.pageTranslationCache,
        pageTranslationStatus: snapshot.pageTranslationStatus,
        pageTranslationMetrics: snapshot.translationDocuments?.[snapshot.pdfPath]?.pageMetrics ?? {},
        translationDocuments: snapshot.translationDocuments ?? (snapshot.pdfPath ? { [snapshot.pdfPath]: {
          pdfPath: snapshot.pdfPath,
          pdfName: snapshot.pdfName,
          currentPage: snapshot.currentPage,
          pageTextCache: snapshot.pageTextCache,
          pageTranslationCache: snapshot.pageTranslationCache,
          pageTranslationStatus: snapshot.pageTranslationStatus,
          pageMetrics: {}
        } } : {}),
        pdfViewDocuments: snapshot.pdfViewDocuments ?? (snapshot.pdfPath ? { [snapshot.pdfPath]: { ...defaultPdfViewState, ...(snapshot.pdfViewState ?? {}) } } : {}),
        translationQueue: [],
        currentPage: snapshot.currentPage,
        totalPages: 0,
        pdfPath: snapshot.pdfPath,
        pdfName: snapshot.pdfName,
        projectPath,
        projectDirty: false,
        viewerMode: snapshot.viewerMode,
        pdfViewState: { ...defaultPdfViewState, ...(snapshot.pdfViewState ?? {}) },
        translationTask: defaultTranslationTaskState,
        apiQuotaInfo: null,
        pdfOpenRequest: {
          path: snapshot.pdfPath,
          preserveState: true,
          targetPage: snapshot.currentPage,
          requestId: (state.pdfOpenRequest?.requestId ?? 0) + 1
        }
      };
    }),
  resetWorkspace: (options) => {
    const dialog = options?.seedBeginner ? createBeginnerDialog(useAppStore.getState().settings.language) : createEmptyDialog("Dialog 1");
    set({
      notes: "",
      notesFilePath: "",
      dialogs: [dialog],
      activeDialogId: dialog.id,
      attachments: [],
      workspaceFiles: [],
      lastAIReply: "",
      selectedPdfText: "",
      selectedPdfQuote: null,
      currentPageText: "",
      currentPageTranslation: "",
      pageTextCache: {},
      pageTranslationCache: {},
      pageTranslationStatus: {},
      pageTranslationMetrics: {},
      translationDocuments: {},
      pdfViewDocuments: {},
      translationQueue: [],
      currentPage: 1,
      totalPages: 0,
      pdfPath: "",
      pdfName: "",
      projectPath: "",
      projectDirty: false,
      viewerMode: "single",
      pdfViewState: defaultPdfViewState,
      translationTask: defaultTranslationTaskState,
      apiQuotaInfo: null,
      pdfOpenRequest: null
    });
  }
}));

