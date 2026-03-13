import { create } from "zustand";
import {
  AgentAttachment,
  AgentDialog,
  ApiQuotaInfo,
  AppSettings,
  ChatMessage,
  PdfQuote,
  ProjectSnapshot,
  TranslationDocumentCache,
  TranslationStatus,
  ViewerMode,
  WorkspaceFileRef
} from "../types";

const NOTES_KEY = "pdfreader_notes";
const SETTINGS_KEY = "pdfreader_settings";

const createDialogId = () => `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createEmptyDialog = (title = "New dialog"): AgentDialog => {
  const now = Date.now();
  return {
    id: createDialogId(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
};

const defaultSettings: AppSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  language: "zh",
  accentColor: "#2563eb",
  themeMode: "light",
  showThinking: true,
  enableAgentAttachments: true,
  includeProjectContextInChat: true,
  hideCommandMessages: false,
  chatSystemPrompt: "",
  translationPrompt: "",
  glossary: ""
};

const loadNotes = () => localStorage.getItem(NOTES_KEY) ?? "";
const loadSettings = (): AppSettings => {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return defaultSettings;
  }
};

const inferDialogTitle = (messages: ChatMessage[], fallback: string) => {
  const userMessage = messages.find((item) => item.role === "user" && item.content.trim());
  if (!userMessage) return fallback;
  return userMessage.content.trim().slice(0, 24) || fallback;
};

const emptyTranslationDocument = (pdfPath = "", pdfName = ""): TranslationDocumentCache => ({
  pdfPath,
  pdfName,
  currentPage: 1,
  pageTextCache: {},
  pageTranslationCache: {},
  pageTranslationStatus: {}
});

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
  translationDocuments: Record<string, TranslationDocumentCache>;
  translationQueue: number[];
  currentPage: number;
  totalPages: number;
  pdfPath: string;
  pdfName: string;
  projectPath: string;
  projectDirty: boolean;
  viewerMode: ViewerMode;
  apiQuotaInfo: ApiQuotaInfo | null;
  pdfOpenRequest: { path: string; preserveState: boolean; targetPage?: number; requestId: number } | null;
  setSettings: (patch: Partial<AppSettings>) => void;
  setNotes: (value: string) => void;
  appendToNotes: (value: string) => void;
  setNotesFilePath: (value: string) => void;
  setDialogs: (value: AgentDialog[]) => void;
  createDialog: (title?: string) => string;
  deleteDialog: (id: string) => void;
  setActiveDialog: (id: string) => void;
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
  setTranslationQueue: (pages: number[]) => void;
  clearPageTextCache: () => void;
  clearPageTranslationCache: () => void;
  clearPageTranslationStatus: () => void;
  restoreTranslationCacheForPdf: (pdfPath: string, pdfName?: string) => void;
  clearAllTranslationDocuments: () => void;
  setCurrentPage: (value: number) => void;
  setTotalPages: (value: number) => void;
  setPdfPath: (value: string) => void;
  setPdfName: (value: string) => void;
  setProjectPath: (value: string) => void;
  setProjectDirty: (value: boolean) => void;
  setViewerMode: (value: ViewerMode) => void;
  setApiQuotaInfo: (value: ApiQuotaInfo | null) => void;
  requestPdfOpen: (path: string, options?: { preserveState?: boolean; targetPage?: number }) => void;
  clearPdfOpenRequest: () => void;
  hydrateProject: (snapshot: ProjectSnapshot, projectPath: string, notes: string) => void;
  resetWorkspace: () => void;
}

const initialDialog = createEmptyDialog("Dialog 1");

export const useAppStore = create<AppState>((set) => ({
  settings: loadSettings(),
  notes: loadNotes(),
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
  translationDocuments: {},
  translationQueue: [],
  currentPage: 1,
  totalPages: 0,
  pdfPath: "",
  pdfName: "",
  projectPath: "",
  projectDirty: false,
  viewerMode: "single",
  apiQuotaInfo: null,
  pdfOpenRequest: null,
  setSettings: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return { settings: next, projectDirty: true };
    }),
  setNotes: (value) =>
    set(() => {
      localStorage.setItem(NOTES_KEY, value);
      return { notes: value, projectDirty: true };
    }),
  appendToNotes: (value) =>
    set((state) => {
      const next = state.notes ? `${state.notes}\n\n${value}` : value;
      localStorage.setItem(NOTES_KEY, next);
      return { notes: next, projectDirty: true };
    }),
  setNotesFilePath: (value) => set({ notesFilePath: value, projectDirty: true }),
  setDialogs: (value) =>
    set(() => {
      const next = value.length > 0 ? value : [createEmptyDialog("Dialog 1")];
      return {
        dialogs: next,
        activeDialogId: next[0].id,
        projectDirty: true
      };
    }),
  createDialog: (title) => {
    const dialog = createEmptyDialog(title || `Dialog ${Date.now() % 100000}`);
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
  setActiveDialog: (id) => set({ activeDialogId: id }),
  addMessage: (message, dialogId) =>
    set((state) => {
      const targetId = dialogId ?? state.activeDialogId;
      return {
        dialogs: state.dialogs.map((dialog) =>
          dialog.id !== targetId
            ? dialog
            : {
                ...dialog,
                title: inferDialogTitle([...dialog.messages, message], dialog.title),
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
              pageTranslationStatus
            }
          }
        : state.translationDocuments;
      return { pageTranslationStatus, translationDocuments, projectDirty: true };
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
              pageTranslationStatus: state.pageTranslationStatus
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
              pageTranslationStatus: state.pageTranslationStatus
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
              pageTranslationStatus: {}
            }
          }
        : state.translationDocuments;
      return { pageTranslationStatus: {}, translationDocuments, projectDirty: true };
    }),
  restoreTranslationCacheForPdf: (pdfPath, pdfName) =>
    set((state) => {
      const documentCache = state.translationDocuments[pdfPath] ?? emptyTranslationDocument(pdfPath, pdfName ?? "");
      return {
        pageTextCache: documentCache.pageTextCache,
        pageTranslationCache: documentCache.pageTranslationCache,
        pageTranslationStatus: documentCache.pageTranslationStatus,
        currentPageText: documentCache.pageTextCache[documentCache.currentPage] ?? "",
        currentPageTranslation: documentCache.pageTranslationCache[documentCache.currentPage] ?? "",
        translationDocuments: {
          ...state.translationDocuments,
          [pdfPath]: {
            ...documentCache,
            pdfPath,
            pdfName: pdfName ?? documentCache.pdfName
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
              pageTranslationStatus: state.pageTranslationStatus
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
      const dialogs = snapshot.dialogs.length > 0 ? snapshot.dialogs : [fallbackDialog];
      const activeDialogId = dialogs.some((dialog) => dialog.id === snapshot.activeDialogId) ? snapshot.activeDialogId : dialogs[0].id;
      localStorage.setItem(NOTES_KEY, notes);
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
        translationDocuments: snapshot.translationDocuments ?? (snapshot.pdfPath ? { [snapshot.pdfPath]: {
          pdfPath: snapshot.pdfPath,
          pdfName: snapshot.pdfName,
          currentPage: snapshot.currentPage,
          pageTextCache: snapshot.pageTextCache,
          pageTranslationCache: snapshot.pageTranslationCache,
          pageTranslationStatus: snapshot.pageTranslationStatus
        } } : {}),
        translationQueue: [],
        currentPage: snapshot.currentPage,
        totalPages: 0,
        pdfPath: snapshot.pdfPath,
        pdfName: snapshot.pdfName,
        projectPath,
        projectDirty: false,
        viewerMode: snapshot.viewerMode,
        apiQuotaInfo: null,
        pdfOpenRequest: {
          path: snapshot.pdfPath,
          preserveState: true,
          targetPage: snapshot.currentPage,
          requestId: (state.pdfOpenRequest?.requestId ?? 0) + 1
        }
      };
    }),
  resetWorkspace: () => {
    const dialog = createEmptyDialog("Dialog 1");
    localStorage.setItem(NOTES_KEY, "");
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
      translationDocuments: {},
      translationQueue: [],
      currentPage: 1,
      totalPages: 0,
      pdfPath: "",
      pdfName: "",
      projectPath: "",
      projectDirty: false,
      viewerMode: "single",
      apiQuotaInfo: null,
      pdfOpenRequest: null
    });
  }
}));
