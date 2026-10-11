// Computes the world model's audio features off the main thread for soundtrack.ts.
import { computeFeatures, type FeaturesReply, type FeaturesRequest } from "./soundFeatures.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FeaturesRequest>) => void) | null;
  postMessage(message: FeaturesReply, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  try {
    const features = computeFeatures(data);
    scope.postMessage({ id: data.id, features }, [features.data.buffer]);
  } catch (e) {
    scope.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) });
  }
};
