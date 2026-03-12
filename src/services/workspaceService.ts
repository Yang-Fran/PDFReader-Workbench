import { invoke } from "@tauri-apps/api/core";
import { CacheSummary, WorkspaceFileRef } from "../types";
import { useAppStore } from "../stores/appStore";

interface SyncCacheFile {
  name: string;
  content: string;
}

export const PROJECT_STATE_CACHE_FILE = "project-state.json";

const hashKey = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
};

const sanitizeFileStem = (value: string) =>
  value
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "pdf";

export const buildPdfCacheFileName = (pdfPath: string, pdfName?: string) => {
  const stem = sanitizeFileStem(pdfName || pdfPath.split(/[\\/]/).pop() || "pdf");
  return `pdf-${stem}-${hashKey(pdfPath)}.json`;
};

export const getProjectDirFromPath = (projectPath: string) => {
  const normalized = projectPath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
};

export const getProjectCacheFilePath = (projectPath: string, kind: "translation" | "llm", fileName: string) =>
  `${getProjectDirFromPath(projectPath)}/${kind === "translation" ? "translation_cache" : "llm_cache"}/${fileName}`;

const hasTranslationCacheContent = () => {
  const state = useAppStore.getState();
  return Object.values(state.translationDocuments).some(
    (document) =>
      Object.keys(document.pageTextCache).length > 0 ||
      Object.keys(document.pageTranslationCache).length > 0 ||
      Object.keys(document.pageTranslationStatus).length > 0
  );
};

const hasLlmCacheContent = () => {
  const state = useAppStore.getState();
  return state.dialogs.some((dialog) => dialog.messages.length > 0) || !!state.lastAIReply;
};

const buildTranslationCacheFiles = () => {
  const state = useAppStore.getState();
  if (!hasTranslationCacheContent()) return [] as SyncCacheFile[];

  return Object.values(state.translationDocuments)
    .filter(
      (document) =>
        !!document.pdfPath &&
        (Object.keys(document.pageTextCache).length > 0 ||
          Object.keys(document.pageTranslationCache).length > 0 ||
          Object.keys(document.pageTranslationStatus).length > 0)
    )
    .map((document) => ({
      name: buildPdfCacheFileName(document.pdfPath, document.pdfName),
      content: JSON.stringify(
        {
          pdfPath: document.pdfPath,
          pdfName: document.pdfName,
          savedAt: new Date().toISOString(),
          currentPage: document.currentPage,
          pageTextCache: document.pageTextCache,
          pageTranslationCache: document.pageTranslationCache,
          pageTranslationStatus: document.pageTranslationStatus
        },
        null,
        2
      )
    }));
};

const buildLlmCacheFiles = () => {
  const state = useAppStore.getState();
  if (!hasLlmCacheContent()) return [] as SyncCacheFile[];

  const dialogFiles = state.dialogs
    .filter((dialog) => dialog.messages.length > 0)
    .map((dialog) => ({
      name: `dialog-${dialog.id}.json`,
      content: JSON.stringify(dialog, null, 2)
    }));

  return [
    {
      name: PROJECT_STATE_CACHE_FILE,
      content: JSON.stringify(
        {
          activeDialogId: state.activeDialogId,
          lastAIReply: state.lastAIReply,
          dialogIds: dialogFiles.map((file) => file.name.replace(/^dialog-/, "").replace(/\.json$/, ""))
        },
        null,
        2
      )
    },
    ...dialogFiles
  ];
};

export const workspaceService = {
  async listProjectFiles(projectPath: string, mountedPaths: string[]): Promise<WorkspaceFileRef[]> {
    if (!projectPath) return [];
    return invoke<WorkspaceFileRef[]>("list_project_library", {
      projectPath,
      mountedPaths
    });
  },

  async syncProjectCaches(projectPath: string) {
    if (!projectPath) return;
    await invoke("sync_project_cache", {
      projectPath,
      kind: "translation",
      files: buildTranslationCacheFiles()
    });
    await invoke("sync_project_cache", {
      projectPath,
      kind: "llm",
      files: buildLlmCacheFiles()
    });
  },

  async getCacheSummary(projectPath: string): Promise<CacheSummary | null> {
    if (!projectPath) return null;
    return invoke<CacheSummary>("get_project_cache_summary", { projectPath });
  },

  async clearCache(projectPath: string, kind: "translation" | "llm"): Promise<CacheSummary | null> {
    if (!projectPath) return null;
    const summary = await invoke<CacheSummary>("clear_project_cache", { projectPath, kind });
    const state = useAppStore.getState();

    if (kind === "translation") {
      state.clearAllTranslationDocuments();
      state.setTranslationQueue([]);
      window.dispatchEvent(new CustomEvent("agent:refresh", { detail: { target: "pdf" } }));
    } else {
      state.setDialogs([]);
      state.setAttachments([]);
      state.setLastAIReply("");
      window.dispatchEvent(new CustomEvent("agent:refresh", { detail: { target: "agent" } }));
    }

    window.dispatchEvent(new CustomEvent("agent:refresh", { detail: { target: "cache" } }));
    return summary;
  }
};
