// Decoded footage frames as the renderer consumes them. Pixel rows run top to
// bottom; colour values are the file's own (straight or premultiplied as the
// file stores them), the Interpret Footage settings are applied at upload.

export type FootageFrame =
  /** RGBA decoded by the browser without premultiplying or colour conversion. */
  | { kind: "bitmap"; image: ImageBitmap; width: number; height: number }
  /** 8-bit RGBA, rows packed. */
  | { kind: "rgba"; data: Uint8Array; width: number; height: number }
  /**
   * 8-bit Y'CbCr as the decoder laid it out in `data`: the Y plane, then Cb and Cr planes or one
   * interleaved CbCr plane (NV12), each from its offset with rows `stride` bytes apart. Chroma is
   * subsampled to chromaWidth x chromaHeight.
   */
  | {
      kind: "yuv";
      data: Uint8Array;
      planes: { offset: number; stride: number }[];
      interleaved: boolean;
      width: number;
      height: number;
      chromaWidth: number;
      chromaHeight: number;
      /** Video range (16-235) rather than full range. */
      limitedRange: boolean;
    };

export function frameBytes(frame: FootageFrame): number {
  if (frame.kind === "yuv") return frame.data.length;
  return frame.width * frame.height * 4;
}

export function releaseFrame(frame: FootageFrame): void {
  if (frame.kind === "bitmap") frame.image.close();
}
