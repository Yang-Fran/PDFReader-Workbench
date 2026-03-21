export type MarkdownResourceKind = "image" | "link" | "attachment";

export type MarkdownResource = {
  kind: MarkdownResourceKind;
  label: string;
  originalTarget: string;
  resolvedTarget: string;
  external: boolean;
};

export type NormalizedMarkdownDocument = {
  markdown: string;
  sourcePath: string;
  resources: MarkdownResource[];
};

export type PdfQuoteBlockMeta = {
  name: string;
  page: number;
  path: string;
};

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"];
export const EXTERNAL_PROTOCOL_RE = /^(https?:|mailto:|tel:|data:|blob:|asset:|tauri:)/i;
export const UNSAFE_PROTOCOL_RE = /^(javascript:|vbscript:)/i;
export const FILE_PROTOCOL_RE = /^file:\/\//i;
export const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
export const ROOTED_PATH_RE = /^(\/|\\)/;
export const ALIGN_TAG_NAMES = ["left", "right", "center"] as const;

const LOCAL_DESTINATION_RE = /^<?(?:file:\/\/\/|[a-zA-Z]:[\\/]|\/|\\)/;
const MARKDOWN_DESTINATION_RE = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

export const stripWrappingQuotes = (value: string) => value.trim().replace(/^['"]|['"]$/g, "");

export const decodeMarkdownDestination = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const sanitizeAssetString = (value: string) => {
  let normalized = stripWrappingQuotes(value).replace(/\\/g, "/");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  if (FILE_PROTOCOL_RE.test(normalized)) normalized = normalized.replace(FILE_PROTOCOL_RE, "");
  return normalized;
};

const splitPath = (value: string) => {
  const normalized = sanitizeAssetString(value);
  const driveMatch = normalized.match(/^[a-zA-Z]:/);
  const prefix = driveMatch ? driveMatch[0] : normalized.startsWith("/") ? "/" : "";
  const withoutPrefix = prefix === "/" ? normalized.slice(1) : driveMatch ? normalized.slice(prefix.length) : normalized;
  const segments = withoutPrefix.split("/").filter(Boolean);
  return { prefix, segments };
};

export const normalizePathString = (value: string) => {
  const { prefix, segments } = splitPath(value);
  const next: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (next.length > 0) next.pop();
      continue;
    }
    next.push(segment);
  }

  if (prefix === "/") return `/${next.join("/")}`;
  return prefix ? `${prefix}/${next.join("/")}` : next.join("/");
};

export const getDirname = (value: string) => {
  const normalized = normalizePathString(value);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : normalized;
};

export const sourceBaseDir = (sourcePath: string) => {
  const normalized = normalizePathString(sourcePath);
  if (!normalized) return "";
  const lastSegment = normalized.split("/").pop() ?? "";
  return /\.[^.\\/]+$/i.test(lastSegment) ? getDirname(normalized) : normalized;
};

export const resolveLocalPath = (target: string, sourcePath: string) => {
  const sanitized = sanitizeAssetString(target);
  if (!sanitized || sanitized.startsWith("#") || EXTERNAL_PROTOCOL_RE.test(sanitized) || UNSAFE_PROTOCOL_RE.test(sanitized)) return "";
  if (WINDOWS_ABSOLUTE_PATH_RE.test(sanitized) || ROOTED_PATH_RE.test(sanitized)) return normalizePathString(sanitized);
  const baseDir = sourceBaseDir(sourcePath);
  return baseDir ? normalizePathString(`${baseDir}/${sanitized}`) : normalizePathString(sanitized);
};

export const resolveDocumentTarget = (target: string, sourcePath: string) => {
  const decoded = decodeMarkdownDestination(target.trim());
  if (!decoded || UNSAFE_PROTOCOL_RE.test(decoded)) return "";
  if (decoded.startsWith("#")) return decoded;
  if (EXTERNAL_PROTOCOL_RE.test(decoded)) return decoded;
  if (FILE_PROTOCOL_RE.test(decoded) || WINDOWS_ABSOLUTE_PATH_RE.test(decoded) || ROOTED_PATH_RE.test(decoded)) {
    return normalizePathString(decoded);
  }
  return resolveLocalPath(decoded, sourcePath);
};

export const getFileName = (value: string) => {
  const normalized = sanitizeAssetString(value);
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
};

export const isImagePath = (value: string) => IMAGE_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension));

export const guessImageMimeType = (value: string) => {
  const lower = value.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
};

