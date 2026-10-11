"""The effect's model format (src/extra/pmatch/model.ts): the bytes "PMWM", the format version (uint32,
little endian), then JSON whose float arrays are base64 little-endian float32."""

from __future__ import annotations

import base64
import json
import struct

import numpy as np

MAGIC = b"PMWM"
MODEL_VERSION = 2

#: Floats per prototype: velocity, birth offset, size, amplitude, life, sprite class.
PROTO_STRIDE = 10
#: Jitter scales: log speed, direction (radians), log size, log amplitude, log life.
JITTER_COUNT = 5


def pack(values) -> str:
    return base64.b64encode(np.ascontiguousarray(np.asarray(values, dtype="<f4")).tobytes()).decode("ascii")


def unpack(text: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), dtype="<f4").copy()


ARRAYS = ("prototypes", "weights", "jitter", "opacityOverLife")


def encode(model: dict) -> bytes:
    body = dict(model)
    for key in ARRAYS:
        body[key] = pack(model[key])
    body["sprites"] = {**model["sprites"], "data": pack(model["sprites"]["data"]), "tint": pack(model["sprites"]["tint"])}
    body["dynamics"] = {**model["dynamics"], "weights": pack(model["dynamics"]["weights"])}
    return MAGIC + struct.pack("<I", MODEL_VERSION) + json.dumps(body, allow_nan=False).encode()


def decode(data: bytes) -> dict:
    if data[:4] != MAGIC:
        raise ValueError("not a Particle Match model")
    (version,) = struct.unpack("<I", data[4:8])
    if version != MODEL_VERSION:
        raise ValueError(f"model version {version} is not supported")
    model = json.loads(data[8:])
    for key in ARRAYS:
        model[key] = unpack(model[key])
    model["sprites"]["data"] = unpack(model["sprites"]["data"])
    model["sprites"]["tint"] = unpack(model["sprites"]["tint"])
    model["dynamics"]["weights"] = unpack(model["dynamics"]["weights"])
    return model
