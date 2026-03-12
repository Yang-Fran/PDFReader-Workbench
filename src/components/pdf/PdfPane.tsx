import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type WheelEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { debugLogger } from "../../services/debugLogger";
import { llmService } from "../../services/llmService";
import { ocrService } from "../../services/ocrService";
import { useAppStore } from "../../stores/appStore";
import { TranslationStatus } from "../../types";
import { t } from "../../i18n";

type TextLayerItem = {
  id: string;
  text: string;
  left: number;
  top: number;
  fontSize: number;
  width?: number;
  height?: number;
};

type PageSize = { width: number; height: number };
type PagePosition = { page: number; progress: number };

const QUEUE_RADIUS = 1;
const RENDER_RADIUS = 2;
const CANCEL_TRANSLATION_DISTANCE = 3;
const PDF_ANCHOR_RATIO = 0;
const TRANSLATION_ANCHOR_RATIO = 0.5;
const DEFAULT_ESTIMATED_PAGE_SIZE: PageSize = { width: 816, height: 1056 };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

const getPdfJs = async () => {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfjs;
    })();
  }
  return pdfJsPromise;
};

function getPagePositionAtAnchor(
  container: HTMLDivElement,
  refs: MutableRefObject<Record<number, HTMLElement | null>>,
  anchorRatio: number
): PagePosition {
  const anchorY = container.scrollTop + container.clientHeight * anchorRatio;
  const entries = Object.entries(refs.current)
    .map(([key, node]) => [Number(key), node] as const)
    .filter((entry): entry is readonly [number, HTMLElement] => entry[1] !== null)
    .sort((a, b) => a[0] - b[0]);

  if (entries.length === 0) return { page: 1, progress: 0 };

  let fallbackPage = entries[0][0];
  for (const [page, node] of entries) {
    fallbackPage = page;
    const top = node.offsetTop;
    const height = Math.max(1, node.offsetHeight);
    const bottom = top + height;
    if (anchorY < top) return { page, progress: 0 };
    if (anchorY <= bottom) return { page, progress: clamp((anchorY - top) / height, 0, 1) };
  }

  return { page: fallbackPage, progress: 1 };
}

