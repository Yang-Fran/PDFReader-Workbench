export interface OcrWordBox {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

type MinimalWorker = {
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  recognize: (canvas: HTMLCanvasElement) => Promise<{
    data: {
      text?: string;
      confidence?: number;
      words?: Array<unknown>;
    };
  }>;
};

let workerPromise: Promise<MinimalWorker> | null = null;

const getWorker = async () => {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("chi_sim+eng");
      await worker.setParameters(
        // Cast for compatibility across tesseract.js type versions.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { tessedit_pageseg_mode: "6", user_defined_dpi: "300", preserve_interword_spaces: "1" } as any
      );
      return worker as unknown as MinimalWorker;
    })();
  }
  return workerPromise;
};

const preprocessCanvas = (src: HTMLCanvasElement) => {
  const scale = 2;
  const dst = document.createElement("canvas");
  dst.width = Math.max(1, Math.round(src.width * scale));
  dst.height = Math.max(1, Math.round(src.height * scale));

  const ctx = dst.getContext("2d");
  if (!ctx) return { canvas: src, scale: 1 };

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dst.width, dst.height);

  const imageData = ctx.getImageData(0, 0, dst.width, dst.height);
  const data = imageData.data;

  let sumGray = 0;
  const count = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    sumGray += gray;
  }
  const meanGray = sumGray / Math.max(1, count);
  const threshold = Math.max(90, Math.min(190, meanGray * 0.92));

  for (let i = 0; i < data.length; i += 4) {
    const grayRaw = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (grayRaw - 128) * 1.25 + 128));
    const bw = contrasted > threshold ? 255 : 0;
    data[i] = bw;
    data[i + 1] = bw;
    data[i + 2] = bw;
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas: dst, scale };
};

export const ocrService = {
  async recognizeCanvas(canvas: HTMLCanvasElement): Promise<{ text: string; confidence: number; words: OcrWordBox[] }> {
    const worker = await getWorker();
    if (!worker) throw new Error("OCR worker initialization failed.");
    const prepared = preprocessCanvas(canvas);
    const result = await worker.recognize(prepared.canvas);
    const scale = prepared.scale || 1;
    // tesseract.js type definitions lag behind the runtime payload shape here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawWords = ((result.data as any).words ?? []) as Array<any>;

    const words: OcrWordBox[] = rawWords
      .map((w: any) => {
        const text = (w.text ?? "").trim();
        const bbox = w.bbox;
        if (!text || !bbox) return null;
        const left = Math.max(0, bbox.x0 / scale);
        const top = Math.max(0, bbox.y0 / scale);
        const width = Math.max(0, (bbox.x1 - bbox.x0) / scale);
        const height = Math.max(0, (bbox.y1 - bbox.y0) / scale);
        return {
          text,
          confidence: Number(w.confidence ?? 0),
          left,
          top,
          width,
          height
        } satisfies OcrWordBox;
      })
      .filter((w): w is OcrWordBox => w !== null);

    return {
      text: result.data.text?.trim() ?? "",
      confidence: Number(result.data.confidence ?? 0),
      words
    };
  }
};
