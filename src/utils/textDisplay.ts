import type { UiLanguage } from "../i18n";

const hasCjk = (value: string) => /[\u3400-\u9fff]/.test(value);
const hasSuspiciousLatin = (value: string) => /[脙脗脨脩脴脼忙莽茅氓盲猫锚毛矛铆卯茂貌贸么玫枚霉煤没眉艙閿欒]/.test(value);

export const repairMojibake = (value: string) => {
  if (!value || hasCjk(value) || !hasSuspiciousLatin(value)) return value;
  try {
    const bytes = Uint8Array.from(Array.from(value).map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    if (!decoded) return value;
    return hasCjk(decoded) || /[A-Za-z]/.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
};

const stringifyError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
};

export const formatUiError = (error: unknown, language: UiLanguage) => {
  const message = repairMojibake(stringifyError(error));
  return `${language === "en" ? "Error" : "错误"}: ${message}`;
};

export const withTimeout = async <T>(promise: Promise<T>, ms: number, timeoutMessage: string) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
