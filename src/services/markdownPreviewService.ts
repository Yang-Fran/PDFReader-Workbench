import {
  EXTERNAL_PROTOCOL_RE,
  FILE_PROTOCOL_RE,
  ROOTED_PATH_RE,
  WINDOWS_ABSOLUTE_PATH_RE,
  decodeMarkdownDestination,
  guessImageMimeType,
  normalizeMarkdownDocument,
  parsePdfQuoteBlock,
  resolveLocalPath
} from "./markdownNormalizeService";

const normalizeInlineBackslashMath = (value: string) => value.replace(/(^|[^\\])\\\((.+?)\\\)/g, (_, prefix: string, expr: string) => `${prefix}$${expr}$`);

const normalizeMathSyntax = (markdown: string) => {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let fenceMarker: string | null = null;
  let blockMathBuffer: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!blockMathBuffer) {
        if (!fenceMarker) {
          fenceMarker = marker;
        } else if (trimmed.startsWith(fenceMarker)) {
          fenceMarker = null;
        }
      }
      output.push(line);
      continue;
    }

    if (fenceMarker) {
      output.push(line);
      continue;
    }

    if (blockMathBuffer) {
      const closeIndex = line.indexOf("\\]");
      if (closeIndex >= 0) {
        blockMathBuffer.push(line.slice(0, closeIndex));
        output.push("$$");
        output.push(blockMathBuffer.join("\n"));
        output.push("$$");
        const tail = line.slice(closeIndex + 2);
        if (tail.trim()) {
          output.push(normalizeInlineBackslashMath(tail));
        }
        blockMathBuffer = null;
      } else {
        blockMathBuffer.push(line);
      }
      continue;
    }

    const blockStart = trimmed.indexOf("\\[");
    if (blockStart >= 0 && trimmed.slice(0, blockStart).trim() === "") {
      const lineAfterMarker = trimmed.slice(blockStart + 2);
      const closeIndex = lineAfterMarker.indexOf("\\]");
      if (closeIndex >= 0) {
        output.push("$$");
        output.push(lineAfterMarker.slice(0, closeIndex));
        output.push("$$");
        const tail = lineAfterMarker.slice(closeIndex + 2);
        if (tail.trim()) {
          output.push(normalizeInlineBackslashMath(tail));
        }
      } else {
        blockMathBuffer = [lineAfterMarker];
      }
      continue;
    }

    output.push(normalizeInlineBackslashMath(line));
  }

  if (blockMathBuffer) {
    output.push("\\[");
    output.push(...blockMathBuffer);
  }

  return output.join("\n");
};

const decodeFileUrl = (value: string) => {
  if (!FILE_PROTOCOL_RE.test(value)) return value;
  const normalized = value.replace(FILE_PROTOCOL_RE, "");
  const withDrive = normalized.replace(/^\/([a-zA-Z]:)/, "$1");
  return decodeURIComponent(withDrive).replace(/\//g, "\\");
};

export const normalizeMarkdownPreviewContent = (markdown: string) => {
  const normalized = normalizeMarkdownDocument(markdown, { sourcePath: "" });
  return normalizeMathSyntax(normalized.markdown);
};

export const resolvePreviewTargetPath = (value: string, sourcePath: string) => {
  const decodedValue = decodeMarkdownDestination(value.trim());
  if (!decodedValue) return "";
  if (EXTERNAL_PROTOCOL_RE.test(decodedValue)) return decodedValue;
  if (FILE_PROTOCOL_RE.test(decodedValue)) return decodeFileUrl(decodedValue);
  if (WINDOWS_ABSOLUTE_PATH_RE.test(decodedValue) || ROOTED_PATH_RE.test(decodedValue)) return decodedValue;
  return resolveLocalPath(decodedValue, sourcePath);
};

export { guessImageMimeType, parsePdfQuoteBlock };
