import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type WheelEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { debugLogger } from "../../services/debugLogger";
import { llmService } from "../../services/llmService";
import { ocrService } from "../../services/ocrService";
import { RichMarkdown } from "../markdown/RichMarkdown";
import { useAppStore } from "../../stores/appStore";
import { TranslationPageMetrics, TranslationStatus } from "../../types";
import { t } from "../../i18n";
import { extractSelectionMarkdown, isSelectionInside } from "../../utils/selectionMarkdown";

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
type PositionedElement = { page: number; node: HTMLElement; top: number; bottom: number; height: number; center: number };
const QUEUE_RADIUS = 1;
const RENDER_RADIUS = 2;
const CANCEL_TRANSLATION_DISTANCE = 3;
const VIEWPORT_CENTER_RATIO = 0.5;
const DEFAULT_ESTIMATED_PAGE_SIZE: PageSize = { width: 816, height: 1056 };
const DEFAULT_TRANSLATION_CARD_HEIGHT = 196;
const DEFAULT_TRANSLATION_CONTENT_HEIGHT = 128;
const TRANSLATION_CARD_CHROME_HEIGHT = 68;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const roundMetric = (value: number) => Math.round(value * 10) / 10;

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

const getTopWithinScrollContainer = (node: HTMLElement, container: HTMLElement) => {
  const nodeRect = node.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return nodeRect.top - containerRect.top + container.scrollTop;
};

const deriveDefaultTranslationMetrics = (pdfSize?: Partial<TranslationPageMetrics> | PageSize | null) => {
  const pdfHeight = pdfSize && "height" in pdfSize ? pdfSize.height : pdfSize && "pdfHeight" in pdfSize ? pdfSize.pdfHeight : 0;
  const cardHeight = clamp(pdfHeight ? pdfHeight * 0.28 : DEFAULT_TRANSLATION_CARD_HEIGHT, 168, 340);
  return {
    translationCardHeight: roundMetric(cardHeight),
    translationContentHeight: roundMetric(Math.max(DEFAULT_TRANSLATION_CONTENT_HEIGHT, cardHeight - TRANSLATION_CARD_CHROME_HEIGHT))
  };
};

const getPositionedElements = (
  container: HTMLDivElement,
  refs: MutableRefObject<Record<number, HTMLElement | null>>
): PositionedElement[] =>
  Object.entries(refs.current)
    .map(([key, node]) => [Number(key), node] as const)
    .filter((entry): entry is readonly [number, HTMLElement] => entry[1] !== null)
    .map(([page, node]) => {
      const top = getTopWithinScrollContainer(node, container);
      const height = Math.max(1, node.offsetHeight);
      const bottom = top + height;
      return { page, node, top, bottom, height, center: top + height / 2 };
    })
    .sort((a, b) => a.page - b.page);

function captureViewportPosition(container: HTMLDivElement, refs: MutableRefObject<Record<number, HTMLElement | null>>): PagePosition {
  const active = getActiveViewportEntry(container, refs);
  if (!active) return { page: 1, progress: 0 };

  const viewportCenter = container.scrollTop + container.clientHeight * VIEWPORT_CENTER_RATIO;
  return {
    page: active.page,
    progress: clamp((viewportCenter - active.top) / active.height, 0, 1)
  };
}

