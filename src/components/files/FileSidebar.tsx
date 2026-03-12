import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/appStore";
import { WorkspaceFileRef } from "../../types";
import { nativeFileService } from "../../services/nativeFileService";
import { workspaceService } from "../../services/workspaceService";
import { t } from "../../i18n";

type TreeNode = {
  name: string;
  path: string;
  children: TreeNode[];
  file?: WorkspaceFileRef;
};

const sortFiles = (items: WorkspaceFileRef[]) =>
  [...items].sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));

const normalizeTreeFiles = (files: WorkspaceFileRef[], stripPrefix?: string) =>
  files.map((file) => ({
    ...file,
    relativePath: stripPrefix && file.relativePath.startsWith(stripPrefix) ? file.relativePath.slice(stripPrefix.length) : file.relativePath
  }));

const buildTree = (items: WorkspaceFileRef[]) => {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of sortFiles(items)) {
    const parts = file.relativePath.split(/[\\/]/).filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const joined = parts.slice(0, index + 1).join("/");
      let next = cursor.children.find((item) => item.name === part && item.path === joined);
      if (!next) {
        next = { name: part, path: joined, children: [] };
        cursor.children.push(next);
      }
      if (index === parts.length - 1) next.file = file;
      cursor = next;
    });
  }
  return root.children;
};

