import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useBackdropClose } from "../../hooks/useBackdropClose";
import { useAutoClearMessage } from "../../hooks/useAutoClearMessage";
import { t } from "../../i18n";
import { llmService } from "../../services/llmService";
import { projectService } from "../../services/projectService";
import { workspaceService } from "../../services/workspaceService";
import { useAppStore } from "../../stores/appStore";
import type { CacheSummary, PdfExportHeaderFooter, PdfExportSlot, PdfExportSlotKind } from "../../types";
import { formatUiError, repairMojibake } from "../../utils/textDisplay";

const ACCENT_PRESETS = [
  { value: "#d97706", zh: "\u7425\u73c0", en: "Amber" },
  { value: "#FFD666", zh: "\u6a59\u9ec4", en: "Orange Yellow" },
  { value: "#73D13D", zh: "\u8349\u7eff", en: "Grass Green" },
  { value: "#0f766e", zh: "\u6e05\u7eff", en: "Teal" },
  { value: "#0FB4B4", zh: "\u975b\u9752", en: "Indigo" },
  { value: "#2563eb", zh: "\u6df1\u84dd", en: "Deep Blue" },
  { value: "#7c3aed", zh: "\u7d2b\u6676", en: "Violet" },
  { value: "#EC58A9", zh: "\u6d45\u7c89", en: "Soft Pink" }
];