function PageView(props: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  zoomScale: number;
  textLayerVisible: boolean;
  pdfLayerVisible: boolean;
  ocrText: string;
  ocrLayerItems: TextLayerItem[];
  pageBaseSize?: PageSize;
  onTextExtracted: (page: number, text: string) => void;
  onPageMeasured: (page: number, size: PageSize) => void;
  registerCanvas: (page: number, canvas: HTMLCanvasElement | null) => void;
}) {
  const { doc, pageNumber, zoomScale, textLayerVisible, pdfLayerVisible, ocrText, ocrLayerItems, pageBaseSize, onTextExtracted, onPageMeasured, registerCanvas } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderSeqRef = useRef(0);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [nativeText, setNativeText] = useState("");
  const [nativeOverlayItems, setNativeOverlayItems] = useState<TextLayerItem[]>([]);

  const width = pageSize.width || (pageBaseSize ? pageBaseSize.width * zoomScale : 0);
  const height = pageSize.height || (pageBaseSize ? pageBaseSize.height * zoomScale : 0);
  const mergedText = nativeText || ocrText || "";
  const overlayItems = nativeOverlayItems.length > 0 ? nativeOverlayItems : ocrLayerItems;

  useEffect(() => {
    registerCanvas(pageNumber, canvasRef.current);
    return () => registerCanvas(pageNumber, null);
  }, [pageNumber, registerCanvas]);

  useEffect(() => {
    let disposed = false;
    const renderSeq = ++renderSeqRef.current;

    const render = async () => {
      if (!canvasRef.current) return;
      const page = await doc.getPage(pageNumber);
      if (disposed || renderSeq !== renderSeqRef.current || !canvasRef.current) return;

      const viewport = page.getViewport({ scale: zoomScale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize({ width: viewport.width, height: viewport.height });
      onPageMeasured(pageNumber, { width: viewport.width / zoomScale, height: viewport.height / zoomScale });

      await page.render({ canvasContext: context, viewport }).promise;
      if (disposed || renderSeq !== renderSeqRef.current) return;

      const textContent = await page.getTextContent();
      if (disposed || renderSeq !== renderSeqRef.current) return;

      const extractedText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const items: TextLayerItem[] = textContent.items
        .map((item, index): TextLayerItem | null => {
          if (!("str" in item) || !item.str) return null;
          const transform = item.transform as number[];
          const fontSize = Math.max(Math.hypot(transform[0], transform[1]) * zoomScale, 8);
          return {
            id: `pdf-${pageNumber}-${index}-${item.str}`,
            text: item.str,
            left: transform[4] * zoomScale,
            top: viewport.height - transform[5] * zoomScale - fontSize,
            fontSize,
            width: ("width" in item ? Number(item.width) : 0) * zoomScale || undefined,
            height: ("height" in item ? Number(item.height) : fontSize) * zoomScale || undefined
          };
        })
        .filter((item): item is TextLayerItem => item !== null);

      setNativeText(extractedText);
      setNativeOverlayItems(items);
      onTextExtracted(pageNumber, extractedText || ocrText || "");
      debugLogger.info(`[PDF] rendered page=${pageNumber} scale=${zoomScale.toFixed(2)} extractedChars=${extractedText.length} overlayItems=${items.length}`);
    };

    void render();
    return () => {
      disposed = true;
    };
  }, [doc, ocrText, onPageMeasured, onTextExtracted, pageNumber, zoomScale]);

  useEffect(() => {
    if (!nativeText) onTextExtracted(pageNumber, ocrText || "");
  }, [nativeText, ocrText, onTextExtracted, pageNumber]);

  return (
    <div className="relative mx-auto rounded border border-border bg-white shadow-sm" style={{ width: width || undefined, minHeight: height || undefined }}>
      <canvas ref={canvasRef} className={pdfLayerVisible ? "block" : "hidden"} />
      {textLayerVisible && (
        <div className="pdf-text-layer absolute inset-0 select-text">
          {overlayItems.map((item) => (
            <span
              key={item.id}
              className="absolute whitespace-pre"
              style={{ left: item.left, top: item.top, fontSize: item.fontSize, width: item.width, height: item.height, display: item.width ? "inline-block" : undefined, overflow: item.width ? "hidden" : undefined, lineHeight: 1 }}
            >
              {item.text}
            </span>
          ))}
        </div>
      )}
      {textLayerVisible && overlayItems.length === 0 && mergedText && (
        <div className="absolute inset-0 overflow-auto bg-white/75 p-3 text-xs leading-5 text-slate-700">
          <div className="mb-2 text-[11px] font-semibold text-slate-500">提取文本（当前页没有可定位文本层）</div>
          <div className="whitespace-pre-wrap">{mergedText}</div>
        </div>
      )}
    </div>
  );
}

export function PdfPane() {
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const translationScrollRef = useRef<HTMLDivElement | null>(null);
  const pdfPageRefs = useRef<Record<number, HTMLElement | null>>({});
  const translationCardRefs = useRef<Record<number, HTMLElement | null>>({});
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const ignoreScrollRef = useRef<null | "pdf" | "translation">(null);
  const translationQueueRef = useRef<number[]>([]);
  const translationRunningRef = useRef(false);
  const translationAbortRef = useRef<Record<number, AbortController>>({});
  const pendingModeRestoreRef = useRef<PagePosition | null>(null);

  const [openingBusy, setOpeningBusy] = useState(false);
  const [openProgress, setOpenProgress] = useState(0);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [textLayerVisible, setTextLayerVisible] = useState(true);
  const [pdfLayerVisible, setPdfLayerVisible] = useState(true);
  const [scrollLinked, setScrollLinked] = useState(true);
  const [pdfViewportPage, setPdfViewportPage] = useState(1);
  const [translationViewportPage, setTranslationViewportPage] = useState(1);
  const [zoomScale, setZoomScale] = useState(1.2);
  const [zoomInput, setZoomInput] = useState("120");
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [pageBaseSizes, setPageBaseSizes] = useState<Record<number, PageSize>>({});
  const [ocrTextByPage, setOcrTextByPage] = useState<Record<number, string>>({});
  const [ocrLayerByPage, setOcrLayerByPage] = useState<Record<number, TextLayerItem[]>>({});
  const [translationRefreshKey, setTranslationRefreshKey] = useState(0);

  const {
    totalPages,
    viewerMode,
    pdfPath,
    pageTextCache,
    pageTranslationCache,
    pageTranslationStatus,
    pdfOpenRequest,
    setCurrentPage,
    setTotalPages,
    setPdfPath,
    setPdfName,
    setViewerMode,
    setCurrentPageText,
    setCurrentPageTranslation,
    setPageTextCache,
    setPageTranslationCache,
    setPageTranslationStatus,
    restoreTranslationCacheForPdf,
    setSelectedPdfText,
    setSelectedPdfQuote,
    setTranslationQueue,
    clearPdfOpenRequest
  } = useAppStore();
  const language = useAppStore((s) => s.settings.language);

  const hasPdf = useMemo(() => !!pdfDocRef.current && totalPages > 0, [totalPages]);
  const pages = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const estimatedPageBaseSize = useMemo(() => pageBaseSizes[1] ?? Object.values(pageBaseSizes)[0] ?? DEFAULT_ESTIMATED_PAGE_SIZE, [pageBaseSizes]);
  const renderedPages = useMemo(() => {
    if (!hasPdf) return new Set<number>();
    const start = Math.max(1, pdfViewportPage - RENDER_RADIUS);
    const end = Math.min(totalPages, pdfViewportPage + RENDER_RADIUS);
    return new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index));
  }, [hasPdf, pdfViewportPage, totalPages]);
  const translationPages = useMemo(
    () =>
      pages.filter((page) => {
        const status = pageTranslationStatus[page] ?? "idle";
        return page === pdfViewportPage || page === translationViewportPage || !!pageTranslationCache[page] || status === "queued" || status === "translating" || status === "error";
      }),
    [pageTranslationCache, pageTranslationStatus, pages, pdfViewportPage, translationViewportPage]
  );

  const onTextExtracted = useCallback((page: number, text: string) => {
    const current = useAppStore.getState().pageTextCache[page] ?? "";
    if (current !== text) {
      useAppStore.getState().setPageTextCache(page, text);
    }
  }, []);

  const onPageMeasured = useCallback((page: number, size: PageSize) => {
    setPageBaseSizes((prev) => {
      const current = prev[page];
      if (current && Math.abs(current.width - size.width) < 0.5 && Math.abs(current.height - size.height) < 0.5) return prev;
      return { ...prev, [page]: size };
    });
  }, []);

  const refreshTranslationPanel = useCallback((page: number) => {
    const state = useAppStore.getState();
    setCurrentPageText(state.pageTextCache[page] ?? "");
    setCurrentPageTranslation(state.pageTranslationCache[page] ?? "");
    setTranslationViewportPage(page);
    setTranslationRefreshKey((value) => value + 1);
  }, [setCurrentPageText, setCurrentPageTranslation]);

  const syncScrollPane = useCallback((target: "pdf" | "translation", position: PagePosition) => {
    const container = target === "pdf" ? pdfScrollRef.current : translationScrollRef.current;
    const refs = target === "pdf" ? pdfPageRefs.current : translationCardRefs.current;
    const node = refs[position.page];
    if (!container || !node) return;

    const anchorRatio = target === "pdf" ? PDF_ANCHOR_RATIO : TRANSLATION_ANCHOR_RATIO;
    const anchorOffset = container.clientHeight * anchorRatio;
    const top = Math.max(0, node.offsetTop + node.offsetHeight * position.progress - anchorOffset);

    ignoreScrollRef.current = target;
    container.scrollTo({ top, behavior: "auto" });
    requestAnimationFrame(() => {
      if (ignoreScrollRef.current === target) ignoreScrollRef.current = null;
    });
  }, []);

  const enqueueTranslations = useCallback(
    (pagesToQueue: number[], force = false) => {
      const uniquePages = Array.from(new Set(pagesToQueue)).filter((page) => page >= 1 && page <= totalPages);
      const store = useAppStore.getState();
      let queued = false;

      for (const page of uniquePages) {
        const cached = store.pageTranslationCache[page];
        const text = store.pageTextCache[page];
        const status = store.pageTranslationStatus[page] ?? "idle";
        if (cached || !text) continue;
        if (!force && (status === "queued" || status === "translating" || status === "done")) continue;
        store.setPageTranslationStatus(page, "queued");
        if (!translationQueueRef.current.includes(page)) translationQueueRef.current.push(page);
        useAppStore.getState().setTranslationQueue([...translationQueueRef.current]);
        queued = true;
      }

      if (queued && !translationRunningRef.current) {
        void (async () => {
          translationRunningRef.current = true;
          setTranslationBusy(true);
          try {
            while (translationQueueRef.current.length > 0) {
              const page = translationQueueRef.current.shift();
              useAppStore.getState().setTranslationQueue([...translationQueueRef.current]);
              if (!page) continue;
              const store = useAppStore.getState();
              const text = store.pageTextCache[page];
              const status = store.pageTranslationStatus[page] ?? "idle";
              if (!text || status !== "queued" || store.pageTranslationCache[page]) continue;

              if (!force && Math.abs(page - useAppStore.getState().currentPage) > CANCEL_TRANSLATION_DISTANCE) {
                store.setPageTranslationStatus(page, "idle");
                useAppStore.getState().setTranslationQueue([...translationQueueRef.current]);
                continue;
              }

              store.setPageTranslationStatus(page, "translating");
              const controller = new AbortController();
              translationAbortRef.current[page] = controller;
              try {
                let streamedTranslation = "";
                const translated = await llmService.translatePageStream(text, {
                  signal: controller.signal,
                  onToken: (token) => {
                    streamedTranslation += token;
                    const latest = useAppStore.getState();
                    latest.setPageTranslationCache(page, streamedTranslation);
                    if (latest.currentPage === page) latest.setCurrentPageTranslation(streamedTranslation);
                  }
                });
                const latest = useAppStore.getState();
                if (controller.signal.aborted || latest.pageTranslationStatus[page] !== "translating") continue;
                latest.setPageTranslationCache(page, translated);
                latest.setPageTranslationStatus(page, "done");
                if (latest.currentPage === page) latest.setCurrentPageTranslation(translated);
              } catch (error) {
                const latest = useAppStore.getState();
                const name = error instanceof Error ? error.name : String(error);
                if (controller.signal.aborted || name === "AbortError") {
                  latest.setPageTranslationStatus(page, "idle");
                  continue;
                }
                latest.setPageTranslationStatus(page, "error");
              } finally {
                delete translationAbortRef.current[page];
              }
            }
          } finally {
            translationRunningRef.current = false;
            setTranslationBusy(false);
          }
        })();
      }
    },
    [totalPages]
  );

  useEffect(() => {
    setZoomInput(String(Math.round(zoomScale * 100)));
  }, [zoomScale]);

  useEffect(() => {
    setPageJumpInput(String(pdfViewportPage));
    setCurrentPage(pdfViewportPage);
    setCurrentPageText(pageTextCache[pdfViewportPage] ?? "");
    setCurrentPageTranslation(pageTranslationCache[pdfViewportPage] ?? "");
  }, [pageTextCache, pageTranslationCache, pdfViewportPage, setCurrentPage, setCurrentPageText, setCurrentPageTranslation]);

  useEffect(() => {
    setTranslationViewportPage(1);
    setTranslationRefreshKey((value) => value + 1);
    if (!pdfPath) {
      setCurrentPageText("");
      setCurrentPageTranslation("");
    }
  }, [pdfPath, setCurrentPageText, setCurrentPageTranslation]);

  useEffect(() => {
    if (!hasPdf || viewerMode !== "dual") return;
    enqueueTranslations([pdfViewportPage - QUEUE_RADIUS, pdfViewportPage, pdfViewportPage + QUEUE_RADIUS]);
  }, [enqueueTranslations, hasPdf, pdfViewportPage, viewerMode]);

  useEffect(() => {
    const minPage = Math.max(1, pdfViewportPage - CANCEL_TRANSLATION_DISTANCE);
    const maxPage = Math.min(totalPages, pdfViewportPage + CANCEL_TRANSLATION_DISTANCE);

    translationQueueRef.current = translationQueueRef.current.filter((page) => {
      const keep = page >= minPage && page <= maxPage;
      if (!keep && (useAppStore.getState().pageTranslationStatus[page] ?? "idle") === "queued") {
        useAppStore.getState().setPageTranslationStatus(page, "idle");
      }
      return keep;
    });
    useAppStore.getState().setTranslationQueue([...translationQueueRef.current]);

    for (const [pageKey, controller] of Object.entries(translationAbortRef.current)) {
      const page = Number(pageKey);
      if (page < minPage || page > maxPage) controller.abort();
    }
  }, [pdfViewportPage, totalPages]);

  useEffect(() => {
    if (!pendingModeRestoreRef.current) return;
    const position = pendingModeRestoreRef.current;
    const frame = requestAnimationFrame(() => {
      syncScrollPane("pdf", position);
      if (viewerMode === "dual" && scrollLinked) {
        setTranslationViewportPage(position.page);
        syncScrollPane("translation", position);
      }
      pendingModeRestoreRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollLinked, syncScrollPane, viewerMode]);

  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlPressed(true);
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlPressed(false);
    };
    const selectListener = () => {
      const selected = window.getSelection()?.toString().trim();
      if (selected) {
        const state = useAppStore.getState();
        setSelectedPdfText(selected);
        setSelectedPdfQuote({
          text: selected,
          page: state.currentPage,
          pdfPath: state.pdfPath,
          pdfName: state.pdfName
        });
      }
    };

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    document.addEventListener("mouseup", selectListener);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      document.removeEventListener("mouseup", selectListener);
    };
  }, [setSelectedPdfQuote, setSelectedPdfText]);

  useEffect(() => {
    return () => {
      Object.values(translationAbortRef.current).forEach((controller) => controller.abort());
    };
  }, []);

  useEffect(() => {
    const onOcrRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: number }>).detail;
      const page = clamp(detail?.page ?? pdfViewportPage, 1, totalPages || 1);
      goToPage(page);
      requestAnimationFrame(() => {
        void runOcr();
      });
    };
    window.addEventListener("agent:ocr-request", onOcrRequest as EventListener);
    return () => window.removeEventListener("agent:ocr-request", onOcrRequest as EventListener);
  }, [pdfViewportPage, totalPages]);

  const loadPdfFromPath = useCallback(async (path: string, options?: { preserveState?: boolean; targetPage?: number; forceReload?: boolean }) => {
    const sameDocument = !!pdfPath && path === pdfPath;
    const shouldPreserveState = !!options?.preserveState && sameDocument;

    if (!options?.forceReload && pdfDocRef.current && sameDocument) {
      const targetPage = clamp(options?.targetPage ?? pdfViewportPage, 1, totalPages || pdfViewportPage || 1);
      setPdfViewportPage(targetPage);
      setTranslationViewportPage(targetPage);
      setCurrentPage(targetPage);
      refreshTranslationPanel(targetPage);
      requestAnimationFrame(() => {
        syncScrollPane("pdf", { page: targetPage, progress: 0 });
        if (viewerMode === "dual" && scrollLinked) {
          syncScrollPane("translation", { page: targetPage, progress: 0 });
        }
      });
      return;
    }

    setOpeningBusy(true);
    setOpenProgress(0);
    try {
      const pdfjs = await getPdfJs();
      const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
      const loadingTask = pdfjs.getDocument({ data: bytes });
      loadingTask.onProgress = (progress: { loaded: number; total?: number }) => {
        if (!progress.total) return;
        setOpenProgress(Math.round((progress.loaded / progress.total) * 100));
      };
      const doc = await loadingTask.promise;
      pdfDocRef.current = doc;
      pdfPageRefs.current = {};
      translationCardRefs.current = {};
      canvasRefs.current = {};
      Object.values(translationAbortRef.current).forEach((controller) => controller.abort());
      translationAbortRef.current = {};
      translationQueueRef.current = [];
      setTranslationQueue([]);
      setTranslationRefreshKey((value) => value + 1);
      setOcrTextByPage({});
      setOcrLayerByPage({});
      const firstPage = await doc.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });
      setPageBaseSizes({
        1: { width: firstViewport.width, height: firstViewport.height }
      });
      setPdfPath(path);
      setPdfName(path.split(/[\\/]/).pop() ?? path);
      restoreTranslationCacheForPdf(path, path.split(/[\\/]/).pop() ?? path);
      setTotalPages(doc.numPages);
      const targetPage = clamp(options?.targetPage ?? 1, 1, doc.numPages);
      setPdfViewportPage(targetPage);
      setTranslationViewportPage(targetPage);
      setCurrentPage(targetPage);
      refreshTranslationPanel(targetPage);
      setZoomScale(1.2);
      debugLogger.info(`[PDF] opened file=${path} docPages=${doc.numPages} lazySizes=enabled`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogger.error(`[PDF] open failed: ${message}`);
    } finally {
      setOpenProgress(100);
      setOpeningBusy(false);
    }
  }, [
    pdfPath,
    pdfViewportPage,
    refreshTranslationPanel,
    restoreTranslationCacheForPdf,
    scrollLinked,
    setCurrentPage,
    setCurrentPageText,
    setCurrentPageTranslation,
    setPdfName,
    setPdfPath,
    setTranslationQueue,
    setTotalPages,
    syncScrollPane,
    totalPages,
    viewerMode
  ]);

  useEffect(() => {
    if (!pdfOpenRequest) return;
    void loadPdfFromPath(pdfOpenRequest.path, {
      preserveState: pdfOpenRequest.preserveState,
      targetPage: pdfOpenRequest.targetPage
    }).finally(() => {
      useAppStore.getState().clearPdfOpenRequest();
    });
  }, [clearPdfOpenRequest, loadPdfFromPath, pdfOpenRequest]);

  useEffect(() => {
    const onRefreshRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string }>).detail;
      if (!detail?.target) return;

      if (detail.target === "pdf" || detail.target === "cache") {
        if (pdfPath) {
          void loadPdfFromPath(pdfPath, {
            preserveState: true,
            targetPage: useAppStore.getState().currentPage,
            forceReload: true
          });
        }
        refreshTranslationPanel(useAppStore.getState().currentPage);
        return;
      }

      if (detail.target === "agent") {
        refreshTranslationPanel(useAppStore.getState().currentPage);
      }
    };

    window.addEventListener("agent:refresh", onRefreshRequest as EventListener);
    return () => window.removeEventListener("agent:refresh", onRefreshRequest as EventListener);
  }, [loadPdfFromPath, pdfPath, refreshTranslationPanel]);

  const runOcr = async () => {
    const canvas = canvasRefs.current[pdfViewportPage];
    if (!canvas) return;

    setOcrBusy(true);
    try {
      const { text, confidence, words } = await ocrService.recognizeCanvas(canvas);
      const finalText = text || "OCR 未识别到文本。";
      const overlay = words
        .map((word, index) => ({
          id: `ocr-${pdfViewportPage}-${index}-${word.text}`,
          text: word.text,
          left: word.left,
          top: word.top,
          fontSize: Math.max(8, Math.min(36, word.height * 0.9)),
          width: word.width,
          height: word.height
        }))
        .filter((word) => word.text);

      setOcrTextByPage((prev) => ({ ...prev, [pdfViewportPage]: finalText }));
      setOcrLayerByPage((prev) => ({ ...prev, [pdfViewportPage]: overlay }));
      setPageTextCache(pdfViewportPage, finalText);
      debugLogger.info(`[OCR] page=${pdfViewportPage} confidence=${confidence.toFixed(2)} textChars=${text.length} words=${words.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogger.error(`[OCR] failed page=${pdfViewportPage}: ${message}`);
    } finally {
      setOcrBusy(false);
    }
  };

  const onPdfWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!ctrlPressed) return;
    e.preventDefault();
    setZoomScale((prev) => clamp(Number((prev + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)), 0.6, 3));
  };

  const applyZoomInput = () => {
    const parsed = Number(zoomInput);
    if (!Number.isFinite(parsed)) return setZoomInput(String(Math.round(zoomScale * 100)));
    setZoomScale(clamp(parsed / 100, 0.6, 3));
  };

  const goToPage = (page: number) => {
    const target = clamp(page, 1, totalPages || 1);
    const position = { page: target, progress: 0 };
    setPdfViewportPage(target);
    setCurrentPage(target);
    syncScrollPane("pdf", position);
    if (viewerMode === "dual" && scrollLinked) {
      setTranslationViewportPage(target);
      syncScrollPane("translation", position);
    }
  };

  const jumpToPage = () => {
    const parsed = Number(pageJumpInput);
    if (!Number.isFinite(parsed)) return setPageJumpInput(String(pdfViewportPage));
    goToPage(Math.round(parsed));
  };

  const switchViewerMode = (mode: "single" | "dual") => {
    if (mode === viewerMode) return;
    const container = pdfScrollRef.current;
    if (container) pendingModeRestoreRef.current = getPagePositionAtAnchor(container, pdfPageRefs, PDF_ANCHOR_RATIO);
    setViewerMode(mode);
  };

  const handlePdfScroll = () => {
    const container = pdfScrollRef.current;
    if (!container || ignoreScrollRef.current === "pdf") return;
    const position = getPagePositionAtAnchor(container, pdfPageRefs, PDF_ANCHOR_RATIO);
    setPdfViewportPage(position.page);
    setCurrentPage(position.page);
    if (viewerMode === "dual" && scrollLinked) {
      setTranslationViewportPage(position.page);
      syncScrollPane("translation", position);
    }
  };

  const handleTranslationScroll = () => {
    const container = translationScrollRef.current;
    if (!container || ignoreScrollRef.current === "translation") return;
    const position = getPagePositionAtAnchor(container, translationCardRefs, TRANSLATION_ANCHOR_RATIO);
    setTranslationViewportPage(position.page);
    if (scrollLinked) {
      setPdfViewportPage(position.page);
      setCurrentPage(position.page);
      syncScrollPane("pdf", position);
    }
  };

  const statusLabel = (status: TranslationStatus) => {
    if (status === "queued") return t(language, "queued");
    if (status === "translating") return t(language, "translating");
    if (status === "done") return t(language, "done");
    if (status === "error") return t(language, "error");
    return t(language, "idle");
  };

  const toolbar = (
    <div className="flex items-center justify-between border-t border-border px-2 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span>{t(language, "page")}: {totalPages ? `${pdfViewportPage}/${totalPages}` : "-"}</span>
        <span>{t(language, "jump")}</span>
        <input
          className="w-14 rounded border border-border bg-white px-1 py-1 text-center"
          value={pageJumpInput}
          onChange={(e) => setPageJumpInput(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={jumpToPage}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              jumpToPage();
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={!hasPdf || openingBusy || ocrBusy}
        />
      </div>
      <div className="flex items-center gap-2">
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => setScrollLinked((value) => !value)} disabled={!hasPdf || viewerMode !== "dual"}>
          {scrollLinked ? t(language, "unlinkScroll") : t(language, "linkScroll")}
        </button>
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => setZoomScale((value) => clamp(value - 0.1, 0.6, 3))} disabled={!hasPdf || openingBusy || ocrBusy}>
          -
        </button>
        <input
          className="w-14 rounded border border-border bg-white px-1 py-1 text-center"
          value={zoomInput}
          onChange={(e) => setZoomInput(e.target.value.replace(/[^0-9.]/g, ""))}
          onBlur={applyZoomInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              applyZoomInput();
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={!hasPdf || openingBusy || ocrBusy}
        />
        <span>%</span>
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => setZoomScale((value) => clamp(value + 0.1, 0.6, 3))} disabled={!hasPdf || openingBusy || ocrBusy}>
          +
        </button>
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={runOcr} disabled={!hasPdf || openingBusy || ocrBusy}>
          {ocrBusy ? t(language, "ocrBusy") : t(language, "ocr")}
        </button>
      </div>
    </div>
  );

  const pdfPages = (
    <div className="space-y-4">
      {pages.map((page) => (
        <div key={page} ref={(node) => (pdfPageRefs.current[page] = node)} className="space-y-2">
          <div className="sticky top-0 z-10 mx-auto w-fit rounded-full border border-border bg-white/90 px-3 py-1 text-xs text-slate-600 shadow-sm">第 {page} 页</div>
          {renderedPages.has(page) ? (
            <PageView
              doc={pdfDocRef.current!}
              pageNumber={page}
              zoomScale={zoomScale}
              textLayerVisible={textLayerVisible}
              pdfLayerVisible={pdfLayerVisible}
              ocrText={ocrTextByPage[page] ?? ""}
              ocrLayerItems={ocrLayerByPage[page] ?? []}
              pageBaseSize={pageBaseSizes[page]}
              onPageMeasured={onPageMeasured}
              onTextExtracted={onTextExtracted}
              registerCanvas={(pageNo, canvas) => {
                canvasRefs.current[pageNo] = canvas;
              }}
            />
          ) : (
            <div
              className="mx-auto rounded border border-dashed border-slate-300 bg-white/70"
              style={{
                width: (pageBaseSizes[page] ?? estimatedPageBaseSize).width * zoomScale,
                height: (pageBaseSizes[page] ?? estimatedPageBaseSize).height * zoomScale
              }}
            />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <section className="app-panel flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-semibold">{t(language, "pdfPane")}</div>
        <div className="flex gap-2">
          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => switchViewerMode("single")} disabled={viewerMode === "single"}>{t(language, "singleMode")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => switchViewerMode("dual")} disabled={viewerMode === "dual"}>{t(language, "dualMode")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs" onClick={() => setTextLayerVisible((value) => !value)}>{textLayerVisible ? t(language, "hideTextLayer") : t(language, "showTextLayer")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs" onClick={() => setPdfLayerVisible((value) => !value)}>{pdfLayerVisible ? t(language, "hidePdfLayer") : t(language, "showPdfLayer")}</button>
        </div>
      </header>
      {openingBusy && (
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
            <span>{t(language, "loadingPdf")}</span>
            <span>{openProgress}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200">
            <div className="h-2 rounded-full transition-all" style={{ width: `${openProgress}%`, background: "var(--accent-color)" }} />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 p-2">
        {!hasPdf && <div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "noPdf")}</div>}

        {hasPdf && viewerMode === "single" && (
          <div className="flex h-full min-h-0 flex-col">
            <div
              ref={pdfScrollRef}
              className={`pdf-scroll min-h-0 flex-1 overflow-auto rounded border border-border p-3 ${pdfLayerVisible ? "bg-slate-100" : "bg-white"}`}
              onWheel={onPdfWheel}
              onScroll={handlePdfScroll}
            >
              {pdfPages}
            </div>
            {toolbar}
          </div>
        )}

        {hasPdf && viewerMode === "dual" && (
          <PanelGroup direction="vertical" className="h-full">
            <Panel defaultSize={54} minSize={20}>
              <div
                ref={pdfScrollRef}
                className={`pdf-scroll h-full overflow-auto rounded border border-border p-3 ${pdfLayerVisible ? "bg-slate-100" : "bg-white"}`}
                onWheel={onPdfWheel}
                onScroll={handlePdfScroll}
              >
                {pdfPages}
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-y" />
            <div>{toolbar}</div>
            <Panel defaultSize={46} minSize={20}>
              <div key={`translation-${pdfPath || "none"}-${translationRefreshKey}`} ref={translationScrollRef} className="h-full overflow-auto rounded border border-border bg-white p-3" onScroll={handleTranslationScroll}>
                <div className="mb-3 flex items-center justify-between rounded border border-border bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <div>连续翻译列表，按页同步滚动</div>
                  <div>{translationBusy ? "队列处理中" : "队列空闲"}</div>
                </div>
                <div className="space-y-4">
                  {translationPages.map((page) => {
                    const status = pageTranslationStatus[page] ?? "idle";
                    const translation = pageTranslationCache[page] ?? "";
                    return (
                      <section
                        key={page}
                        ref={(node) => (translationCardRefs.current[page] = node)}
                        className={`rounded border p-3 ${page === translationViewportPage ? "bg-sky-50/40" : "border-border bg-white"}`}
                        style={page === translationViewportPage ? { borderColor: "var(--accent-color)", backgroundColor: "var(--accent-soft)" } : undefined}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">第 {page} 页</div>
                            <div className="text-xs text-slate-500">状态: {statusLabel(status)}</div>
                          </div>
                          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => enqueueTranslations([page], true)} disabled={!pageTextCache[page] || status === "translating"}>
                            {status === "translating" ? "翻译中..." : translation ? "重新翻译" : "翻译"}
                          </button>
                        </div>
                        {translation ? (
                          <article className="markdown-preview text-slate-700">
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{translation}</ReactMarkdown>
                          </article>
                        ) : (
                          <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-500">
                            {status === "queued" ? "这一页已进入翻译队列。" : status === "translating" ? "正在翻译这一页..." : status === "error" ? "翻译失败，可点击本页按钮重试。" : !pageTextCache[page] ? "当前页文本尚未提取。滚动到该页后会自动提取，必要时可手动执行 OCR。" : "这一页尚未翻译，滚动到当前页后会自动排队。"}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        )}
      </div>
    </section>
  );
}
