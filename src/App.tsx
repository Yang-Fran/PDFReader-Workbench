import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ToastViewport } from "./components/common/ToastViewport";
import { FileSidebar } from "./components/files/FileSidebar";
import { t } from "./i18n";
import { projectService } from "./services/projectService";
import { useToastStore } from "./stores/toastStore";
import { formatUiError, repairMojibake } from "./utils/textDisplay";
import { useAppStore } from "./stores/appStore";

const PdfPane = lazy(() => import("./components/pdf/PdfPane").then((module) => ({ default: module.PdfPane })));
const NotesPane = lazy(() => import("./components/notes/NotesPane").then((module) => ({ default: module.NotesPane })));
const AgentPane = lazy(() => import("./components/agent/AgentPane").then((module) => ({ default: module.AgentPane })));
const SettingsPanel = lazy(() => import("./components/settings/SettingsPanel").then((module) => ({ default: module.SettingsPanel })));

const getProjectLabel = (projectPath: string, language: "zh" | "en") => {
  if (!projectPath) return t(language, "noProject");
  const parts = projectPath.split(/[\\/]/);
  return parts[parts.length - 1] || "workspace.pdfwb";
};

const SidebarToggleIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    {open ? (
      <path d="M12.8 5.6L7.8 10L12.8 14.4V5.6Z" fill="currentColor" />
    ) : (
      <path d="M7.2 5.6L12.2 10L7.2 14.4V5.6Z" fill="currentColor" />
    )}
  </svg>
);

const NewProjectIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5.25 4.75H10.9L14.75 8.6V15.25H5.25V4.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M10.75 4.9V8.75H14.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M10 10.5V13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M8.35 12.15H11.65" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const OpenProjectIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M3.75 6.25H8.25L9.7 7.9H16.25V14.5H3.75V6.25Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6.4 10L8.85 12.45L13.6 7.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SaveProjectIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M4.75 4.75H13.7L15.25 6.3V15.25H4.75V4.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7 4.9V8.4H12.75V4.9" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7.1 15.1V11.35H12.9V15.1" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

const ExportPdfIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5.25 4.75H10.9L14.75 8.6V15.25H5.25V4.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M10.75 4.9V8.75H14.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M10 9.75V13.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M8.35 11.7L10 13.35L11.65 11.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SettingsIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="M8.15 4.2H11.85L12.35 6L14 6.95L15.7 6.45L17.2 9.05L15.95 10.3L15.95 11.7L17.2 12.95L15.7 15.55L14 15.05L12.35 16L11.85 17.8H8.15L7.65 16L6 15.05L4.3 15.55L2.8 12.95L4.05 11.7V10.3L2.8 9.05L4.3 6.45L6 6.95L7.65 6L8.15 4.2Z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
    <circle cx="10" cy="11" r="2.35" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const RailButton = ({
  icon,
  label,
  active = false,
  disabled = false,
  onClick
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={`app-rail-button ${active ? "app-rail-button--active" : ""}`}
    title={label}
    aria-label={label}
    aria-pressed={active || undefined}
    disabled={disabled}
    onClick={onClick}
  >
    <span className="app-rail-button__icon">{icon}</span>
    <span className="app-rail-button__label">{label}</span>
  </button>
);

function App() {
  const [busy, setBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const projectPath = useAppStore((s) => s.projectPath);
  const projectDirty = useAppStore((s) => s.projectDirty);
  const accentColor = useAppStore((s) => s.settings.accentColor);
  const themeMode = useAppStore((s) => s.settings.themeMode);
  const language = useAppStore((s) => s.settings.language);
  const pushToast = useToastStore((s) => s.pushToast);
  const projectLabel = getProjectLabel(projectPath, language);

  const seedBeginnerWorkspaceIfPristine = () => {
    const state = useAppStore.getState();
    const activeDialog = state.dialogs.find((dialog) => dialog.id === state.activeDialogId) ?? state.dialogs[0];
    const isPristineWorkspace =
      !state.projectPath &&
      !state.pdfPath &&
      !state.notes.trim() &&
      state.workspaceFiles.length === 0 &&
      state.attachments.length === 0 &&
      state.dialogs.length === 1 &&
      (activeDialog?.messages.length ?? 0) === 0;

    if (isPristineWorkspace) {
      state.resetWorkspace({ seedBeginner: true });
    }
  };

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
        if (disposed) return;
        if (!startupProjectPath) {
          seedBeginnerWorkspaceIfPristine();
          return;
        }
        setBusy(true);
        await projectService.openProjectAtPath(startupProjectPath);
        if (disposed) return;
        pushToast(repairMojibake(t(language, "loadOk")), "success");
      } catch (error) {
        if (disposed) return;
        seedBeginnerWorkspaceIfPristine();
        pushToast(formatUiError(error, language), "error");
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
      if (ok) {
        pushToast(repairMojibake(t(language, "loadOk")), "success");
      }
    } catch (error) {
      pushToast(formatUiError(error, language), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleFiles = () => setShowFiles((value) => !value);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.ctrlKey || event.metaKey;
      if (isModifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!busy) void runProjectAction(() => projectService.saveProject(event.shiftKey));
      }
      if (isModifier && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!busy) void runProjectAction(() => projectService.openProject());
      }
      if (isModifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!busy) void runProjectAction(() => projectService.newProject());
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
    <main className="app-shell flex h-screen gap-2 overflow-hidden p-2">
      <aside className="app-rail app-surface flex w-[92px] shrink-0 flex-col rounded border border-border p-2">
        <div className="app-rail-brand mb-2">
          <span className="app-rail-brand__mark">P</span>
        </div>
        <div className="app-rail-actions">
          <RailButton icon={<SidebarToggleIcon open={showFiles} />} label={t(language, "files")} active={showFiles} onClick={toggleFiles} />
          <RailButton icon={<NewProjectIcon />} label={t(language, "newProject")} disabled={busy} onClick={() => void runProjectAction(() => projectService.newProject())} />
          <RailButton icon={<OpenProjectIcon />} label={t(language, "openProject")} disabled={busy} onClick={() => void runProjectAction(() => projectService.openProject())} />
          <RailButton icon={<SaveProjectIcon />} label={t(language, "saveProject")} disabled={busy} onClick={() => void runProjectAction(() => projectService.saveProject(false))} />
          <RailButton icon={<ExportPdfIcon />} label={language === "en" ? "Export PDF" : "导出 PDF"} onClick={() => window.dispatchEvent(new CustomEvent("app:export-pdf"))} />
        </div>
        <div className="app-rail-spacer" />
        <RailButton icon={<SettingsIcon />} label={t(language, "settings")} onClick={() => window.dispatchEvent(new CustomEvent("app:open-settings"))} />
        <div className="app-rail-project mt-3" title={`${projectLabel}${projectDirty ? ` • ${t(language, "unsaved")}` : ""}`}>
          <div className="app-rail-project__name">{projectLabel}</div>
          <div className="app-rail-project__meta">{projectDirty ? t(language, "unsaved") : "2.4.0"}</div>
        </div>
      </aside>
      <div className="app-surface min-h-0 min-w-0 flex-1 rounded border border-border p-1">
        <div className="flex h-full">
          <div className={`app-files-dock shrink-0 ${showFiles ? "app-files-dock--open" : "app-files-dock--closed"}`} aria-hidden={!showFiles}>
            <div className="app-files-dock__inner">
              <FileSidebar />
            </div>
          </div>
          <PanelGroup direction="horizontal" className="h-full min-w-0 flex-1">
            <Panel defaultSize={42} minSize={25}>
              <div className="h-full min-w-0 pr-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingPdfPane")}</div>}>
                  <PdfPane />
                </Suspense>
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-x" />
            <Panel defaultSize={32} minSize={22}>
              <div className="h-full min-w-0 px-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingNotes")}</div>}>
                  <NotesPane />
                </Suspense>
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-x" />
            <Panel defaultSize={26} minSize={18}>
              <div className="h-full min-w-0 pl-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "loadingAgent")}</div>}>
                  <AgentPane />
                </Suspense>
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
      <Suspense fallback={null}>
        <SettingsPanel showTrigger={false} />
      </Suspense>
      <ToastViewport />
    </main>
  );
}

export default App;
