import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../stores/appStore";
import { ChatMessage, ProjectSnapshot } from "../types";
import { nativeFileService } from "./nativeFileService";
import { buildPdfCacheFileName, getProjectCacheFilePath, PROJECT_STATE_CACHE_FILE, workspaceService } from "./workspaceService";

export const PROJECT_EXTENSION = "pdfwb";

type LegacySnapshot = Omit<ProjectSnapshot, "version" | "dialogs" | "activeDialogId" | "workspaceFiles" | "translationCacheIndex" | "llmCacheIndex"> & {
  version: 1;
  messages: ChatMessage[];
};

type ProjectStateCache = {
  activeDialogId: string;
  lastAIReply: string;
  dialogIds: string[];
};

type TranslationCacheState = Pick<ProjectSnapshot, "pageTextCache" | "pageTranslationCache" | "pageTranslationStatus">;

const buildLegacyDialog = (messages: ChatMessage[]) => {
  const now = Date.now();
  return {
    id: `dialog-legacy-${now}`,
    title: "Imported dialog",
    createdAt: now,
    updatedAt: now,
    messages
  };
};

const buildSnapshot = (projectPath: string): ProjectSnapshot => {
  const state = useAppStore.getState();
  const notesPath = state.notesFilePath || projectPath.replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, "i"), ".md");
  const translationDocuments = Object.values(state.translationDocuments).filter((document) => !!document.pdfPath);

  return {
    version: 3,
    savedAt: new Date().toISOString(),
    pdfPath: state.pdfPath,
    pdfName: state.pdfName,
    notesPath,
    currentPage: state.currentPage,
    viewerMode: state.viewerMode,
    notes: "",
    dialogs: [],
    activeDialogId: "",
    lastAIReply: "",
    pageTextCache: {},
    pageTranslationCache: {},
    pageTranslationStatus: {},
    workspaceFiles: state.workspaceFiles,
    translationCacheIndex: translationDocuments
      .filter(
        (document) =>
          Object.keys(document.pageTextCache).length > 0 ||
          Object.keys(document.pageTranslationCache).length > 0 ||
          Object.keys(document.pageTranslationStatus).length > 0
      )
      .map((document) => buildPdfCacheFileName(document.pdfPath, document.pdfName)),
    llmCacheIndex: state.dialogs.some((dialog) => dialog.messages.length > 0) || !!state.lastAIReply ? [PROJECT_STATE_CACHE_FILE, ...state.dialogs.filter((dialog) => dialog.messages.length > 0).map((dialog) => `dialog-${dialog.id}.json`)] : [],
    projectStateCache: state.dialogs.some((dialog) => dialog.messages.length > 0) || !!state.lastAIReply ? PROJECT_STATE_CACHE_FILE : undefined,
    settings: {
      baseUrl: state.settings.baseUrl,
      model: state.settings.model
    }
  };
};

const validateSnapshot = (value: unknown): value is ProjectSnapshot | LegacySnapshot => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { version?: number; pdfPath?: unknown };
  return (snapshot.version === 1 || snapshot.version === 2 || snapshot.version === 3) && typeof snapshot.pdfPath === "string";
};

const normalizeSnapshot = (value: ProjectSnapshot | LegacySnapshot): ProjectSnapshot => {
  if ("dialogs" in value) return value;
  const dialog = buildLegacyDialog(value.messages);
  return {
    ...value,
    version: 2,
    dialogs: [dialog],
    activeDialogId: dialog.id,
    workspaceFiles: [],
    translationCacheIndex: [],
    llmCacheIndex: []
  };
};

const readTranslationCacheState = async (projectPath: string, snapshot: ProjectSnapshot) => {
  const translationDocuments: NonNullable<ProjectSnapshot["translationDocuments"]> = {};

  for (const fileName of snapshot.translationCacheIndex) {
    try {
      const raw = await nativeFileService.readTextFile(getProjectCacheFilePath(projectPath, "translation", fileName));
      const parsed = JSON.parse(raw) as Partial<TranslationCacheState> & { pdfPath?: string; pdfName?: string; currentPage?: number };
      if (!parsed.pdfPath) continue;
      translationDocuments[parsed.pdfPath] = {
        pdfPath: parsed.pdfPath,
        pdfName: parsed.pdfName ?? parsed.pdfPath.split(/[\\/]/).pop() ?? parsed.pdfPath,
        currentPage: parsed.currentPage ?? 1,
        pageTextCache: parsed.pageTextCache ?? {},
        pageTranslationCache: parsed.pageTranslationCache ?? {},
        pageTranslationStatus: parsed.pageTranslationStatus ?? {}
      };
    } catch {
      continue;
    }
  }

  const activeDocument = snapshot.pdfPath ? translationDocuments[snapshot.pdfPath] : undefined;
  return {
    translationDocuments,
    pageTextCache: activeDocument?.pageTextCache ?? {},
    pageTranslationCache: activeDocument?.pageTranslationCache ?? {},
    pageTranslationStatus: activeDocument?.pageTranslationStatus ?? {}
  };
};

