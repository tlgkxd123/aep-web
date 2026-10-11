"""The world model's networks.

AudioTCN reads the sound's features (audio.ts: band envelopes, 100 frames a second) and gives, per
feature frame, the log clock speed, the log zoom and the shake amplitude: a 1x1 input projection, residual
blocks of a dilated "same" convolution, SiLU and a 1x1 mix, then a 1x1 head plus a linear skip from the
features. The app evaluates exactly this (src/extra/pmatch/tcn.ts), so it uses no normalization layers.

ParticleFlow is a RealNVP normalizing flow over particle states at birth (standardized), with a sprite
classifier on top: what a particle is, drawn from a learned density rather than copied from tracks."""

from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F

OUTPUTS = ("log_speed", "log_zoom", "shake")


class Block(nn.Module):
    def __init__(self, channels: int, kernel: int, dilation: int, dropout: float):
        super().__init__()
        self.conv = nn.Conv1d(channels, channels, kernel, dilation=dilation, padding=dilation * (kernel - 1) // 2)
        self.mix = nn.Conv1d(channels, channels, 1)
        self.dropout = nn.Dropout(dropout)
        nn.init.zeros_(self.mix.weight)
        nn.init.zeros_(self.mix.bias)

    def forward(self, h: torch.Tensor) -> torch.Tensor:
        return self.mix(self.dropout(F.silu(self.conv(h))))


class AudioTCN(nn.Module):
    def __init__(self, inputs: int = 16, channels: int = 16, kernel: int = 3, dilations: tuple[int, ...] = (1, 2, 4, 8, 16, 32), outputs: int = 3, dropout: float = 0.1):
        super().__init__()
        if kernel % 2 != 1:
            raise ValueError("the kernel must be odd for a centred convolution")
        self.inputs, self.channels, self.kernel, self.dilations, self.outputs = inputs, channels, kernel, tuple(dilations), outputs
        self.inp = nn.Conv1d(inputs, channels, 1)
        self.blocks = nn.ModuleList(Block(channels, kernel, d, dropout) for d in dilations)
        self.head = nn.Conv1d(channels, outputs, 1)
        self.skip = nn.Conv1d(inputs, outputs, 1, bias=False)
        nn.init.zeros_(self.head.weight)
        nn.init.zeros_(self.head.bias)
        nn.init.zeros_(self.skip.weight)

    @property
    def receptive_field(self) -> int:
        return 1 + (self.kernel - 1) * sum(self.dilations)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        """features [batch, inputs, frames] -> outputs [batch, outputs, frames]."""
        h = self.inp(features)
        for block in self.blocks:
            h = h + block(h)
        return self.head(h) + self.skip(features)

    def flat_weights(self) -> torch.Tensor:
        """Weights in the order the app reads them (model.ts): input projection, each block's dilated
        convolution and mix, head, skip; each weight row-major [out, in(, tap)] followed by its bias."""
        parts = [self.inp.weight.squeeze(-1), self.inp.bias]
        for block in self.blocks:
            parts += [block.conv.weight, block.conv.bias, block.mix.weight.squeeze(-1), block.mix.bias]
        parts += [self.head.weight.squeeze(-1), self.head.bias, self.skip.weight.squeeze(-1)]
        return torch.cat([p.detach().reshape(-1) for p in parts]).float()

    def describe(self) -> dict[str, object]:
        return {"inputs": self.inputs, "channels": self.channels, "kernel": self.kernel, "dilations": list(self.dilations), "outputs": self.outputs}


class Coupling(nn.Module):
    """Affine coupling: the dimensions outside `mask` are scaled and shifted by functions of those inside."""

    def __init__(self, mask: torch.Tensor, hidden: int):
        super().__init__()
        dim = mask.numel()
        self.register_buffer("mask", mask.float())
        self.net = nn.Sequential(nn.Linear(dim, hidden), nn.SiLU(), nn.Linear(hidden, hidden), nn.SiLU(), nn.Linear(hidden, 2 * dim))
        nn.init.zeros_(self.net[-1].weight)
        nn.init.zeros_(self.net[-1].bias)

    def _shift_scale(self, kept: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        s, t = self.net(kept).chunk(2, -1)
        free = 1 - self.mask
        # Bounded log-scales keep the inverse well conditioned.
        return 2 * torch.tanh(s / 2) * free, t * free

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Data -> latent, with log |det dz/dx|."""
        kept = x * self.mask
        s, t = self._shift_scale(kept)
        return kept + (1 - self.mask) * (x * torch.exp(s) + t), s.sum(-1)

    def inverse(self, z: torch.Tensor) -> torch.Tensor:
        kept = z * self.mask
        s, t = self._shift_scale(kept)
        return kept + (1 - self.mask) * ((z - t) * torch.exp(-s))


def coupling_masks(dim: int, layers: int) -> list[torch.Tensor]:
    """Alternating even/odd and first/second-half masks, so every dimension conditions every other."""
    index = torch.arange(dim)
    patterns = [index % 2 == 0, index % 2 == 1, index < dim // 2, index >= dim // 2]
    return [patterns[i % len(patterns)] for i in range(layers)]


class ParticleFlow(nn.Module):
    def __init__(self, dim: int, sprites: int, layers: int = 8, hidden: int = 64):
        super().__init__()
        self.dim, self.sprites = dim, sprites
        self.couplings = nn.ModuleList(Coupling(m, hidden) for m in coupling_masks(dim, layers))
        self.classifier = nn.Sequential(nn.Linear(dim, hidden), nn.SiLU(), nn.Linear(hidden, sprites))
        self.register_buffer("mean", torch.zeros(dim))
        self.register_buffer("std", torch.ones(dim))

    def standardize(self, x: torch.Tensor) -> torch.Tensor:
        return (x - self.mean) / self.std

    def to_latent(self, u: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        logdet = torch.zeros(u.shape[:-1], device=u.device, dtype=u.dtype)
        for c in self.couplings:
            u, ld = c(u)
            logdet = logdet + ld
        return u, logdet

    def from_latent(self, z: torch.Tensor) -> torch.Tensor:
        for c in reversed(self.couplings):
            z = c.inverse(z)
        return z

    def log_prob_standard(self, u: torch.Tensor) -> torch.Tensor:
        """Log density of standardized states."""
        z, logdet = self.to_latent(u)
        return -0.5 * (z * z).sum(-1) - 0.5 * self.dim * math.log(2 * math.pi) + logdet

    def log_prob(self, x: torch.Tensor) -> torch.Tensor:
        return self.log_prob_standard(self.standardize(x)) - torch.log(self.std).sum()

    def sprite_logits(self, x: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.standardize(x))

    @torch.no_grad()
    def sample(self, count: int, generator: torch.Generator) -> tuple[torch.Tensor, torch.Tensor]:
        """States and sprite classes of `count` particles."""
        z = torch.randn(count, self.dim, generator=generator, device=generator.device)
        x = self.from_latent(z) * self.std + self.mean
        probs = torch.softmax(self.sprite_logits(x), -1)
        sprite = torch.multinomial(probs, 1, generator=generator).squeeze(-1)
        return x, sprite