export const parsePdfQuoteBlock = (value: string): { meta: PdfQuoteBlockMeta; text: string } | null => {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.length < 2) return null;

  try {
    const meta = JSON.parse(lines[0]) as PdfQuoteBlockMeta;
    if (!meta || typeof meta.name !== "string" || typeof meta.page !== "number" || typeof meta.path !== "string") return null;
    return {
      meta,
      text: lines.slice(1).join("\n").trim()
    };
  } catch {
    return null;
  }
};

export const normalizeAlignmentBlocks = (markdown: string) => {
  const lines: string[] = [];

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    const lowered = trimmed.toLowerCase();

    const normalizedLine =
      lowered.startsWith("<center>") && lowered.endsWith("</center>")
        ? `<center>${trimmed.slice("<center>".length, trimmed.length - "</center>".length)}</center>`
        : lowered.startsWith("<left>") && lowered.endsWith("</left>")
          ? `<left>${trimmed.slice("<left>".length, trimmed.length - "</left>".length)}</left>`
          : lowered.startsWith("<right>") && lowered.endsWith("</right>")
            ? `<right>${trimmed.slice("<right>".length, trimmed.length - "</right>".length)}</right>`
            : rawLine;

    const normalizedTrimmed = normalizedLine.trim().toLowerCase();
    const isAlignBlock =
      (normalizedTrimmed.startsWith("<center>") && normalizedTrimmed.endsWith("</center>")) ||
      (normalizedTrimmed.startsWith("<left>") && normalizedTrimmed.endsWith("</left>")) ||
      (normalizedTrimmed.startsWith("<right>") && normalizedTrimmed.endsWith("</right>"));

    if (isAlignBlock && lines[lines.length - 1]?.trim()) {
      lines.push("");
    }

    lines.push(normalizedLine);

    if (isAlignBlock) {
      lines.push("");
    }
  }

  return lines.join("\n");
};

export const normalizeCustomInlineTags = (markdown: string) =>
  markdown
    .replace(/<\s*bold\s*>/gi, "<strong>")
    .replace(/<\s*\/\s*bold\s*>/gi, "</strong>");

export const normalizeLocalAssetDestinations = (markdown: string) =>
  markdown.replace(MARKDOWN_DESTINATION_RE, (full, bang: string, label: string, destination: string) => {
    const trimmed = destination.trim();
    if (!trimmed || trimmed.startsWith("<") || !LOCAL_DESTINATION_RE.test(trimmed)) {
      return full;
    }
    return `${bang}[${label}](${trimmed.replace(/ /g, "%20")})`;
  });

const collectMarkdownResources = (markdown: string, sourcePath: string) => {
  const resources = new Map<string, MarkdownResource>();
  const normalizedSourcePath = sourceBaseDir(sourcePath);

  markdown.replace(MARKDOWN_DESTINATION_RE, (_full, bang: string, label: string, destination: string) => {
    const originalTarget = stripWrappingQuotes(destination.trim());
    if (!originalTarget) return "";

    const explicitAttachment = originalTarget.toLowerCase().startsWith("attachment:");
    const target = explicitAttachment ? originalTarget.replace(/^attachment:/i, "") : originalTarget;
    const resolvedTarget = resolveDocumentTarget(target, normalizedSourcePath);
    const external = EXTERNAL_PROTOCOL_RE.test(target);
    const kind: MarkdownResourceKind = bang === "!"
      ? "image"
      : explicitAttachment
        ? "attachment"
        : isImagePath(target)
          ? "image"
          : "link";

    const resource: MarkdownResource = {
      kind,
      label: label.trim() || getFileName(target) || target,
      originalTarget: target,
      resolvedTarget: resolvedTarget || sanitizeAssetString(target),
      external
    };

    resources.set(`${kind}:${resource.resolvedTarget}:${resource.label}`, resource);
    return "";
  });

  return Array.from(resources.values());
};

export const normalizeMarkdownDocument = (markdown: string, options: { sourcePath: string }): NormalizedMarkdownDocument => {
  const normalizedMarkdown = normalizeCustomInlineTags(
    normalizeAlignmentBlocks(normalizeLocalAssetDestinations(markdown).replace(/\r\n/g, "\n"))
  );
  return {
    markdown: normalizedMarkdown,
    sourcePath: options.sourcePath,
    resources: collectMarkdownResources(normalizedMarkdown, options.sourcePath)
  };
};
