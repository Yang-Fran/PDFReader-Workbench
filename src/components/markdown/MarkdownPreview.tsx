import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Components, UrlTransform } from "react-markdown";
import { RichMarkdown } from "./RichMarkdown";
import { guessImageMimeType, normalizeMarkdownPreviewContent, parsePdfQuoteBlock, resolvePreviewTargetPath } from "../../services/markdownPreviewService";
import { useToastStore } from "../../stores/toastStore";
import { formatUiError } from "../../utils/textDisplay";

type MarkdownPreviewProps = {
  content: string;
  placeholder: string;
  sourcePath: string;
  language: "zh" | "en";
  onOpenPdfQuote: (path: string, page: number) => void;
};

const EXTERNAL_PROTOCOL_RE = /^(https?:|mailto:|tel:|data:|blob:|asset:|tauri:)/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)\n]+)\)/g;
const HTML_IMAGE_RE = /<img\s+[^>]*src=(["'])(.*?)\1/gi;
const localImageDataUrlCache = new Map<string, Promise<string>>();

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to preload markdown image."));
    reader.readAsDataURL(blob);
  });

const loadLocalImageDataUrl = async (path: string) => {
  const cached = localImageDataUrlCache.get(path);
  if (cached) return cached;

  const pending = (async () => {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    const blob = new Blob([new Uint8Array(bytes)], { type: guessImageMimeType(path) });
    return blobToDataUrl(blob);
  })().catch((error) => {
    localImageDataUrlCache.delete(path);
    throw error;
  });

  localImageDataUrlCache.set(path, pending);
  return pending;
};

const extractPreviewImageSources = (content: string, sourcePath: string) => {
  const sources = new Set<string>();
  for (const match of content.matchAll(MARKDOWN_IMAGE_RE)) {
    const rawSource = match[1]?.trim();
    if (!rawSource) continue;
    const resolvedSource = resolvePreviewTargetPath(rawSource, sourcePath);
    if (resolvedSource && !EXTERNAL_PROTOCOL_RE.test(resolvedSource)) {
      sources.add(resolvedSource);
    }
  }

  for (const match of content.matchAll(HTML_IMAGE_RE)) {
    const rawSource = match[2]?.trim();
    if (!rawSource) continue;
    const resolvedSource = resolvePreviewTargetPath(rawSource, sourcePath);
    if (resolvedSource && !EXTERNAL_PROTOCOL_RE.test(resolvedSource)) {
      sources.add(resolvedSource);
    }
  }

  return [...sources];
};