const readLlmState = async (projectPath: string, snapshot: ProjectSnapshot) => {
  const stateFile = snapshot.projectStateCache || snapshot.llmCacheIndex.find((item) => item === PROJECT_STATE_CACHE_FILE);
  if (!stateFile) {
    return { dialogs: snapshot.dialogs ?? [], activeDialogId: snapshot.activeDialogId ?? "", lastAIReply: snapshot.lastAIReply ?? "" };
  }

  try {
    const stateRaw = await nativeFileService.readTextFile(getProjectCacheFilePath(projectPath, "llm", stateFile));
    const stateParsed = JSON.parse(stateRaw) as Partial<ProjectStateCache>;
    const dialogIds = stateParsed.dialogIds ?? [];
    const dialogs = (
      await Promise.all(
        dialogIds.map(async (dialogId) => {
          const raw = await nativeFileService.readTextFile(getProjectCacheFilePath(projectPath, "llm", `dialog-${dialogId}.json`));
          return JSON.parse(raw);
        })
      )
    ).filter(Boolean) as ProjectSnapshot["dialogs"];

    return {
      dialogs,
      activeDialogId: stateParsed.activeDialogId ?? dialogs[0]?.id ?? "",
      lastAIReply: stateParsed.lastAIReply ?? ""
    };
  } catch {
    return { dialogs: snapshot.dialogs ?? [], activeDialogId: snapshot.activeDialogId ?? "", lastAIReply: snapshot.lastAIReply ?? "" };
  }
};

export const projectService = {
  async newProject() {
    useAppStore.getState().resetWorkspace();
    return true;
  },

  async saveWorkspaceArtifacts(explicitProjectPath?: string) {
    const state = useAppStore.getState();
    const targetProjectPath = explicitProjectPath || state.projectPath;
    if (!targetProjectPath) return false;

    const notesPath = state.notesFilePath || targetProjectPath.replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, "i"), ".md");
    await nativeFileService.writeTextFile(notesPath, state.notes);
    useAppStore.getState().setNotesFilePath(notesPath);
    await workspaceService.syncProjectCaches(targetProjectPath);
    return true;
  },

  async saveProject(saveAs = false) {
    const state = useAppStore.getState();
    const defaultPath =
      state.projectPath || (state.pdfName ? `${state.pdfName.replace(/\.pdf$/i, "")}.${PROJECT_EXTENSION}` : `workspace.${PROJECT_EXTENSION}`);

    const path =
      saveAs || !state.projectPath
        ? await save({
            filters: [{ name: "PDF Reader Workbench Project", extensions: [PROJECT_EXTENSION] }],
            defaultPath
          })
        : state.projectPath;

    if (!path) return false;

    await this.saveWorkspaceArtifacts(path);
    const snapshot = buildSnapshot(path);
    await nativeFileService.writeTextFile(path, JSON.stringify(snapshot, null, 2));
    const store = useAppStore.getState();
    store.setProjectPath(path);
    store.setProjectDirty(false);
    return true;
  },

  async openProjectAtPath(path: string) {
    const raw = await nativeFileService.readTextFile(path);
    const parsed = JSON.parse(raw) as unknown;
    if (!validateSnapshot(parsed)) {
      throw new Error("Invalid project file.");
    }

    const snapshot = normalizeSnapshot(parsed);
    const notesPath = snapshot.notesPath || path.replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, "i"), ".md");
    let notes = snapshot.notes ?? "";
    try {
      notes = await nativeFileService.readTextFile(notesPath);
    } catch {
      notes = snapshot.notes ?? "";
    }

    const translationState = await readTranslationCacheState(path, snapshot);
    const llmState = await readLlmState(path, snapshot);

    useAppStore.getState().hydrateProject(
      {
        ...snapshot,
        dialogs: llmState.dialogs,
        activeDialogId: llmState.activeDialogId,
        lastAIReply: llmState.lastAIReply,
        translationDocuments: translationState.translationDocuments,
        pageTextCache: translationState.pageTextCache,
        pageTranslationCache: translationState.pageTranslationCache,
        pageTranslationStatus: translationState.pageTranslationStatus
      },
      path,
      notes
    );
    return true;
  },

  async openProject() {
    const path = await open({
      multiple: false,
      filters: [{ name: "PDF Reader Workbench Project", extensions: [PROJECT_EXTENSION] }]
    });
    if (!path || Array.isArray(path)) return false;
    return this.openProjectAtPath(path);
  }
};
