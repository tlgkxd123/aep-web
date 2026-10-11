// Registers pairs of consecutive frame thumbnails off the main thread for the shake measurement (shake.ts).
import { thumbnailMotion, type ShakeJob, type ShakeReply } from "./shakeRegister.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ShakeJob>) => void) | null;
  postMessage(message: ShakeReply): void;
};

scope.onmessage = ({ data }) => scope.postMessage({ id: data.id, motion: thumbnailMotion(data.from, data.to, data.width, data.height) });