function MarkdownImage(props: { src: string; alt?: string; title?: string; sourcePath: string }) {
  const { src, alt, title, sourcePath } = props;
  const [blobUrl, setBlobUrl] = useState("");
  const [failed, setFailed] = useState(false);

  const resolvedSrc = useMemo(() => resolvePreviewTargetPath(src, sourcePath), [sourcePath, src]);
  const external = EXTERNAL_PROTOCOL_RE.test(resolvedSrc);

  useEffect(() => {
    let disposed = false;

    if (!resolvedSrc) {
      setBlobUrl("");
      setFailed(true);
      return;
    }

    if (external) {
      setBlobUrl(resolvedSrc);
      setFailed(false);
      return;
    }

    setBlobUrl("");
    setFailed(false);

    void (async () => {
      try {
        const nextSrc = await loadLocalImageDataUrl(resolvedSrc);
        if (disposed) return;
        setBlobUrl(nextSrc);
      } catch {
        if (!disposed) {
          setFailed(true);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [external, resolvedSrc]);

  return (
    <span className="markdown-image-wrap">
      {blobUrl && !failed ? (
        <img
          src={blobUrl}
          alt={alt ?? ""}
          title={title}
          className="markdown-image"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="markdown-image-error">{alt || src}</span>
      )}
      {alt ? <span className="markdown-image-caption">{alt}</span> : null}
    </span>
  );
}

export function MarkdownPreview(props: MarkdownPreviewProps) {
  const { content, placeholder, sourcePath, language, onOpenPdfQuote } = props;
  const pushToast = useToastStore((state) => state.pushToast);
  const deferredContent = useDeferredValue(content || placeholder);

  const previewContent = useMemo(() => normalizeMarkdownPreviewContent(deferredContent), [deferredContent]);
  const previewUrlTransform = useMemo<UrlTransform>(() => (url) => url, []);
  const previewImageSources = useMemo(() => extractPreviewImageSources(previewContent, sourcePath), [previewContent, sourcePath]);

  useEffect(() => {
    void Promise.all(previewImageSources.map((path) => loadLocalImageDataUrl(path).catch(() => "")));
  }, [previewImageSources]);

  const components = useMemo<Components>(
    () => ({
      p(paragraphProps) {
        return <p data-md-block="1" {...paragraphProps} />;
      },
      blockquote(blockquoteProps) {
        return <blockquote data-md-block="1" {...blockquoteProps} />;
      },
      h1(headingProps) {
        return <h1 data-md-block="1" {...headingProps} />;
      },
      h2(headingProps) {
        return <h2 data-md-block="1" {...headingProps} />;
      },
      h3(headingProps) {
        return <h3 data-md-block="1" {...headingProps} />;
      },
      h4(headingProps) {
        return <h4 data-md-block="1" {...headingProps} />;
      },
      h5(headingProps) {
        return <h5 data-md-block="1" {...headingProps} />;
      },
      h6(headingProps) {
        return <h6 data-md-block="1" {...headingProps} />;
      },
      table(tableProps) {
        return <table data-md-block="1" {...tableProps} />;
      },
      a(linkProps) {
        const href = typeof linkProps.href === "string" ? linkProps.href.trim() : "";
        const resolvedHref = resolvePreviewTargetPath(href, sourcePath);
        const external = EXTERNAL_PROTOCOL_RE.test(resolvedHref);
        const className = external ? "markdown-link" : "markdown-link markdown-link--file";

        if (!href) {
          return <>{linkProps.children}</>;
        }

        return (
          <a
            href={external ? resolvedHref : "#"}
            className={className}
            onClick={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  if (external) {
                    await invoke("open_external_url", { url: resolvedHref });
                  } else {
                    await invoke("open_path", { path: resolvedHref });
                  }
                } catch (error) {
                  console.error("Failed to open markdown target", error);
                  pushToast(formatUiError(error, language), "error");
                }
              })();
            }}
          >
            {linkProps.children}
          </a>
        );
      },
      code(codeProps) {
        const className = codeProps.className ?? "";
        const codeText = String(codeProps.children ?? "");
        const blockLanguage = className.replace(/^language-/, "");
        const isBlock = Boolean(blockLanguage) || codeText.includes("\n");

        if (isBlock && blockLanguage === "pdf-quote") {
          const parsed = parsePdfQuoteBlock(codeText);
          if (parsed) {
            return (
              <blockquote className="pdf-quote-block" data-md-block="1">
                <button type="button" className="pdf-quote-header" onClick={() => onOpenPdfQuote(parsed.meta.path, parsed.meta.page)}>
                  {parsed.meta.name} / page {parsed.meta.page}
                </button>
                <div className="pdf-quote-content whitespace-pre-wrap">{parsed.text}</div>
              </blockquote>
            );
          }
        }

        if (!isBlock) {
          return <code className={className}>{codeProps.children}</code>;
        }

        return (
          <pre className="markdown-code-block" data-md-block="1">
            <code className={className}>{codeProps.children}</code>
          </pre>
        );
      },
      img(imageProps) {
        const src = typeof imageProps.src === "string" ? imageProps.src.trim() : "";
        if (!src) return null;
        return <MarkdownImage src={src} alt={imageProps.alt} title={imageProps.title} sourcePath={sourcePath} />;
      },
      ul(listProps) {
        return <ul className="list-disc pl-6" {...listProps} />;
      },
      ol(listProps) {
        return <ol className="list-decimal pl-6" {...listProps} />;
      },
      li(listProps) {
        return <li className="my-1" data-md-block="1" {...listProps} />;
      }
    }),
    [language, onOpenPdfQuote, pushToast, sourcePath]
  );

  return <RichMarkdown content={previewContent} className="markdown-preview" components={components} urlTransform={previewUrlTransform} />;
}
