import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, PdfExportSettings } from "../types";
import { nativeFileService } from "./nativeFileService";

const LEGACY_SETTINGS_KEY = "pdfreader_settings";

type PersistedPdfExportSettings = Omit<PdfExportSettings, "sourcePath"> & {
  sourcePath?: string;
};

type PersistedAppSettings = Omit<AppSettings, "pdfExport"> & {
  pdfExport?: Partial<PersistedPdfExportSettings>;
};

export const defaultSettings: AppSettings = {
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
  translationHighlightKeyPoints: false,
  translationCarryover: false,
  chatSystemPrompt: "",
  translationPrompt: "",
  glossary: "",
  pdfExport: {
    pageSize: "A4",
    landscape: false,
    scale: 1,
    includeToc: true,
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

export const mergePdfExportSettings = (value?: Partial<PdfExportSettings> | null): PdfExportSettings => {
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
    includeToc: value?.includeToc ?? defaultSettings.pdfExport.includeToc,
    sourcePath: value?.sourcePath ?? defaultSettings.pdfExport.sourcePath,
    margins: {
      ...defaultSettings.pdfExport.margins,
      ...(value?.margins ?? {})
    },
    header: mergedHeader,
    footer: mergedFooter
  };
};

export const normalizeAppSettings = (value?: Partial<PersistedAppSettings> | null): AppSettings => ({
  ...defaultSettings,
  ...(value ?? {}),
  pdfExport: mergePdfExportSettings(value?.pdfExport)
});

const toPersistedAppSettings = (settings: AppSettings): PersistedAppSettings => {
  const { sourcePath: _sourcePath, ...pdfExport } = settings.pdfExport;
  return {
    ...settings,
    pdfExport
  };
};

export const arePersistedSettingsEqual = (left: AppSettings, right: AppSettings) =>
  JSON.stringify(toPersistedAppSettings(left)) === JSON.stringify(toPersistedAppSettings(right));

const readLegacyLocalSettings = () => {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PersistedAppSettings>;
  } catch {
    return null;
  }
};

const clearLegacyLocalSettings = () => {
  try {
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
  } catch {
    // Ignore legacy cleanup failures.
  }
};

export const getAppSettingsPath = () => invoke<string>("get_app_settings_path");

export const saveGlobalSettings = async (settings: AppSettings) => {
  const path = await getAppSettingsPath();
  await nativeFileService.writeTextFile(path, JSON.stringify(toPersistedAppSettings(settings), null, 2));
};

export const loadGlobalSettings = async () => {
  const path = await getAppSettingsPath();

  try {
    const raw = await nativeFileService.readTextFile(path);
    return normalizeAppSettings(JSON.parse(raw) as Partial<PersistedAppSettings>);
  } catch {
    const legacySettings = readLegacyLocalSettings();
    if (legacySettings) {
      const migrated = normalizeAppSettings(legacySettings);
      try {
        await saveGlobalSettings(migrated);
        clearLegacyLocalSettings();
      } catch {
        // Keep using the migrated in-memory settings even if writing fails.
      }
      return migrated;
    }
    return defaultSettings;
  }
};
