"""Reads and writes safetensors files with numpy: an 8-byte little-endian header length, a JSON
header naming each tensor's dtype, shape and byte range, then the raw little-endian data."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

DTYPES = {"F64": "<f8", "F32": "<f4", "F16": "<f2", "I64": "<i8", "I32": "<i4", "U8": "u1"}
NAMES = {np.dtype(v).str: k for k, v in DTYPES.items()}


def read(path: str | Path) -> tuple[dict[str, np.ndarray], dict[str, str]]:
    data = Path(path).read_bytes()
    length = int.from_bytes(data[:8], "little")
    header = json.loads(data[8 : 8 + length])
    metadata = header.pop("__metadata__", {}) or {}
    base = 8 + length
    tensors: dict[str, np.ndarray] = {}
    for name, info in header.items():
        dtype = np.dtype(DTYPES[info["dtype"]])
        begin, end = info["data_offsets"]
        count = (end - begin) // dtype.itemsize
        array = np.frombuffer(data, dtype=dtype, count=count, offset=base + begin)
        tensors[name] = array.reshape(info["shape"]).copy()
    return tensors, metadata


def write(path: str | Path, tensors: dict[str, np.ndarray], metadata: dict[str, str] | None = None) -> None:
    header: dict[str, object] = {}
    if metadata:
        header["__metadata__"] = metadata
    chunks: list[bytes] = []
    offset = 0
    for name, array in tensors.items():
        array = np.ascontiguousarray(array)
        little = array.astype(array.dtype.newbyteorder("<"), copy=False)
        raw = little.tobytes()
        header[name] = {"dtype": NAMES[little.dtype.str], "shape": list(array.shape), "data_offsets": [offset, offset + len(raw)]}
        chunks.append(raw)
        offset += len(raw)
    text = json.dumps(header).encode()
    text += b" " * (-len(text) % 8)
    Path(path).write_bytes(len(text).to_bytes(8, "little") + text + b"".join(chunks))