function getActiveViewportEntry(container: HTMLDivElement, refs: MutableRefObject<Record<number, HTMLElement | null>>) {
  const entries = getPositionedElements(container, refs);
  if (entries.length === 0) return null;

  const viewportTop = container.scrollTop;
  const viewportBottom = viewportTop + container.clientHeight;
  const viewportCenter = viewportTop + container.clientHeight * VIEWPORT_CENTER_RATIO;

  let active = entries[0];
  let bestOverlap = -1;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    const overlap = Math.max(0, Math.min(entry.bottom, viewportBottom) - Math.max(entry.top, viewportTop));
    const centerDistance = Math.abs(entry.center - viewportCenter);
    if (overlap > bestOverlap || (overlap === bestOverlap && centerDistance < bestCenterDistance)) {
      active = entry;
      bestOverlap = overlap;
      bestCenterDistance = centerDistance;
    }
  }

  return active;
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
    <div className="pdf-page-shell relative mx-auto rounded border border-border shadow-sm" style={{ width: width || undefined, minHeight: height || undefined }}>
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
  const paneRef = useRef<HTMLElement | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const translationScrollRef = useRef<HTMLDivElement | null>(null);
  const pdfPageRefs = useRef<Record<number, HTMLElement | null>>({});
  const pdfPageContentRefs = useRef<Record<number, HTMLElement | null>>({});
  const translationCardRefs = useRef<Record<number, HTMLElement | null>>({});
  const translationCardContentRefs = useRef<Record<number, HTMLElement | null>>({});
  const translationCardMeasureRefs = useRef<Record<number, HTMLElement | null>>({});
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const ignoreScrollRef = useRef<null | "pdf" | "translation">(null);
  const translationQueueRef = useRef<number[]>([]);
  const translationForceRef = useRef<Record<number, boolean>>({});
  const translationRunningRef = useRef(false);
  const translationAbortRef = useRef<Record<number, AbortController>>({});
  const pendingModeRestoreRef = useRef<PagePosition | null>(null);
  const pendingZoomRestoreRef = useRef<PagePosition | null>(null);
  const pendingTranslationRestoreRef = useRef<PagePosition | null>(null);
  const pdfScrollPositionRef = useRef<PagePosition>({ page: 1, progress: 0 });
  const translationScrollPositionRef = useRef<PagePosition>({ page: 1, progress: 0 });

  const [openingBusy, setOpeningBusy] = useState(false);
  const [openProgress, setOpenProgress] = useState(0);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [pdfViewportPage, setPdfViewportPage] = useState(1);
  const [translationViewportPage, setTranslationViewportPage] = useState(1);
  const [zoomInput, setZoomInput] = useState("120");
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [pageBaseSizes, setPageBaseSizes] = useState<Record<number, PageSize>>({});
  const [ocrTextByPage, setOcrTextByPage] = useState<Record<number, string>>({});
  const [ocrLayerByPage, setOcrLayerByPage] = useState<Record<number, TextLayerItem[]>>({});
  const [translationRefreshKey, setTranslationRefreshKey] = useState(0);
  const {
    totalPages,
    viewerMode,
    pdfViewState,
    pdfPath,
    pageTextCache,
    pageTranslationCache,
    pageTranslationStatus,
    pageTranslationMetrics,
    pdfViewDocuments,
    pdfOpenRequest,
    setCurrentPage,
    setTotalPages,
    setPdfPath,
    setPdfName,
    setViewerMode,
    setPdfViewState,
    setCurrentPageText,
    setCurrentPageTranslation,
    setPageTextCache,
    setPageTranslationCache,
    setPageTranslationStatus,
    setPageTranslationMetrics,
    restoreTranslationCacheForPdf,
    setSelectedPdfText,
    setSelectedPdfQuote,
    setTranslationQueue,
    clearPdfOpenRequest
  } = useAppStore();
  const language = useAppStore((s) => s.settings.language);

  const { zoomScale, textLayerVisible, pdfLayerVisible, scrollLinked } = pdfViewState;
  const hasPdf = useMemo(() => !!pdfDocRef.current && totalPages > 0, [totalPages]);
  const pages = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const estimatedPageBaseSize = useMemo(() => pageBaseSizes[1] ?? Object.values(pageBaseSizes)[0] ?? DEFAULT_ESTIMATED_PAGE_SIZE, [pageBaseSizes]);
  const renderedPages = useMemo(() => {
    if (!hasPdf) return new Set<number>();
    const start = Math.max(1, pdfViewportPage - RENDER_RADIUS);
    const end = Math.min(totalPages, pdfViewportPage + RENDER_RADIUS);
    return new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index));
  }, [hasPdf, pdfViewportPage, totalPages]);
  const translationPages = useMemo(() => pages, [pages]);
  const getPageMetric = useCallback(
    (page: number) => {
      const metric = pageTranslationMetrics[page];
      const pdfSize = pageBaseSizes[page];
      const derived = deriveDefaultTranslationMetrics(metric ?? pdfSize ?? estimatedPageBaseSize);
      return {
        pdfWidth: metric?.pdfWidth ?? pdfSize?.width ?? estimatedPageBaseSize.width,
        pdfHeight: metric?.pdfHeight ?? pdfSize?.height ?? estimatedPageBaseSize.height,
        translationCardHeight: metric?.translationCardHeight ?? derived.translationCardHeight,
        translationContentHeight: metric?.translationContentHeight ?? derived.translationContentHeight
      };
    },
    [estimatedPageBaseSize, pageBaseSizes, pageTranslationMetrics]
  );

  const measureTranslationCard = useCallback(
    (page: number) => {
      const root = translationScrollRef.current;
      const cardNode = root?.querySelector<HTMLElement>(`[data-translation-card="${page}"]`) ?? translationCardRefs.current[page];
      const contentNode = root?.querySelector<HTMLElement>(`[data-translation-content="${page}"]`) ?? translationCardContentRefs.current[page];
      const measureNode = root?.querySelector<HTMLElement>(`[data-translation-measure="${page}"]`) ?? translationCardMeasureRefs.current[page];
      if (!cardNode || !contentNode || !measureNode) return;

      const contentHeight = roundMetric(Math.max(measureNode.getBoundingClientRect().height, measureNode.scrollHeight, DEFAULT_TRANSLATION_CONTENT_HEIGHT));
      const rawChrome = roundMetric(cardNode.getBoundingClientRect().height - contentNode.getBoundingClientRect().height);
      const chromeHeight = rawChrome > 24 && rawChrome < 220 ? rawChrome : TRANSLATION_CARD_CHROME_HEIGHT;
      const cardHeight = roundMetric(Math.max(DEFAULT_TRANSLATION_CONTENT_HEIGHT + chromeHeight, contentHeight + chromeHeight));
      const metric = getPageMetric(page);

      if (
        Math.abs(metric.translationCardHeight - cardHeight) >= 0.5 ||
        Math.abs(metric.translationContentHeight - contentHeight) >= 0.5
      ) {
        setPageTranslationMetrics(page, {
          translationCardHeight: cardHeight,
          translationContentHeight: contentHeight
        });
      }
    },
    [getPageMetric, setPageTranslationMetrics]
  );

  const syncScrollPane = useCallback((target: "pdf" | "translation", position: PagePosition) => {
    const container = target === "pdf" ? pdfScrollRef.current : translationScrollRef.current;
    const refs = target === "pdf" ? pdfPageRefs : translationCardRefs;
    if (!container) return;
    const entry = getPositionedElements(container, refs).find((item) => item.page === position.page);
    if (!entry) return;

    const anchorOffset = container.clientHeight * VIEWPORT_CENTER_RATIO;
    const top = Math.max(0, entry.top + entry.height * position.progress - anchorOffset);

    ignoreScrollRef.current = target;
    if (target === "pdf") {
      pdfScrollPositionRef.current = position;
    } else {
      translationScrollPositionRef.current = position;
    }
    container.scrollTo({ top, behavior: "auto" });
    requestAnimationFrame(() => {
      if (ignoreScrollRef.current === target) ignoreScrollRef.current = null;
    });
  }, []);

  const updateZoomScale = useCallback(
    (next: number | ((current: number) => number)) => {
      if (!hasPdf) return;
      pendingZoomRestoreRef.current = pdfScrollPositionRef.current;
      const resolved = typeof next === "function" ? next(useAppStore.getState().pdfViewState.zoomScale) : next;
      setPdfViewState({ zoomScale: clamp(Number(resolved.toFixed(2)), 0.6, 3) });
    },
    [hasPdf, setPdfViewState]
  );

  const onTextExtracted = useCallback((page: number, text: string) => {
    const current = useAppStore.getState().pageTextCache[page] ?? "";
    if (current !== text) {
      useAppStore.getState().setPageTextCache(page, text);
    }
  }, []);

  const ensurePageText = useCallback(
    async (page: number) => {
      const cached = useAppStore.getState().pageTextCache[page] ?? "";
      if (cached.trim()) return cached;
      if (!pdfDocRef.current || page < 1 || page > pdfDocRef.current.numPages) return "";

      const pdfPage = await pdfDocRef.current.getPage(page);
      const textContent = await pdfPage.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      useAppStore.getState().setPageTextCache(page, pageText);
      return pageText;
    },
    [setPageTextCache]
  );

  const onPageMeasured = useCallback((page: number, size: PageSize) => {
    setPageBaseSizes((prev) => {
      const current = prev[page];
      if (current && Math.abs(current.width - size.width) < 0.5 && Math.abs(current.height - size.height) < 0.5) return prev;
      return { ...prev, [page]: size };
    });
    const currentMetric = useAppStore.getState().pageTranslationMetrics[page];
    const derived = deriveDefaultTranslationMetrics(size);
    setPageTranslationMetrics(page, {
      pdfWidth: roundMetric(size.width),
      pdfHeight: roundMetric(size.height),
      translationCardHeight: currentMetric?.translationCardHeight ?? derived.translationCardHeight,
      translationContentHeight: currentMetric?.translationContentHeight ?? derived.translationContentHeight
    });
  }, [setPageTranslationMetrics]);

  const refreshTranslationPanel = useCallback(
    (page: number, translationPage?: number) => {
      const state = useAppStore.getState();
      setCurrentPageText(state.pageTextCache[page] ?? "");
      setCurrentPageTranslation(state.pageTranslationCache[page] ?? "");
      setTranslationViewportPage(translationPage ?? page);
      setTranslationRefreshKey((value) => value + 1);
    },
    [setCurrentPageText, setCurrentPageTranslation]
  );

  const goToPage = useCallback(
    (page: number) => {
      const target = clamp(page, 1, totalPages || 1);
      const position = { page: target, progress: 0 };
      pdfScrollPositionRef.current = position;
      translationScrollPositionRef.current = position;
      setPdfViewportPage(target);
      setCurrentPage(target);
      syncScrollPane("pdf", position);
      if (viewerMode === "dual" && scrollLinked) {
        setTranslationViewportPage(target);
        syncScrollPane("translation", position);
      }
    },
    [scrollLinked, setCurrentPage, syncScrollPane, totalPages, viewerMode]
  );

  const runOcr = useCallback(async () => {
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
  }, [pdfViewportPage, setPageTextCache]);

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
    if (!Object.keys(pageTranslationMetrics).length) return;
    setPageBaseSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [pageKey, metric] of Object.entries(pageTranslationMetrics)) {
        const page = Number(pageKey);
        if (!metric?.pdfWidth || !metric?.pdfHeight) continue;
        const current = next[page];
        if (current && Math.abs(current.width - metric.pdfWidth) < 0.5 && Math.abs(current.height - metric.pdfHeight) < 0.5) continue;
        next[page] = { width: metric.pdfWidth, height: metric.pdfHeight };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [pageTranslationMetrics]);

  const enqueueTranslations = useCallback(
    (pagesToQueue: number[], force = false) => {
      const uniquePages = Array.from(new Set(pagesToQueue)).filter((page) => page >= 1 && page <= totalPages);
      const store = useAppStore.getState();
      let queued = false;

      for (const page of uniquePages) {
        const cached = store.pageTranslationCache[page];
        const text = store.pageTextCache[page];
        const status = store.pageTranslationStatus[page] ?? "idle";
        if (!text) continue;
        if (!force && cached) continue;
        if ((!force && (status === "queued" || status === "translating" || status === "done")) || status === "translating") continue;
        store.setPageTranslationStatus(page, "queued");
        translationForceRef.current[page] = force || translationForceRef.current[page] || false;
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
              const latest = useAppStore.getState();
              const text = latest.pageTextCache[page];
              const forcePage = translationForceRef.current[page] ?? false;
              const status = latest.pageTranslationStatus[page] ?? "idle";
              delete translationForceRef.current[page];
              if (!text || status !== "queued" || (!forcePage && latest.pageTranslationCache[page])) continue;

              if (!forcePage && Math.abs(page - useAppStore.getState().currentPage) > CANCEL_TRANSLATION_DISTANCE) {
                latest.setPageTranslationStatus(page, "idle");
                useAppStore.getState().setTranslationQueue([...translationQueueRef.current]);
                continue;
              }

              latest.setPageTranslationStatus(page, "translating");
              if (forcePage) {
                latest.setPageTranslationCache(page, "");
                if (latest.currentPage === page) latest.setCurrentPageTranslation("");
              }
              const controller = new AbortController();
              translationAbortRef.current[page] = controller;

              let streamedTranslation = "";
              let pendingFrame = 0;
              const flushStream = () => {
                pendingFrame = 0;
                const state = useAppStore.getState();
                state.setPageTranslationCache(page, streamedTranslation);
                if (state.currentPage === page) state.setCurrentPageTranslation(streamedTranslation);
              };
              const scheduleFlush = () => {
                if (pendingFrame) return;
                pendingFrame = requestAnimationFrame(flushStream);
              };

              try {
                const translated = await llmService.translatePageBySettings(text, {
                  signal: controller.signal,
                  onToken: (token) => {
                    streamedTranslation += token;
                    scheduleFlush();
                  }
                });
                if (pendingFrame) {
                  cancelAnimationFrame(pendingFrame);
                  flushStream();
                }
                const state = useAppStore.getState();
                if (controller.signal.aborted || state.pageTranslationStatus[page] !== "translating") continue;
                state.setPageTranslationCache(page, translated);
                state.setPageTranslationStatus(page, "done");
                if (state.currentPage === page) state.setCurrentPageTranslation(translated);
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    measureTranslationCard(page);
                  });
                });
              } catch (error) {
                if (pendingFrame) cancelAnimationFrame(pendingFrame);
                const state = useAppStore.getState();
                const name = error instanceof Error ? error.name : String(error);
                if (controller.signal.aborted || name === "AbortError") {
                  state.setPageTranslationStatus(page, "idle");
                  continue;
                }
                state.setPageTranslationStatus(page, "error");
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
    [measureTranslationCard, totalPages]
  );

  const requestTranslation = useCallback(
    async (page: number, force = false) => {
      await ensurePageText(page);
      enqueueTranslations([page], force);
    },
    [enqueueTranslations, ensurePageText]
  );

  useEffect(() => {
    if (viewerMode !== "dual") return;

      const observers: ResizeObserver[] = [];
    const frames: number[] = [];
    const scheduleMeasure = (page: number) => {
      const frame = requestAnimationFrame(() => measureTranslationCard(page));
      frames.push(frame);
    };

    for (const page of translationPages) {
      scheduleMeasure(page);
      const measureNode = translationCardMeasureRefs.current[page];
      if (!measureNode) continue;

      const observer = new ResizeObserver(() => {
        scheduleMeasure(page);
      });
      observer.observe(measureNode);
      observers.push(observer);
    }

    return () => {
      for (const observer of observers) observer.disconnect();
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [measureTranslationCard, pageTranslationCache, pageTranslationStatus, translationPages, translationRefreshKey, viewerMode]);

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
    if (!pendingZoomRestoreRef.current) return;
    const position = pendingZoomRestoreRef.current;
    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        syncScrollPane("pdf", position);
        if (viewerMode === "dual" && scrollLinked) {
          syncScrollPane("translation", position);
        }
        pendingZoomRestoreRef.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
  }, [scrollLinked, syncScrollPane, viewerMode, zoomScale]);

  useEffect(() => {
    if (!pendingTranslationRestoreRef.current) return;
    const position = pendingTranslationRestoreRef.current;
    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        syncScrollPane("translation", position);
        pendingTranslationRestoreRef.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
  }, [syncScrollPane, translationRefreshKey, viewerMode]);

  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlPressed(true);
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlPressed(false);
    };
    const selectListener = () => {
      const selection = window.getSelection();
      if (!isSelectionInside(selection, paneRef.current)) return;
      const selected = extractSelectionMarkdown(selection, paneRef.current);
      if (!selected) return;
      const state = useAppStore.getState();
      setSelectedPdfText(selected);
      setSelectedPdfQuote({
        text: selected,
        page: state.currentPage,
        pdfPath: state.pdfPath,
        pdfName: state.pdfName
      });
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
  }, [goToPage, pdfViewportPage, runOcr, totalPages]);

  const loadPdfFromPath = useCallback(
    async (path: string, options?: { preserveState?: boolean; targetPage?: number; forceReload?: boolean }) => {
      const sameDocument = !!pdfPath && path === pdfPath;
      const preservedTranslationPosition = options?.preserveState && sameDocument ? translationScrollPositionRef.current : null;

      if (!options?.forceReload && pdfDocRef.current && sameDocument) {
        const targetPage = clamp(options?.targetPage ?? pdfViewportPage, 1, totalPages || pdfViewportPage || 1);
        pdfScrollPositionRef.current = { page: targetPage, progress: 0 };
        translationScrollPositionRef.current = preservedTranslationPosition ?? { page: targetPage, progress: 0 };
        setPdfViewportPage(targetPage);
        setTranslationViewportPage(translationScrollPositionRef.current.page);
        setCurrentPage(targetPage);
        pendingTranslationRestoreRef.current = preservedTranslationPosition;
        refreshTranslationPanel(targetPage, translationScrollPositionRef.current.page);
        requestAnimationFrame(() => {
          syncScrollPane("pdf", { page: targetPage, progress: 0 });
          if (viewerMode === "dual" && scrollLinked && !preservedTranslationPosition) {
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
        pdfPageContentRefs.current = {};
        translationCardRefs.current = {};
        translationCardContentRefs.current = {};
        translationCardMeasureRefs.current = {};
        canvasRefs.current = {};
        Object.values(translationAbortRef.current).forEach((controller) => controller.abort());
        translationAbortRef.current = {};
        translationQueueRef.current = [];
        translationForceRef.current = {};
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
        pdfScrollPositionRef.current = { page: targetPage, progress: 0 };
        translationScrollPositionRef.current = preservedTranslationPosition ?? { page: targetPage, progress: 0 };
        setPdfViewportPage(targetPage);
        setTranslationViewportPage(translationScrollPositionRef.current.page);
        setCurrentPage(targetPage);
        pendingTranslationRestoreRef.current = preservedTranslationPosition;
        refreshTranslationPanel(targetPage, translationScrollPositionRef.current.page);
        if (!options?.preserveState) {
          setPdfViewState(pdfViewDocuments[path] ?? {
            zoomScale: 1.2,
            textLayerVisible: true,
            pdfLayerVisible: true,
            scrollLinked: true
          });
        }
        debugLogger.info(`[PDF] opened file=${path} docPages=${doc.numPages} lazySizes=enabled`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.error(`[PDF] open failed: ${message}`);
      } finally {
        setOpenProgress(100);
        setOpeningBusy(false);
      }
    },
    [
      pdfPath,
      pdfViewportPage,
      pdfViewDocuments,
      refreshTranslationPanel,
      restoreTranslationCacheForPdf,
      scrollLinked,
      setCurrentPage,
      setPdfName,
      setPdfPath,
      setPdfViewState,
      setTotalPages,
      setTranslationQueue,
      syncScrollPane,
      totalPages,
      viewerMode
    ]
  );

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
          pendingTranslationRestoreRef.current = translationScrollPositionRef.current;
          void loadPdfFromPath(pdfPath, {
            preserveState: true,
            targetPage: useAppStore.getState().currentPage,
            forceReload: true
          });
        }
        refreshTranslationPanel(useAppStore.getState().currentPage, translationScrollPositionRef.current.page);
        return;
      }

      if (detail.target === "agent") {
        refreshTranslationPanel(useAppStore.getState().currentPage);
      }
    };

    window.addEventListener("agent:refresh", onRefreshRequest as EventListener);
    return () => window.removeEventListener("agent:refresh", onRefreshRequest as EventListener);
  }, [loadPdfFromPath, pdfPath, refreshTranslationPanel]);

  const onPdfWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!ctrlPressed) return;
    e.preventDefault();
    updateZoomScale((prev) => prev + (e.deltaY < 0 ? 0.1 : -0.1));
  };

  const applyZoomInput = () => {
    const parsed = Number(zoomInput);
    if (!Number.isFinite(parsed)) {
      setZoomInput(String(Math.round(zoomScale * 100)));
      return;
    }
    updateZoomScale(parsed / 100);
  };

  const jumpToPage = () => {
    const parsed = Number(pageJumpInput);
    if (!Number.isFinite(parsed)) {
      setPageJumpInput(String(pdfViewportPage));
      return;
    }
    goToPage(Math.round(parsed));
  };

  const switchViewerMode = (mode: "single" | "dual") => {
    if (mode === viewerMode) return;
    const container = pdfScrollRef.current;
    if (container) pendingModeRestoreRef.current = captureViewportPosition(container, pdfPageRefs);
    setViewerMode(mode);
  };

  const handlePdfScroll = () => {
    const container = pdfScrollRef.current;
    if (!container || ignoreScrollRef.current === "pdf") return;
    const position = captureViewportPosition(container, pdfPageRefs);
    pdfScrollPositionRef.current = position;
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
    const position = captureViewportPosition(container, translationCardRefs);
    translationScrollPositionRef.current = position;
    setTranslationViewportPage(position.page);
    if (scrollLinked) {
      pdfScrollPositionRef.current = position;
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
        <span>
          {t(language, "page")}: {totalPages ? `${pdfViewportPage}/${totalPages}` : "-"}
        </span>
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
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => setPdfViewState({ scrollLinked: !scrollLinked })} disabled={!hasPdf || viewerMode !== "dual"}>
          {scrollLinked ? t(language, "unlinkScroll") : t(language, "linkScroll")}
        </button>
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => updateZoomScale((value) => value - 0.1)} disabled={!hasPdf || openingBusy || ocrBusy}>
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
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => updateZoomScale((value) => value + 0.1)} disabled={!hasPdf || openingBusy || ocrBusy}>
          +
        </button>
        <button className="rounded border border-border bg-white px-2 py-1 disabled:opacity-50" onClick={() => void runOcr()} disabled={!hasPdf || openingBusy || ocrBusy}>
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
          <div ref={(node) => (pdfPageContentRefs.current[page] = node)}>
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
              className="pdf-page-placeholder mx-auto rounded border border-dashed border-slate-300"
              style={{
                width: (pageBaseSizes[page] ?? estimatedPageBaseSize).width * zoomScale,
                height: (pageBaseSizes[page] ?? estimatedPageBaseSize).height * zoomScale
              }}
            />
          )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <section ref={paneRef} className="app-panel flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-semibold">{t(language, "pdfPane")}</div>
        <div className="flex gap-2">
          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => switchViewerMode("single")} disabled={viewerMode === "single"}>{t(language, "singleMode")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => switchViewerMode("dual")} disabled={viewerMode === "dual"}>{t(language, "dualMode")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs" onClick={() => setPdfViewState({ textLayerVisible: !textLayerVisible })}>{textLayerVisible ? t(language, "hideTextLayer") : t(language, "showTextLayer")}</button>
          <button className="rounded border border-border bg-white px-2 py-1 text-xs" onClick={() => setPdfViewState({ pdfLayerVisible: !pdfLayerVisible })}>{pdfLayerVisible ? t(language, "hidePdfLayer") : t(language, "showPdfLayer")}</button>
        </div>
      </header>
      {openingBusy && (
        <div className="border-b border-border px-3 py-2">
          <div className="app-progress-meta mb-1 flex items-center justify-between text-xs">
            <span>{t(language, "loadingPdf")}</span>
            <span>{openProgress}%</span>
          </div>
          <div className="app-progress-track">
            <div className="app-progress-fill transition-all" style={{ width: `${openProgress}%`, background: "var(--accent-color)" }} />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 p-2">
        {!hasPdf && <div className="flex h-full items-center justify-center text-sm text-slate-500">{t(language, "noPdf")}</div>}

        {hasPdf && viewerMode === "single" && (
          <div className="flex h-full min-h-0 flex-col">
            <div ref={pdfScrollRef} className={`pdf-scroll min-h-0 flex-1 overflow-auto rounded border border-border p-3 ${pdfLayerVisible ? "bg-slate-100" : "bg-white"}`} onWheel={onPdfWheel} onScroll={handlePdfScroll}>
              {pdfPages}
            </div>
            {toolbar}
          </div>
        )}

        {hasPdf && viewerMode === "dual" && (
          <PanelGroup direction="vertical" className="h-full">
            <Panel defaultSize={54} minSize={20}>
              <div className="flex h-full min-h-0 flex-col">
                <div ref={pdfScrollRef} className={`pdf-scroll min-h-0 flex-1 overflow-auto rounded border border-border p-3 ${pdfLayerVisible ? "bg-slate-100" : "bg-white"}`} onWheel={onPdfWheel} onScroll={handlePdfScroll}>
                  {pdfPages}
                </div>
                {toolbar}
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle-y" />
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
                    const metric = getPageMetric(page);
                    const isTranslated = !!translation.trim();
                    return (
                      <section
                        key={page}
                        ref={(node) => (translationCardRefs.current[page] = node)}
                        data-translation-card={page}
                        className={`rounded border p-3 ${page === translationViewportPage ? "bg-sky-50/40" : "border-border bg-white"}`}
                        style={{
                          borderColor: page === translationViewportPage ? "var(--accent-color)" : undefined,
                          backgroundColor: page === translationViewportPage ? "var(--accent-soft)" : undefined
                        }}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">第 {page} 页</div>
                            <div className="text-xs text-slate-500">状态: {statusLabel(status)}</div>
                          </div>
                          <button className="rounded border border-border bg-white px-2 py-1 text-xs disabled:opacity-50" onClick={() => void requestTranslation(page, true)} disabled={status === "translating"}>
                            {status === "translating" ? "翻译中..." : translation ? "重新翻译" : "翻译"}
                          </button>
                        </div>
                        <div ref={(node) => (translationCardContentRefs.current[page] = node)} data-translation-content={page} style={{ minHeight: metric.translationContentHeight }}>
                        {isTranslated ? (
                          <article ref={(node) => (translationCardMeasureRefs.current[page] = node)} data-translation-measure={page} className="markdown-preview text-slate-700">
                            <RichMarkdown content={translation} />
                          </article>
                        ) : (
                          <div ref={(node) => (translationCardMeasureRefs.current[page] = node)} data-translation-measure={page} className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                            <div className="mb-3 text-xs">
                              {language === "en"
                                ? "This page has no translation yet. Use >>tran or the translate button above for this page."
                                : "当前页面无翻译，通过 >>tran 指令或上方“翻译”按钮翻译本页面。"}
                            </div>
                            <div className="hidden mb-3 items-center justify-between gap-3 text-xs text-slate-500">
                              <span>
                                {language === "en" ? "Reserved card height" : "预留卡片高度"}: {Math.round(metric.translationCardHeight)} px
                              </span>
                              <button type="button" className="hidden rounded border border-border bg-white px-3 py-1.5 text-xs disabled:opacity-50" onClick={() => void requestTranslation(page, false)} disabled={status === "queued" || status === "translating"}>
                                {t(language, "translate")}
                              </button>
                            </div>
                            {status === "queued" ? "这一页已进入翻译队列。" : status === "translating" ? "正在翻译这一页..." : status === "error" ? "翻译失败，可点击本页按钮重试。" : !pageTextCache[page] ? "当前页文本尚未提取。滚动到该页后会自动提取，必要时可手动执行 OCR。" : "这一页尚未翻译，滚动到当前页后会自动排队。"}
                          </div>
                        )}
                        </div>
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