const API_PRESETS = [
  { label: "LMStudio", baseUrl: "http://127.0.0.1:1234", model: "qwen/qwen3.5-9b", apiKeyUrl: "" },
  { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "", apiKeyUrl: "" },
  { label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen3.5-4B", apiKeyUrl: "https://cloud.siliconflow.cn/me/account/ak" },
  { label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "GLM-4.7-Flash", apiKeyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" }
];

type SettingsSectionId = "llm" | "prompts" | "pdfExport" | "appearance" | "agent" | "cache" | "language";

const PDF_SLOT_OPTIONS: Array<{ kind: PdfExportSlotKind; zh: string; en: string }> = [
  { kind: "none", zh: "无", en: "None" },
  { kind: "title", zh: "标题", en: "Title" },
  { kind: "date", zh: "日期", en: "Date" },
  { kind: "pageNumber", zh: "页码", en: "Page" },
  { kind: "pageNumberTotal", zh: "页码 / 总页数", en: "Page / Total" },
  { kind: "custom", zh: "自定义", en: "Custom" }
];

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const clampNumber = (value: number, fallback: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const badgeClassName = (active: boolean) =>
  active ? "settings-nav-button settings-nav-button--active border-transparent text-slate-700 shadow-sm" : "settings-nav-button border-border text-slate-700";

const SectionCard = ({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) => (
  <section className="settings-card-surface rounded-[26px] border border-border p-5 shadow-sm shadow-slate-200/60">
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-lg font-semibold text-slate-900">{title}</div>
        {hint ? <div className="mt-1 text-sm text-slate-500">{hint}</div> : null}
      </div>
      {action}
    </div>
    {children}
  </section>
);

const SectionNavButton = ({ title, hint, badge, active, onClick }: { title: string; hint: string; badge?: string | null; active: boolean; onClick: () => void }) => (
  <button type="button" className={`settings-soft-surface w-full rounded-2xl border px-4 py-3 text-left transition ${badgeClassName(active)}`} onClick={onClick}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-xs text-slate-500">{hint}</div>
      </div>
      {badge ? <span className="shrink-0 rounded-full border border-border bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{badge}</span> : null}
    </div>
  </button>
);

const SlotEditor = ({ label, slot, language, onChange }: { label: string; slot: PdfExportSlot; language: "zh" | "en"; onChange: (slot: PdfExportSlot) => void }) => (
  <div className="settings-soft-surface rounded-2xl border border-border p-3">
    <div className="text-xs font-semibold text-slate-600">{label}</div>
    <select className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={slot.kind} onChange={(event) => onChange({ ...slot, kind: event.target.value as PdfExportSlotKind, text: event.target.value === "custom" ? slot.text : "" })}>
      {PDF_SLOT_OPTIONS.map((item) => (
        <option key={item.kind} value={item.kind}>{language === "en" ? item.en : item.zh}</option>
      ))}
    </select>
    {slot.kind === "custom" ? <input className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" placeholder={language === "en" ? "Custom text" : "自定义文本"} value={slot.text} onChange={(event) => onChange({ ...slot, text: event.target.value })} /> : null}
  </div>
);

const HeaderFooterEditor = ({ title, layout, language, onChange }: { title: string; layout: PdfExportHeaderFooter; language: "zh" | "en"; onChange: (layout: PdfExportHeaderFooter) => void }) => (
  <div className="settings-soft-surface rounded-2xl border border-border p-4">
    <label className="mb-3 flex items-center gap-2 text-sm">
      <input type="checkbox" checked={layout.enabled} onChange={(event) => onChange({ ...layout, enabled: event.target.checked })} />
      <span className="font-semibold">{title}</span>
    </label>
    <div className={`grid gap-3 md:grid-cols-3 ${layout.enabled ? "" : "opacity-60"}`}>
      <SlotEditor label={language === "en" ? "Left" : "左侧"} slot={layout.left} language={language} onChange={(slot) => onChange({ ...layout, left: slot })} />
      <SlotEditor label={language === "en" ? "Center" : "中间"} slot={layout.center} language={language} onChange={(slot) => onChange({ ...layout, center: slot })} />
      <SlotEditor label={language === "en" ? "Right" : "右侧"} slot={layout.right} language={language} onChange={(slot) => onChange({ ...layout, right: slot })} />
    </div>
  </div>
);
export function SettingsPanel({ showTrigger = true }: { showTrigger?: boolean }) {
  const settings = useAppStore((state) => state.settings);
  const projectPath = useAppStore((state) => state.projectPath);
  const setSettings = useAppStore((state) => state.setSettings);
  const language = useAppStore((state) => state.settings.language);
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("llm");
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [cacheSummary, setCacheSummary] = useState<CacheSummary | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

  useAutoClearMessage(testMessage, setTestMessage);

  const labels = useMemo(
    () => ({
      settings: repairMojibake(t(language, "settings")),
      close: repairMojibake(t(language, "close")),
      prompts: repairMojibake(t(language, "prompts")),
      cache: repairMojibake(t(language, "cache")),
      refresh: repairMojibake(t(language, "refresh")),
      clear: repairMojibake(t(language, "clear")),
      baseUrl: repairMojibake(t(language, "baseUrl")),
      apiKey: repairMojibake(t(language, "apiKey")),
      model: repairMojibake(t(language, "model")),
      apply: repairMojibake(t(language, "apply")),
      testConnection: repairMojibake(t(language, "testConnection")),
      testing: repairMojibake(t(language, "testing")),
      saveProjectFirst: repairMojibake(t(language, "saveProjectFirst")),
      light: repairMojibake(t(language, "light")),
      dark: repairMojibake(t(language, "dark")),
      chatSystemPrompt: repairMojibake(t(language, "chatSystemPrompt")),
      translationPrompt: repairMojibake(t(language, "translationPrompt")),
      glossary: repairMojibake(t(language, "glossary")),
      glossaryPlaceholder: repairMojibake(t(language, "glossaryPlaceholder")),
      showReasoning: repairMojibake(t(language, "showReasoning")),
      enableAttachments: repairMojibake(t(language, "enableAttachments")),
      includeProjectContext: repairMojibake(t(language, "includeProjectContext")),
      languageLabel: repairMojibake(t(language, "language"))
    }),
    [language]
  );

  const copy = useMemo(
    () =>
      language === "en"
        ? {
            llmTitle: "LLM & API",
            llmHint: "Connection, endpoint, key, and model.",
            llmActionHint: "Apply a preset, then adjust the endpoint, key, and model below.",
            llmWarning: "Chat and translation both call external APIs. Watch your quota and billing.",
            keepCurrentModel: "Keep the current model or use the runtime default model.",
            openKeyPortal: "Open key portal",
            noKeyPortal: "No key portal required.",
            promptHint: "A non-empty custom prompt replaces the built-in system prompt for that pipeline.",
            pdfTitle: "PDF Export",
            pdfHint: "Paper size, orientation, margins, and header/footer.",
            pdfPageSize: "Page size",
            pdfOrientation: "Landscape pages",
            pdfOrientationHint: "Turn this on when you need horizontal pages, such as wide tables or code samples.",
            pdfMargins: "Margins (mm)",
            pdfHeader: "Header",
            pdfFooter: "Footer",
            pdfSingleColumnHint: "The export route is currently fixed to a single-column layout to keep pagination and debugging stable.",
            pdfPageNumberHint: "On Windows, page-number slots use the browser's native print footer so page counting stays correct. Exact left/center/right placement and Page / Total formatting are limited by WebView2.",
            marginTop: "Top",
            marginRight: "Right",
            marginBottom: "Bottom",
            marginLeft: "Left",
            appearanceTitle: "Appearance",
            appearanceHint: "Theme and accent color apply across the whole workspace.",
            agentTitle: "Agent",
            agentHint: "These switches affect the interactive agent pane only.",
            hideCommandMessages: "Hide command messages",
            enableAgentStreaming: "Enable agent streaming",
            enableTranslationStreaming: "Enable translation streaming",
            cacheHint: "The cache is tied to the current project path.",
            noData: "No data",
            languageHint: "Switch the workspace language immediately.",
            languageChinese: "Chinese",
            languageEnglish: "English",
            navHint: "Switch sections on the left and edit details on the right."
          }
        : {
            llmTitle: "LLM 与 API",
            llmHint: "管理接口地址、密钥和模型。",
            llmActionHint: "先套用预设，再按需要微调接口地址、密钥和模型。",
            llmWarning: "对话和翻译都会调用外部 API，请自行关注额度与计费。",
            keepCurrentModel: "保留当前模型，或使用运行时默认模型。",
            openKeyPortal: "打开密钥页面",
            noKeyPortal: "这个预设不需要单独申请密钥。",
            promptHint: "只要这里填写了自定义提示词，就会替换对应流程内置的系统提示词。",
            pdfTitle: "PDF 导出",
            pdfHint: "设置纸张尺寸、方向、边距和页眉页脚。",
            pdfPageSize: "纸张尺寸",
            pdfOrientation: "横向页面",
            pdfOrientationHint: "如果内容很宽，比如大表格或长代码块，可以开启横向页面。",
            pdfMargins: "页边距（毫米）",
            pdfHeader: "页眉",
            pdfFooter: "页脚",
            pdfSingleColumnHint: "当前导出固定为单栏布局，这样分页和调试会更稳定。",
            pdfPageNumberHint: "在 Windows 上，页码槽位会改用浏览器原生打印页脚来保证页码正确；此时左右布局和“页码 / 总页数”的精确样式会受 WebView2 限制。",
            marginTop: "上",
            marginRight: "右",
            marginBottom: "下",
            marginLeft: "左",
            appearanceTitle: "外观",
            appearanceHint: "主题和强调色会作用到整个工作区。",
            agentTitle: "Agent",
            agentHint: "这些开关只影响右侧 Agent 交互区域。",
            hideCommandMessages: "隐藏命令消息",
            enableAgentStreaming: "启用 Agent 流式输出",
            enableTranslationStreaming: "启用翻译流式输出",
            cacheHint: "缓存与当前项目路径绑定。",
            noData: "暂无数据",
            languageHint: "立即切换工作区语言。",
            languageChinese: "中文",
            languageEnglish: "English",
            navHint: "左侧切换分类，右侧集中编辑对应设置。"
          },
    [language]
  );

  const pdfExport = settings.pdfExport;

  const updatePdfExport = (patch: Partial<typeof pdfExport>) => {
    setSettings({ pdfExport: { ...pdfExport, ...patch } });
  };

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

  const runConnectionTest = async () => {
    setTestBusy(true);
    setTestMessage("");
    try {
      const reply = await llmService.testConnection();
      setTestMessage(`${language === "en" ? "Connection ok" : "连接成功"}: ${reply.slice(0, 120) || "OK"}`);
    } catch (error) {
      setTestMessage(`${language === "en" ? "Connection failed" : "连接失败"}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTestBusy(false);
    }
  };

  const openExternalLink = async (url: string) => {
    try {
      await invoke("open_external_url", { url });
    } catch (error) {
      setTestMessage(formatUiError(error, language));
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

  useEffect(() => {
    const onOpenSettings = () => setOpen(true);
    window.addEventListener("app:open-settings", onOpenSettings as EventListener);
    return () => window.removeEventListener("app:open-settings", onOpenSettings as EventListener);
  }, []);

  const cacheFileCount = (cacheSummary?.translationCacheFiles || 0) + (cacheSummary?.llmCacheFiles || 0);

  const sections = useMemo(
    () => [
      { id: "llm" as const, title: copy.llmTitle, hint: copy.llmHint },
      { id: "prompts" as const, title: labels.prompts, hint: copy.promptHint },
      { id: "pdfExport" as const, title: copy.pdfTitle, hint: copy.pdfHint },
      { id: "appearance" as const, title: copy.appearanceTitle, hint: copy.appearanceHint },
      { id: "agent" as const, title: copy.agentTitle, hint: copy.agentHint },
      { id: "cache" as const, title: labels.cache, hint: copy.cacheHint, badge: projectPath ? `${cacheFileCount}` : null },
      { id: "language" as const, title: labels.languageLabel, hint: copy.languageHint }
    ],
    [cacheFileCount, copy, labels.cache, labels.languageLabel, labels.prompts, projectPath]
  );

  const activeMeta = sections.find((item) => item.id === activeSection) ?? sections[0];

  const renderSectionContent = () => {
    switch (activeSection) {
      case "llm":
        return (
          <SectionCard
            title={copy.llmTitle}
            hint={copy.llmActionHint}
            action={<button className="accent-button rounded-xl border px-3 py-1.5 text-xs disabled:opacity-60" onClick={() => void runConnectionTest()} disabled={testBusy}>{testBusy ? labels.testing : labels.testConnection}</button>}
          >
            {testMessage ? <div className="settings-soft-surface mb-4 rounded-2xl border border-border px-3 py-2 text-xs text-slate-600">{testMessage}</div> : null}
            <div className="grid gap-3 md:grid-cols-2">
              {API_PRESETS.map((preset) => (
                <div key={preset.label} className="settings-soft-surface rounded-2xl border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">{preset.label}</div>
                    <button className="rounded-xl border border-border bg-white px-3 py-1 text-xs" onClick={() => setSettings({ baseUrl: preset.baseUrl, model: preset.model || settings.model })}>{labels.apply}</button>
                  </div>
                  <div className="mt-2 break-all text-xs text-slate-500">{preset.baseUrl}</div>
                  <div className="mt-1 text-xs text-slate-500">{preset.model ? `${labels.model}: ${preset.model}` : copy.keepCurrentModel}</div>
                  {preset.apiKeyUrl ? <button className="mt-2 border-0 bg-transparent p-0 text-left text-xs text-sky-600 underline" onClick={() => void openExternalLink(preset.apiKeyUrl)}>{copy.openKeyPortal}</button> : <div className="mt-2 text-xs text-slate-400">{copy.noKeyPortal}</div>}
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block text-xs font-medium text-slate-600">
                {labels.baseUrl}
                <input className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.baseUrl} onChange={(event) => setSettings({ baseUrl: event.target.value })} />
              </label>
              <label className="block text-xs font-medium text-slate-600">
                {labels.apiKey}
                <input type="password" className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.apiKey} onChange={(event) => setSettings({ apiKey: event.target.value })} />
              </label>
              <label className="block text-xs font-medium text-slate-600">
                {labels.model}
                <input className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.model} onChange={(event) => setSettings({ model: event.target.value })} />
              </label>
            </div>
            <div className="settings-warning-surface mt-4 rounded-2xl border px-3 py-2 text-sm font-semibold">{copy.llmWarning}</div>
          </SectionCard>
        );

      case "prompts":
        return (
          <SectionCard title={labels.prompts} hint={copy.promptHint}>
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-600">
                {labels.chatSystemPrompt}
                <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.chatSystemPrompt} onChange={(event) => setSettings({ chatSystemPrompt: event.target.value })} />
              </label>
              <label className="block text-xs font-medium text-slate-600">
                {labels.translationPrompt}
                <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.translationPrompt} onChange={(event) => setSettings({ translationPrompt: event.target.value })} />
              </label>
              <label className="block text-xs font-medium text-slate-600">
                {labels.glossary}
                <textarea className="mt-1 min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" placeholder={labels.glossaryPlaceholder} value={settings.glossary} onChange={(event) => setSettings({ glossary: event.target.value })} />
              </label>
            </div>
          </SectionCard>
        );

      case "pdfExport":
        return (
          <SectionCard title={copy.pdfTitle} hint={copy.pdfHint}>
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block text-xs font-medium text-slate-600">
                  {copy.pdfPageSize}
                  <select className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={pdfExport.pageSize} onChange={(event) => updatePdfExport({ pageSize: event.target.value as "A4" | "Letter" })}>
                    <option value="A4">A4</option>
                    <option value="Letter">Letter</option>
                  </select>
                </label>
              </div>

              <label className="settings-soft-surface flex items-start gap-3 rounded-2xl border border-border px-4 py-3 text-sm">
                <input className="mt-0.5" type="checkbox" checked={pdfExport.landscape} onChange={(event) => updatePdfExport({ landscape: event.target.checked })} />
                <span>
                  <span className="block font-semibold text-slate-900">{copy.pdfOrientation}</span>
                  <span className="mt-1 block text-xs leading-6 text-slate-600">{copy.pdfOrientationHint}</span>
                </span>
              </label>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-600">{copy.pdfMargins}</div>
                <div className="grid gap-3 md:grid-cols-4">
                  {([
                    ["top", copy.marginTop],
                    ["right", copy.marginRight],
                    ["bottom", copy.marginBottom],
                    ["left", copy.marginLeft]
                  ] as const).map(([side, label]) => (
                    <label key={side} className="block text-xs font-medium text-slate-600">
                      {label}
                      <input
                        type="number"
                        min={0}
                        max={50}
                        step={1}
                        className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
                        value={pdfExport.margins[side]}
                        onChange={(event) =>
                          updatePdfExport({
                            margins: {
                              ...pdfExport.margins,
                              [side]: clampNumber(Number(event.target.value), pdfExport.margins[side], 0, 50)
                            }
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <HeaderFooterEditor title={copy.pdfHeader} layout={pdfExport.header} language={language} onChange={(header) => updatePdfExport({ header })} />
                <HeaderFooterEditor title={copy.pdfFooter} layout={pdfExport.footer} language={language} onChange={(footer) => updatePdfExport({ footer })} />
              </div>
            </div>
          </SectionCard>
        );

      case "appearance":
        return (
          <SectionCard title={copy.appearanceTitle} hint={copy.appearanceHint}>
            <div className="mb-4 flex gap-2">
              <button className={`rounded-xl border px-3 py-2 text-sm ${settings.themeMode === "light" ? "theme-active" : ""}`} onClick={() => setSettings({ themeMode: "light" })}>
                {labels.light}
              </button>
              <button className={`rounded-xl border px-3 py-2 text-sm ${settings.themeMode === "dark" ? "theme-active" : ""}`} onClick={() => setSettings({ themeMode: "dark" })}>
                {labels.dark}
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {ACCENT_PRESETS.map((preset) => {
                const active = settings.accentColor === preset.value;
                return (
                  <button key={preset.value} className={`rounded-2xl border px-3 py-3 text-left transition ${active ? "theme-active shadow-sm" : ""}`} onClick={() => setSettings({ accentColor: preset.value })}>
                    <div className="mb-2 h-10 rounded-xl" style={{ background: preset.value }} />
                    <div className="text-sm font-medium">{language === "en" ? preset.en : preset.zh}</div>
                  </button>
                );
              })}
            </div>
          </SectionCard>
        );

      case "agent":
        return (
          <SectionCard title={copy.agentTitle} hint={copy.agentHint}>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.showThinking} onChange={(event) => setSettings({ showThinking: event.target.checked })} />{labels.showReasoning}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.enableAgentAttachments} onChange={(event) => setSettings({ enableAgentAttachments: event.target.checked })} />{labels.enableAttachments}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.includeProjectContextInChat} onChange={(event) => setSettings({ includeProjectContextInChat: event.target.checked })} />{labels.includeProjectContext}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.hideCommandMessages} onChange={(event) => setSettings({ hideCommandMessages: event.target.checked })} />{copy.hideCommandMessages}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.enableAgentStreaming} onChange={(event) => setSettings({ enableAgentStreaming: event.target.checked })} />{copy.enableAgentStreaming}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.enableTranslationStreaming} onChange={(event) => setSettings({ enableTranslationStreaming: event.target.checked })} />{copy.enableTranslationStreaming}</label>
            </div>
          </SectionCard>
        );

      case "cache":
        return (
          <SectionCard title={labels.cache} hint={copy.cacheHint} action={<button className="rounded-xl border border-border bg-white px-3 py-1 text-xs" onClick={() => void refreshCacheSummary()} disabled={cacheBusy || !projectPath}>{labels.refresh}</button>}>
            {!projectPath ? (
              <div className="settings-soft-surface rounded-2xl border border-border px-4 py-3 text-sm text-slate-500">{labels.saveProjectFirst}</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="settings-soft-surface rounded-2xl border border-border p-4">
                  <div className="text-sm font-semibold">translation_cache</div>
                  <div className="mt-1 text-xs text-slate-500">{cacheSummary ? `${cacheSummary.translationCacheFiles} files / ${formatBytes(cacheSummary.translationCacheBytes)}` : copy.noData}</div>
                  {cacheSummary && cacheSummary.translationFiles.length > 0 ? <div className="mt-3 max-h-44 overflow-y-auto rounded-xl border border-border bg-white p-2"><div className="space-y-1">{cacheSummary.translationFiles.map((file) => <div key={file.name} className="flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate text-slate-700" title={file.name}>{file.name}</span><span className="shrink-0 text-slate-500">{formatBytes(file.bytes)}</span></div>)}</div></div> : null}
                  <button className="mt-3 rounded-xl border border-border bg-white px-3 py-1 text-xs" onClick={() => void clearCache("translation")} disabled={cacheBusy}>{labels.clear}</button>
                </div>
                <div className="settings-soft-surface rounded-2xl border border-border p-4">
                  <div className="text-sm font-semibold">llm_cache</div>
                  <div className="mt-1 text-xs text-slate-500">{cacheSummary ? `${cacheSummary.llmCacheFiles} files / ${formatBytes(cacheSummary.llmCacheBytes)}` : copy.noData}</div>
                  {cacheSummary && cacheSummary.llmFiles.length > 0 ? <div className="mt-3 max-h-44 overflow-y-auto rounded-xl border border-border bg-white p-2"><div className="space-y-1">{cacheSummary.llmFiles.map((file) => <div key={file.name} className="flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate text-slate-700" title={file.name}>{file.name}</span><span className="shrink-0 text-slate-500">{formatBytes(file.bytes)}</span></div>)}</div></div> : null}
                  <button className="mt-3 rounded-xl border border-border bg-white px-3 py-1 text-xs" onClick={() => void clearCache("llm")} disabled={cacheBusy}>{labels.clear}</button>
                </div>
              </div>
            )}
          </SectionCard>
        );
      case "language":
        return (
          <SectionCard title={labels.languageLabel} hint={copy.languageHint}>
            <select className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm" value={settings.language} onChange={(event) => setSettings({ language: event.target.value as "zh" | "en" })}>
              <option value="zh">{copy.languageChinese}</option>
              <option value="en">{copy.languageEnglish}</option>
            </select>
          </SectionCard>
        );
    }
  };

  const modalBackdropProps = useBackdropClose<HTMLDivElement>(() => setOpen(false));

  return (
    <>
      {showTrigger ? (
        <button className="rounded border border-border bg-white px-3 py-1 text-sm" onClick={() => setOpen(true)}>
          {labels.settings}
        </button>
      ) : null}
      {open
        ? createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4" {...modalBackdropProps}>
              <div className="settings-modal settings-shell relative flex h-[min(860px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] overflow-hidden rounded-[30px] border border-white/20 shadow-2xl" onClick={(event) => event.stopPropagation()}>
                <aside className="settings-nav-surface flex w-[280px] shrink-0 flex-col border-r border-border">
                  <div className="border-b border-border px-5 py-5">
                    <div className="text-xl font-semibold text-slate-900">{labels.settings}</div>
                    <div className="mt-1 text-sm text-slate-500">{copy.navHint}</div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <div className="space-y-2">
                      {sections.map((item) => <SectionNavButton key={item.id} title={item.title} hint={item.hint} badge={item.badge} active={activeSection === item.id} onClick={() => setActiveSection(item.id)} />)}
                    </div>
                  </div>
                  <div className="border-t border-border px-5 py-4">
                    <button className="w-full rounded-full border border-border bg-white px-3 py-2 text-sm text-slate-600" onClick={() => setOpen(false)}>
                      {labels.close}
                    </button>
                  </div>
                </aside>
                <section className="settings-content-surface min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto flex min-h-full max-w-5xl flex-col px-6 py-6">
                    <div className="mb-5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-2xl font-semibold text-slate-900">{activeMeta.title}</div>
                        <div className="mt-1 text-sm text-slate-500">{activeMeta.hint}</div>
                      </div>
                      {activeMeta.badge ? <span className="rounded-full border border-border bg-white px-3 py-1 text-xs font-semibold text-slate-600">{activeMeta.badge}</span> : null}
                    </div>
                    <div className="pb-2">{renderSectionContent()}</div>
                  </div>
                </section>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
