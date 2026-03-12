import { Suspense, lazy, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { t } from "./i18n";
import { projectService } from "./services/projectService";
import { useAppStore } from "./stores/appStore";

const FileSidebar = lazy(() => import("./components/files/FileSidebar").then((module) => ({ default: module.FileSidebar })));
const PdfPane = lazy(() => import("./components/pdf/PdfPane").then((module) => ({ default: module.PdfPane })));
const NotesPane = lazy(() => import("./components/notes/NotesPane").then((module) => ({ default: module.NotesPane })));
const AgentPane = lazy(() => import("./components/agent/AgentPane").then((module) => ({ default: module.AgentPane })));
const SettingsPanel = lazy(() => import("./components/settings/SettingsPanel").then((module) => ({ default: module.SettingsPanel })));

const getProjectLabel = (projectPath: string, language: "zh" | "en") => {
  if (!projectPath) return t(language, "noProject");
  const parts = projectPath.split(/[\\/]/);
  return parts[parts.length - 1] || "workspace.pdfwb";
};

function App() {
  const [busy, setBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusError, setStatusError] = useState(false);
  const projectPath = useAppStore((s) => s.projectPath);
  const projectDirty = useAppStore((s) => s.projectDirty);
  const accentColor = useAppStore((s) => s.settings.accentColor);
  const themeMode = useAppStore((s) => s.settings.themeMode);
  const language = useAppStore((s) => s.settings.language);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    root.style.setProperty("--accent-color", accentColor);
    root.style.setProperty("--accent-soft", `${accentColor}1a`);
  }, [accentColor, themeMode]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const startupProjectPath = await invoke<string | null>("get_startup_project_path");
        if (!startupProjectPath || disposed) return;
        setBusy(true);
        await projectService.openProjectAtPath(startupProjectPath);
        if (disposed) return;
        setStatusError(false);
        setStatusMessage(t(language, "loadOk"));
      } catch (error) {
        if (disposed) return;
        setStatusError(true);
        setStatusMessage(`${t(language, "loadError")}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (!disposed) setBusy(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const runProjectAction = async (action: () => Promise<boolean>) => {
    setBusy(true);
    try {
      const ok = await action();
      setStatusError(false);
      setStatusMessage(ok ? t(language, "loadOk") : "");
    } catch (error) {
      setStatusError(true);
      setStatusMessage(`${t(language, "loadError")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleFiles = async () => {
    if (showFiles && projectPath) {
      await projectService.saveWorkspaceArtifacts();
    }
    setShowFiles((value) => !value);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!busy) void runProjectAction(() => projectService.saveProject(false));
      }
    };
    const onShowFiles = () => setShowFiles(true);
    const onAddWorkspaceFiles = () => {
      setShowFiles(true);
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("app:add-workspace-files"));
      });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("agent:show-files", onShowFiles as EventListener);
    window.addEventListener("agent:add-workspace-files", onAddWorkspaceFiles as EventListener);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("agent:show-files", onShowFiles as EventListener);
      window.removeEventListener("agent:add-workspace-files", onAddWorkspaceFiles as EventListener);
    };
  }, [busy]);

  return (
    <main className="app-shell flex h-screen flex-col gap-2 overflow-hidden p-2">
      <header className="app-surface flex items-center justify-between rounded border border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">PDF Reader Workbench</div>
          <div className="truncate text-xs text-slate-500">
            {getProjectLabel(projectPath, language)}
            {projectDirty ? ` * ${t(language, "unsaved")}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded border border-border bg-white px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void runProjectAction(() => projectService.newProject())}
            disabled={busy}
          >
            {t(language, "newProject")}
          </button>
          <button
            className="rounded border border-border bg-white px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void runProjectAction(() => projectService.openProject())}
            disabled={busy}
          >
            {t(language, "openProject")}
          </button>
          <button
            className="rounded border border-border bg-white px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void runProjectAction(() => projectService.saveProject(false))}
            disabled={busy}
          >
            {t(language, "saveProject")}
          </button>
          <button
            className="rounded border border-border bg-white px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void runProjectAction(() => projectService.saveProject(true))}
            disabled={busy}
          >
            {t(language, "saveProjectAs")}
          </button>
          <Suspense fallback={<div className="rounded border border-border bg-white px-3 py-1 text-sm text-slate-500">{t(language, "loadingSettings")}</div>}>
            <SettingsPanel />
          </Suspense>
        </div>
      </header>
      {statusMessage && (
        <div className={`rounded border px-3 py-2 text-sm ${statusError ? "border-rose-300 bg-rose-50 text-rose-700" : "border-border bg-white/70 text-slate-600"}`}>
          {statusMessage}
        </div>
      )}

      <div className="app-surface min-h-0 flex-1 rounded border border-border p-1">
        <div className="flex h-full">
          <button
            type="button"
            className="mr-1 flex w-7 shrink-0 items-center justify-center rounded border border-border bg-white/80 text-lg font-semibold"
            onClick={() => void toggleFiles()}
            title={t(language, "files")}
          >
            {showFiles ? "<" : ">"}
          </button>
          {showFiles && (
            <div className="h-full w-[300px] shrink-0 pr-1">
              <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingFiles")}</div>}>
                <FileSidebar />
              </Suspense>
            </div>
          )}
          <PanelGroup direction="horizontal" className="h-full min-w-0 flex-1">
            <Panel defaultSize={42} minSize={25}>
              <div className="h-full pr-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingPdfPane")}</div>}>
                  <PdfPane />
                </Suspense>
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-x" />
            <Panel defaultSize={32} minSize={22}>
              <div className="h-full px-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingNotes")}</div>}>
                  <NotesPane />
                </Suspense>
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-x" />
            <Panel defaultSize={26} minSize={18}>
              <div className="h-full pl-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingAgent")}</div>}>
                  <AgentPane />
                </Suspense>
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </main>
  );
}

export default App;