function TreeBranch({
  node,
  depth,
  onOpenFile,
  onRemoveFile,
  language
}: {
  node: TreeNode;
  depth: number;
  onOpenFile: (file: WorkspaceFileRef) => void;
  onRemoveFile: (file: WorkspaceFileRef) => void;
  language: "zh" | "en";
}) {
  const paddingLeft = `${depth * 0.9 + 0.75}rem`;

  if (node.file) {
    return (
      <div key={node.path} className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-panel px-2 py-2 shadow-sm" style={{ paddingLeft }}>
        <button
          type="button"
          className="min-w-0 flex-1 truncate border-0 p-0 text-left text-sm"
          style={{ background: "transparent" }}
          onClick={() => onOpenFile(node.file!)}
          title={node.file.relativePath}
        >
          {node.file.name}
        </button>
        {node.file.mounted && (
          <button type="button" className="border-0 p-0 text-xs text-slate-500" style={{ background: "transparent" }} onClick={() => onRemoveFile(node.file!)}>
            {t(language, "remove")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div key={node.path} className="mb-2">
      <div className="px-2 py-1 text-xs font-semibold tracking-[0.12em] text-slate-500" style={{ paddingLeft }}>
        {node.name}
      </div>
      {node.children.map((child) => (
        <TreeBranch key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} onRemoveFile={onRemoveFile} language={language} />
      ))}
    </div>
  );
}

function FileSection({
  title,
  files,
  onOpenFile,
  onRemoveFile,
  language,
  stripPrefix
}: {
  title: string;
  files: WorkspaceFileRef[];
  onOpenFile: (file: WorkspaceFileRef) => void;
  onRemoveFile: (file: WorkspaceFileRef) => void;
  language: "zh" | "en";
  stripPrefix?: string;
}) {
  const tree = useMemo(() => buildTree(normalizeTreeFiles(files, stripPrefix)), [files, stripPrefix]);
  if (files.length === 0) return null;

  return (
    <section className="mb-4">
      <div className="mb-2 inline-flex rounded-full border border-border px-2 py-1 text-[10px] font-semibold tracking-[0.14em] text-slate-500">{title}</div>
      {tree.map((node) => (
        <TreeBranch key={node.path} node={node} depth={0} onOpenFile={onOpenFile} onRemoveFile={onRemoveFile} language={language} />
      ))}
    </section>
  );
}

export function FileSidebar() {
  const projectPath = useAppStore((s) => s.projectPath);
  const workspaceFiles = useAppStore((s) => s.workspaceFiles);
  const addWorkspaceFiles = useAppStore((s) => s.addWorkspaceFiles);
  const setWorkspaceFiles = useAppStore((s) => s.setWorkspaceFiles);
  const removeWorkspaceFile = useAppStore((s) => s.removeWorkspaceFile);
  const requestPdfOpen = useAppStore((s) => s.requestPdfOpen);
  const currentPdfPath = useAppStore((s) => s.pdfPath);
  const setNotes = useAppStore((s) => s.setNotes);
  const setNotesFilePath = useAppStore((s) => s.setNotesFilePath);
  const language = useAppStore((s) => s.settings.language);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!projectPath) return;
      setBusy(true);
      try {
        const files = await workspaceService.listProjectFiles(
          projectPath,
          workspaceFiles.filter((item) => item.mounted).map((item) => item.path)
        );
        if (!cancelled) setWorkspaceFiles(files);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleAddFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Workspace Files", extensions: ["pdf", "md"] }]
    });
    if (!selected || !Array.isArray(selected)) return;
    const next = selected.map((path) => ({
      id: path,
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      relativePath: `mounted/${path.split(/[\\/]/).pop() ?? path}`,
      kind: path.toLowerCase().endsWith(".pdf") ? ("pdf" as const) : ("md" as const),
      mounted: true
    }));
    addWorkspaceFiles(next);
    if (projectPath) {
      const files = await workspaceService.listProjectFiles(projectPath, [...workspaceFiles.filter((item) => item.mounted).map((item) => item.path), ...selected]);
      setWorkspaceFiles(files);
    }
  };

  useEffect(() => {
    const onOpenDialog = () => {
      void handleAddFiles();
    };
    window.addEventListener("app:add-workspace-files", onOpenDialog as EventListener);
    return () => window.removeEventListener("app:add-workspace-files", onOpenDialog as EventListener);
  }, [projectPath, workspaceFiles]);

  const handleOpenFile = async (file: WorkspaceFileRef) => {
    if (file.kind === "pdf") {
      requestPdfOpen(file.path, { preserveState: file.path === currentPdfPath });
      return;
    }
    const content = await nativeFileService.readTextFile(file.path);
    setNotes(content);
    setNotesFilePath(file.path);
  };

  const projectFiles = workspaceFiles.filter((item) => !item.mounted);
  const mountedFiles = workspaceFiles.filter((item) => item.mounted);
  const projectPdfFiles = projectFiles.filter((item) => item.kind === "pdf");
  const projectMdFiles = projectFiles.filter((item) => item.kind === "md");
  const mountedPdfFiles = mountedFiles.filter((item) => item.kind === "pdf");
  const mountedMdFiles = mountedFiles.filter((item) => item.kind === "md");

  return (
    <section className="app-panel flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-semibold">{t(language, "files")}</div>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => void handleAddFiles()} disabled={busy}>
          {t(language, "addFiles")}
        </button>
      </header>
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-slate-500">
        <span>{projectPath ? t(language, "projectFiles") : t(language, "saveProjectFirst")}</span>
        {busy && <span>{t(language, "refresh")}...</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {workspaceFiles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-3 text-sm text-slate-500">{t(language, "noFiles")}</div>
        ) : (
          <>
            <FileSection title={t(language, "pdfFiles")} files={projectPdfFiles} onOpenFile={handleOpenFile} onRemoveFile={(file) => removeWorkspaceFile(file.path)} language={language} />
            <FileSection title={t(language, "markdownFiles")} files={projectMdFiles} onOpenFile={handleOpenFile} onRemoveFile={(file) => removeWorkspaceFile(file.path)} language={language} />
            {mountedFiles.length > 0 && (
              <>
                <FileSection title={`${t(language, "mounted")} / ${t(language, "pdfFiles")}`} files={mountedPdfFiles} onOpenFile={handleOpenFile} onRemoveFile={(file) => removeWorkspaceFile(file.path)} language={language} stripPrefix="mounted/" />
                <FileSection title={`${t(language, "mounted")} / ${t(language, "markdownFiles")}`} files={mountedMdFiles} onOpenFile={handleOpenFile} onRemoveFile={(file) => removeWorkspaceFile(file.path)} language={language} stripPrefix="mounted/" />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
