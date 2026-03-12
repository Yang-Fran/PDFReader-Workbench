import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { llmService } from "../../services/llmService";
import { projectService } from "../../services/projectService";
import { workspaceService } from "../../services/workspaceService";
import { useAppStore } from "../../stores/appStore";
import { CacheSummary } from "../../types";
import { t } from "../../i18n";

const ACCENT_PRESETS = [
  { label: "Blue", value: "#2563eb" },
  { label: "Teal", value: "#0f766e" },
  { label: "Amber", value: "#d97706" },
  { label: "Rose", value: "#e11d48" }
];

const API_PRESETS = [
  { label: "LMStudio", baseUrl: "http://127.0.0.1:1234", model: "qwen/qwen3.5-9b", apiKeyUrl: "" },
  { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1/", model: "", apiKeyUrl: "" },
  { label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "Pro/zai-org/GLM-4.7", apiKeyUrl: "https://cloud.siliconflow.cn/me/account/ak" },
  { label: "Zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-5", apiKeyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" },
  { label: "ModelScope", baseUrl: "https://api-inference.modelscope.cn/v1", model: "Qwen/Qwen3.5-27B", apiKeyUrl: "https://modelscope.cn/my/access/token" },
  { label: "Spark", baseUrl: "https://spark-api-open.xf-yun.com/x2/chat/completions", model: "spark-x", apiKeyUrl: "https://xinghuo.xfyun.cn/sparkapi?scr=price" }
];

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export function SettingsPanel() {
  const settings = useAppStore((state) => state.settings);
  const projectPath = useAppStore((state) => state.projectPath);
  const setSettings = useAppStore((state) => state.setSettings);
  const language = useAppStore((state) => state.settings.language);
  const [open, setOpen] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [cacheSummary, setCacheSummary] = useState<CacheSummary | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

  const refreshCacheSummary = async () => {
    if (!projectPath) {
      setCacheSummary(null);
      return;
    }
    setCacheBusy(true);
    try {
      setCacheSummary(await workspaceService.getCacheSummary(projectPath));
    } finally {
      setCacheBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    void refreshCacheSummary();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, projectPath]);

  useEffect(() => {
    if (!open) return;
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string }>).detail;
      if (detail?.target === "cache") {
        void refreshCacheSummary();
      }
    };
    window.addEventListener("agent:refresh", onRefresh as EventListener);
    return () => window.removeEventListener("agent:refresh", onRefresh as EventListener);
  }, [open, projectPath]);

  const modal = useMemo(() => {
    if (!open) return null;

    const runConnectionTest = async () => {
      setTestBusy(true);
      setTestMessage("");
      try {
        const reply = await llmService.testConnection();
        setTestMessage(`${t(language, "connectionOk")}: ${reply.slice(0, 80) || "OK"}`);
      } catch (error) {
        setTestMessage(`${t(language, "connectionFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setTestBusy(false);
      }
    };

    const openLink = async (url: string) => {
      try {
        await invoke("open_external_url", { url });
      } catch (error) {
        setTestMessage(`Open link failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const clearCache = async (kind: "translation" | "llm") => {
      if (!projectPath) return;
      setCacheBusy(true);
      try {
        await workspaceService.clearCache(projectPath, kind);
        await projectService.saveProject(false);
        await refreshCacheSummary();
      } finally {
        setCacheBusy(false);
      }
    };

    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4" onClick={() => setOpen(false)}>
        <div className="settings-modal relative max-h-[calc(100vh-2rem)] w-full max-w-6xl overflow-auto rounded-[28px] border border-white/20 p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="text-xl font-semibold">{t(language, "settings")}</div>
              <div className="mt-1 text-sm text-slate-500">{t(language, "manageSettingsHint")}</div>
            </div>
            <button className="rounded-full border border-border px-3 py-1 text-sm text-slate-600" onClick={() => setOpen(false)}>
              {t(language, "close")}
            </button>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            <section className="space-y-5">
              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{t(language, "apiPresets")}</div>
                    <div className="text-xs text-slate-500">{t(language, "presetHint")}</div>
                  </div>
                  <button className="accent-button rounded-xl border px-3 py-1.5 text-xs" onClick={() => void runConnectionTest()} disabled={testBusy}>
                    {testBusy ? t(language, "testing") : t(language, "testConnection")}
                  </button>
                </div>
                {testMessage && <div className="mb-3 rounded-2xl border border-border bg-white/75 px-3 py-2 text-xs text-slate-600">{testMessage}</div>}
                <div className="grid gap-3 md:grid-cols-2">
                  {API_PRESETS.map((preset) => (
                    <div key={preset.label} className="rounded-2xl border border-border bg-white/75 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold">{preset.label}</div>
                        <button className="rounded-xl border border-border px-3 py-1 text-xs" onClick={() => setSettings({ baseUrl: preset.baseUrl, model: preset.model || settings.model })}>
                          {t(language, "apply")}
                        </button>
                      </div>
                      <div className="mt-2 break-all text-xs text-slate-500">{preset.baseUrl}</div>
                      <div className="mt-1 text-xs text-slate-500">{preset.model ? `${t(language, "model")}: ${preset.model}` : t(language, "useRuntimeDefaultModel")}</div>
                      {preset.apiKeyUrl ? (
                        <button className="mt-2 inline-block border-0 bg-transparent p-0 text-left text-xs text-sky-600 underline" onClick={() => void openLink(preset.apiKeyUrl)}>
                          {t(language, "getApiKey")}
                        </button>
                      ) : (
                        <div className="mt-2 text-xs text-slate-400">{t(language, "noApiKeyPortal")}</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 text-sm font-semibold">{t(language, "prompts")}</div>
                <div className="mb-3 rounded-2xl border border-border bg-white/75 px-3 py-2 text-xs text-slate-600">
                  <div className="font-semibold">{t(language, "promptBehaviorTitle")}</div>
                  <div className="mt-1">{t(language, "promptBehaviorBody")}</div>
                </div>
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "chatSystemPrompt")}
                    <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.chatSystemPrompt} onChange={(event) => setSettings({ chatSystemPrompt: event.target.value })} />
                  </label>
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "translationPrompt")}
                    <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.translationPrompt} onChange={(event) => setSettings({ translationPrompt: event.target.value })} />
                  </label>
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "glossary")}
                    <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border px-3 py-2 text-sm" placeholder={t(language, "glossaryPlaceholder")} value={settings.glossary} onChange={(event) => setSettings({ glossary: event.target.value })} />
                  </label>
                </div>
              </section>

              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-semibold">{t(language, "cache")}</div>
                  <button className="rounded-xl border border-border px-3 py-1 text-xs" onClick={() => void refreshCacheSummary()} disabled={cacheBusy || !projectPath}>
                    {t(language, "refresh")}
                  </button>
                </div>
                {!projectPath ? (
                  <div className="text-sm text-slate-500">{t(language, "saveProjectFirst")}</div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border bg-white/75 p-3">
                      <div className="text-sm font-semibold">translation_cache</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {cacheSummary ? `${cacheSummary.translationCacheFiles} files / ${formatBytes(cacheSummary.translationCacheBytes)}` : "No data"}
                      </div>
                      {cacheSummary && cacheSummary.translationFiles.length > 0 && (
                        <div className="mt-3 rounded-xl border border-border bg-panel/60 p-2">
                          <div className="space-y-1">
                            {cacheSummary.translationFiles.map((file) => (
                              <div key={file.name} className="flex items-center justify-between gap-3 text-xs">
                                <span className="min-w-0 truncate text-slate-700" title={file.name}>
                                  {file.name}
                                </span>
                                <span className="shrink-0 text-slate-500">{formatBytes(file.bytes)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <button className="mt-3 rounded-xl border border-border px-3 py-1 text-xs" onClick={() => void clearCache("translation")} disabled={cacheBusy}>
                        {t(language, "clear")}
                      </button>
                    </div>
                    <div className="rounded-2xl border border-border bg-white/75 p-3">
                      <div className="text-sm font-semibold">llm_cache</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {cacheSummary ? `${cacheSummary.llmCacheFiles} files / ${formatBytes(cacheSummary.llmCacheBytes)}` : "No data"}
                      </div>
                      {cacheSummary && cacheSummary.llmFiles.length > 0 && (
                        <div className="mt-3 rounded-xl border border-border bg-panel/60 p-2">
                          <div className="space-y-1">
                            {cacheSummary.llmFiles.map((file) => (
                              <div key={file.name} className="flex items-center justify-between gap-3 text-xs">
                                <span className="min-w-0 truncate text-slate-700" title={file.name}>
                                  {file.name}
                                </span>
                                <span className="shrink-0 text-slate-500">{formatBytes(file.bytes)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <button className="mt-3 rounded-xl border border-border px-3 py-1 text-xs" onClick={() => void clearCache("llm")} disabled={cacheBusy}>
                        {t(language, "clear")}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </section>

            <section className="space-y-5">
              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 text-sm font-semibold">{t(language, "llmSettings")}</div>
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "baseUrl")}
                    <input className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.baseUrl} onChange={(event) => setSettings({ baseUrl: event.target.value })} />
                  </label>
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "apiKey")}
                    <input type="password" className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.apiKey} onChange={(event) => setSettings({ apiKey: event.target.value })} />
                  </label>
                  <label className="block text-xs font-medium text-slate-600">
                    {t(language, "model")}
                    <input className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.model} onChange={(event) => setSettings({ model: event.target.value })} />
                  </label>
                </div>
                <div
                  className="mt-3 rounded-xl border px-3 py-2 text-sm font-semibold"
                  style={{
                    color: "#dc2626",
                    borderColor: "rgba(220,38,38,0.55)",
                    backgroundColor: settings.themeMode === "light" ? "rgba(254,226,226,0.92)" : "rgba(127,29,29,0.48)"
                  }}
                >
                  对话和翻译会调用API，可能会产生费用，请自行注意额度！
                </div>
              </section>

              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 text-sm font-semibold">{t(language, "agentSettings")}</div>
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.showThinking} onChange={(event) => setSettings({ showThinking: event.target.checked })} />
                  {t(language, "showReasoning")}
                </label>
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.enableAgentAttachments} onChange={(event) => setSettings({ enableAgentAttachments: event.target.checked })} />
                  {t(language, "enableAttachments")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.includeProjectContextInChat} onChange={(event) => setSettings({ includeProjectContextInChat: event.target.checked })} />
                  {t(language, "includeProjectContext")}
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-600">
                  {t(language, "language")}
                  <select className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm" value={settings.language} onChange={(event) => setSettings({ language: event.target.value as "zh" | "en" })}>
                    <option value="zh">{t(language, "chinese")}</option>
                    <option value="en">{t(language, "english")}</option>
                  </select>
                </label>
              </section>

              <section className="rounded-3xl border border-border bg-panel p-4">
                <div className="mb-3 text-sm font-semibold">{t(language, "theme")}</div>
                <div className="mb-4 flex gap-2">
                  <button className={`rounded-xl border px-3 py-2 text-sm ${settings.themeMode === "light" ? "theme-active" : ""}`} onClick={() => setSettings({ themeMode: "light" })}>
                    {t(language, "light")}
                  </button>
                  <button className={`rounded-xl border px-3 py-2 text-sm ${settings.themeMode === "dark" ? "theme-active" : ""}`} onClick={() => setSettings({ themeMode: "dark" })}>
                    {t(language, "dark")}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {ACCENT_PRESETS.map((preset) => {
                    const active = settings.accentColor === preset.value;
                    return (
                      <button key={preset.value} className={`rounded-2xl border px-3 py-3 text-left transition ${active ? "theme-active shadow-sm" : ""}`} onClick={() => setSettings({ accentColor: preset.value })}>
                        <div className="mb-2 h-10 rounded-xl" style={{ background: preset.value }} />
                        <div className="text-sm font-medium">{preset.label}</div>
                      </button>
                    );
                  })}
                </div>
              </section>
            </section>
          </div>
        </div>
      </div>
    );
  }, [cacheBusy, cacheSummary, language, open, projectPath, setSettings, settings, testBusy, testMessage]);

  return (
    <>
      <button className="rounded border border-border bg-white px-3 py-1 text-sm" onClick={() => setOpen(true)}>
        {t(language, "settings")}
      </button>
      {modal ? createPortal(modal, document.body) : null}
    </>
  );
}
