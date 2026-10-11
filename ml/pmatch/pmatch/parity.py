"""A fixture for tests/particle-match-parity.test.ts: a model with random networks and arrays, encoded as the
effect stores it, with features and the outputs PyTorch computes for them (in float64)."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import torch

from . import export
from .model import ParticleWorldModel, Settings
from .nets import AudioTCN, ParticleFlow

FRAMES = 2000


def fixture(seed: int = 5) -> dict:
    generator = torch.Generator().manual_seed(seed)
    network = AudioTCN(16, 16, 3, (1, 2, 4, 8, 16, 32), 3, 0.0)
    with torch.no_grad():
        for p in network.parameters():
            p.copy_(0.25 * torch.randn(p.shape, generator=generator))
    network.eval()
    features = (1.5 * torch.randn(FRAMES, 16, generator=generator)).clamp(-4, 4).float()
    with torch.no_grad():
        outputs = network.double()(features.double().T[None])[0].T.float()
    network.float()
    bank = torch.randn(64, 8, generator=generator)
    sprites = torch.rand(3, 8, 8, generator=generator)
    settings = Settings(
        rate=123.5,
        pre_run=7.25,
        size_depth=0.125,
        light_depth=0.375,
        feature_rate=100.0,
        sprite_reach=5.0,
        jitter=(0.03, 0.02, 0.04, 0.04, 0.04),
        shake={"frequency": 2.5, "x": 3.0, "y": 2.0, "tilt": 0.5, "level": 0.4},
        source={"name": "parity", "width": 1920, "height": 1080, "frameRate": 60.0, "mirrorAxis": 960.5, "center": [940.0, 530.0], "train": [50.0, 80.0]},
        trainer={"framework": "pytorch", "version": torch.__version__, "device": "cpu", "deviceName": "parity", "seconds": 0.0},
        report={"tracks": 1.0},
    )
    model = ParticleWorldModel(network, ParticleFlow(8, 3), sprites, torch.rand(3, 3, generator=generator), torch.rand(32, generator=generator), bank, torch.randint(3, (64,), generator=generator), settings)
    effect = model.to_effect()
    return {
        "model": base64.b64encode(model.encode()).decode("ascii"),
        "frames": FRAMES,
        "dims": 16,
        "features": export.pack(features.numpy()),
        "outputs": export.pack(outputs.numpy()),
        "arrays": {
            "prototypes": export.pack(effect["prototypes"]),
            "weights": export.pack(effect["weights"]),
            "jitter": export.pack(effect["jitter"]),
            "opacityOverLife": export.pack(effect["opacityOverLife"]),
            "spriteData": export.pack(effect["sprites"]["data"]),
            "spriteTint": export.pack(effect["sprites"]["tint"]),
        },
    }


def write(path: str | Path) -> None:
    Path(path).write_text(json.dumps(fixture()))
