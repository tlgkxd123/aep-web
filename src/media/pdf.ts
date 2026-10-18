// PDF-compatible Illustrator footage: rasterize the first artboard once, with alpha, then let the footage
// cache and GPU renderer handle it like any other still. The PDF worker is bundled for offline use.
import { AnnotationMode, getDocument, PDFWorker } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";
import type { FootageFrame } from "./frames.ts";

export async function decodePdf(blob: Blob, size?: { width: number; height: number }): Promise<FootageFrame> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const port = new PdfWorker();
  const worker = PDFWorker.create({ port });
  const task = getDocument({ data, worker, useWasm: false });
  const canvas = document.createElement("canvas");
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const width = Math.max(1, Math.round(size?.width ?? viewport.width));
    const height = Math.max(1, Math.round(size?.height ?? viewport.height));
    canvas.width = width;
    canvas.height = height;
    // PDF.js creates opaque page canvases by default; footage needs the artboard's transparent background.
    const canvasContext = canvas.getContext("2d", { alpha: true });
    if (!canvasContext) throw new Error("cannot create a canvas for vector footage");
    await page.render({
      canvas: null,
      canvasContext,
      viewport,
      transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0],
      background: "rgba(0,0,0,0)",
      annotationMode: AnnotationMode.DISABLE,
    }).promise;
    const image = await createImageBitmap(canvas, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    return { kind: "bitmap", image, width, height };
  } finally {
    await task.destroy().finally(() => {
      worker.destroy();
      port.terminate();
      canvas.width = canvas.height = 0;
    });
  }
}
