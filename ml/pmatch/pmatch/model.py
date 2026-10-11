"""The world model as one module: the audio network (clock, zoom, shake), the particle flow and its bank,
the sprite codebook and the appearance over depth and life, with what the effect needs to place them."""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import torch
from torch import nn

from . import export
from .generator import LOG_AMPLITUDE, LOG_LIFE, LOG_SIZE, OX, OY, VX, VY, VZ
from .nets import AudioTCN, ParticleFlow


@dataclass
class Settings:
    """Scalars of a trained model (everything that is not a tensor)."""

    rate: float
    pre_run: float
    size_depth: float
    light_depth: float
    feature_rate: float
    sprite_reach: float
    jitter: tuple[float, ...]
    shake: dict | None
    source: dict
    trainer: dict
    report: dict


class ParticleWorldModel(nn.Module):
    def __init__(self, dynamics: AudioTCN, flow: ParticleFlow, sprites: torch.Tensor, tint: torch.Tensor, opacity: torch.Tensor, bank: torch.Tensor, bank_sprites: torch.Tensor, settings: Settings):
        super().__init__()
        self.dynamics = dynamics
        self.flow = flow
        self.register_buffer("sprites", sprites.float())
        self.register_buffer("tint", tint.float())
        self.register_buffer("opacity", opacity.float())
        self.register_buffer("bank", bank.float())
        self.register_buffer("bank_sprites", bank_sprites.long())
        self.register_buffer("bank_weights", torch.ones(len(bank)))
        self.settings = settings

    def prototypes(self) -> np.ndarray:
        """The bank as the effect's prototypes (model.ts PROTO_STRIDE floats each)."""
        b = self.bank.detach().cpu().double()
        out = np.zeros((len(b), export.PROTO_STRIDE), dtype=np.float32)
        out[:, 0] = b[:, VX]
        out[:, 1] = b[:, VY]
        out[:, 2] = b[:, VZ]
        out[:, 3] = b[:, OX]
        out[:, 4] = b[:, OY]
        out[:, 6] = torch.exp(b[:, LOG_SIZE])
        out[:, 7] = torch.exp(b[:, LOG_AMPLITUDE])
        out[:, 8] = torch.exp(b[:, LOG_LIFE])
        out[:, 9] = self.bank_sprites.cpu().numpy()
        return out

    def to_effect(self) -> dict:
        s = self.settings
        sprites = self.sprites.detach().cpu().numpy()
        return {
            "rate": s.rate,
            "preRun": s.pre_run,
            "sizeDepth": s.size_depth,
            "lightDepth": s.light_depth,
            "prototypes": self.prototypes().reshape(-1),
            "weights": self.bank_weights.cpu().numpy(),
            "jitter": np.asarray(s.jitter, dtype=np.float32),
            "opacityOverLife": self.opacity.cpu().numpy(),
            "sprites": {"size": int(sprites.shape[-1]), "reach": s.sprite_reach, "count": int(sprites.shape[0]), "data": sprites.reshape(-1), "tint": self.tint.cpu().numpy().reshape(-1)},
            "dynamics": {"rate": s.feature_rate, **self.dynamics.describe(), "weights": self.dynamics.flat_weights().cpu().numpy()},
            "shake": s.shake,
            "source": s.source,
            "trainer": s.trainer,
            "report": s.report,
        }

    def encode(self) -> bytes:
        return export.encode(self.to_effect())

    def checkpoint(self) -> dict:
        return {
            "format": "pmatch-checkpoint-1",
            "dynamics": self.dynamics.describe() | {"dropout": float(self.dynamics.blocks[0].dropout.p) if len(self.dynamics.blocks) else 0.0},
            "flow": {"dim": self.flow.dim, "sprites": self.flow.sprites, "layers": len(self.flow.couplings), "hidden": self.flow.couplings[0].net[0].out_features},
            "settings": asdict(self.settings),
            "state_dict": {k: v.detach().cpu() for k, v in self.state_dict().items()},
        }

    @staticmethod
    def from_checkpoint(data: dict) -> "ParticleWorldModel":
        d, f = data["dynamics"], data["flow"]
        dynamics = AudioTCN(d["inputs"], d["channels"], d["kernel"], tuple(d["dilations"]), d["outputs"], d.get("dropout", 0.0))
        flow = ParticleFlow(f["dim"], f["sprites"], f["layers"], f["hidden"])
        state = data["state_dict"]
        model = ParticleWorldModel(dynamics, flow, state["sprites"], state["tint"], state["opacity"], state["bank"], state["bank_sprites"], Settings(**data["settings"]))
        model.load_state_dict(state)
        return model
