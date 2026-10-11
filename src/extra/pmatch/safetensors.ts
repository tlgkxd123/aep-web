// Writes tensors as a safetensors file: an 8-byte little-endian header length, a
// JSON header naming each tensor's dtype, shape and byte range (padded to 8 bytes),
// then the data. Typed arrays are written in the platform's byte order, which is
// little endian everywhere this app runs.

export type TensorData = Float32Array | Int32Array | Uint8Array;

export interface Tensor {
  data: TensorData;
  shape: number[];
}

const dtypeOf = (data: TensorData) => (data instanceof Float32Array ? "F32" : data instanceof Int32Array ? "I32" : "U8");

export function encodeSafetensors(tensors: Record<string, Tensor>, metadata: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  const header: Record<string, unknown> = { __metadata__: metadata };
  let offset = 0;
  for (const [name, { data, shape }] of Object.entries(tensors)) {
    if (shape.reduce((n, s) => n * s, 1) !== data.length) throw new Error(`tensor ${name} does not have the shape ${shape.join("×")}`);
    header[name] = { dtype: dtypeOf(data), shape, data_offsets: [offset, offset + data.byteLength] };
    offset += data.byteLength;
  }
  let json = JSON.stringify(header);
  json += " ".repeat((8 - (new TextEncoder().encode(json).length % 8)) % 8);
  const text = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + text.length + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, text.length, true);
  view.setUint32(4, Math.floor(text.length / 2 ** 32), true);
  out.set(text, 8);
  let at = 8 + text.length;
  for (const { data } of Object.values(tensors)) {
    out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at);
    at += data.byteLength;
  }
  return out;
}
