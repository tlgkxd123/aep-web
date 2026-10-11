"""Training the particle flow (nets.ParticleFlow) on the population's states at birth, and drawing the bank
of particles the app samples from (model.ts prototypes: particle i of a stream picks one by its seed).

A mirrored reference shows one side of the emitter only; its emission is taken to be symmetric, so every
state also trains the flow as its mirror image, and the bank holds each drawn particle with its mirror
image next to it (calibration reweights the two together)."""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch.nn import functional as F

from .graphs import Stepper, cosine, optimizer_for, set_lr
from .nets import ParticleFlow

STATE = ("vx", "vy", "vz", "ox", "oy", "log_size", "log_amplitude", "log_life")
VX, VY, VZ, OX, OY, LOG_SIZE, LOG_AMPLITUDE, LOG_LIFE = range(len(STATE))


@dataclass
class FlowOptions:
    layers: int = 8
    hidden: int = 64
    steps: int = 3000
    #: Small networks are launch-bound on the GPU: large batches cost no more per step than small ones.
    batch: int = 4096
    lr: float = 2e-3
    weight_decay: float = 1e-4
    #: Gaussian noise added to the standardized states while training (dequantizes repeated values).
    noise: float = 0.02
    holdout: float = 0.1
    check_every: int = 50
    patience: int = 10
    mirror: bool = True


@dataclass
class FlowResult:
    flow: ParticleFlow
    #: Negative log likelihood per particle in standardized units, and the sprite classifier's accuracy, on the held-back tenth.
    nll_train: float
    nll_valid: float
    sprite_accuracy: float
    steps: int
    #: Range of the training states: drawn particles are kept within it.
    low: torch.Tensor
    high: torch.Tensor


def mirrored(states: torch.Tensor) -> torch.Tensor:
    out = states.clone()
    out[:, VX] = -out[:, VX]
    out[:, OX] = -out[:, OX]
    return out


def train_flow(
    states: torch.Tensor,
    sprites: torch.Tensor,
    sprite_count: int,
    options: FlowOptions = FlowOptions(),
    seed: int = 7,
    weights: torch.Tensor | None = None,
    cropped: torch.Tensor | None = None,
) -> FlowResult:
    """Maximum likelihood, each state counting by its weight (population.selection_weights). The sprite
    classifier learns from the states whose particles were cropped (`cropped`; all when fewer than 20 were):
    their sprite was seen, the others' only guessed from their size and light."""
    device = states.device
    generator = torch.Generator(device=device).manual_seed(seed)
    n = len(states)
    weights = torch.ones(n, device=device) if weights is None else weights.to(device=device, dtype=torch.float32)
    seen = torch.ones(n, device=device) if cropped is None or int(cropped.sum()) < 20 else cropped.to(device=device, dtype=torch.float32)
    order = torch.randperm(n, generator=generator, device=device)
    held = max(1, int(n * options.holdout)) if n >= 20 else 0
    train_x, train_s, train_w, train_c = states[order[held:]], sprites[order[held:]], weights[order[held:]], seen[order[held:]]
    valid_x, valid_s, valid_w, valid_c = states[order[:held]], sprites[order[:held]], weights[order[:held]], seen[order[:held]]
    if options.mirror:
        train_x, train_s, train_w, train_c = torch.cat([train_x, mirrored(train_x)]), torch.cat([train_s, train_s]), torch.cat([train_w, train_w]), torch.cat([train_c, train_c])
        valid_x, valid_s, valid_w, valid_c = torch.cat([valid_x, mirrored(valid_x)]), torch.cat([valid_s, valid_s]), torch.cat([valid_w, valid_w]), torch.cat([valid_c, valid_c])
    torch.manual_seed(seed)
    flow = ParticleFlow(states.shape[1], sprite_count, options.layers, options.hidden).to(device)
    flow.mean.copy_(train_x.mean(0))
    flow.std.copy_(train_x.std(0).clamp(min=1e-6))
    optimizer = optimizer_for(flow.parameters(), options.lr, options.weight_decay, device)

    def step_once() -> torch.Tensor:
        pick = torch.multinomial(train_w, options.batch, replacement=True, generator=generator)
        x, s, c = train_x[pick], train_s[pick], train_c[pick]
        u = flow.standardize(x)
        u = u + options.noise * torch.randn(u.shape, generator=generator, device=device)
        sprite = (c * F.cross_entropy(flow.classifier(flow.standardize(x)), s, reduction="none")).sum() / c.sum().clamp(min=1)
        loss = -flow.log_prob_standard(u).mean() + sprite
        loss.backward()
        torch.nn.utils.clip_grad_norm_(flow.parameters(), 5.0)
        optimizer.step()
        return loss

    stepper = Stepper(step_once, optimizer, [generator], device)

    def evaluate(x: torch.Tensor, s: torch.Tensor, w: torch.Tensor, c: torch.Tensor) -> tuple[float, float]:
        flow.eval()
        with torch.no_grad():
            nll = float(-(w * flow.log_prob_standard(flow.standardize(x))).sum() / w.sum())
            wc = w * c
            accuracy = float((wc * (flow.sprite_logits(x).argmax(-1) == s).float()).sum() / wc.sum()) if float(wc.sum()) > 0 else 1.0
        flow.train()
        return nll, accuracy

    best = (float("inf"), 0, {k: v.clone() for k, v in flow.state_dict().items()})
    stale = 0
    step = 0
    for step in range(1, options.steps + 1):
        set_lr(optimizer, cosine(options.lr, step - 1, options.steps))
        stepper()
        if held and step % options.check_every == 0:
            nll, _ = evaluate(valid_x, valid_s, valid_w, valid_c)
            if nll < best[0] - 1e-4:
                best = (nll, step, {k: v.clone() for k, v in flow.state_dict().items()})
                stale = 0
            else:
                stale += 1
                if stale >= options.patience:
                    break
    if held:
        flow.load_state_dict(best[2])
    flow.eval()
    nll_train, _ = evaluate(train_x, train_s, train_w, train_c)
    nll_valid, accuracy = evaluate(valid_x, valid_s, valid_w, valid_c) if held else (nll_train, 1.0)
    every = torch.cat([train_x, valid_x])
    return FlowResult(flow, nll_train, nll_valid, accuracy, best[1] if held else step, every.min(0).values, every.max(0).values)


def sample_bank(result: FlowResult, count: int, mirror: bool, seed: int = 11) -> tuple[torch.Tensor, torch.Tensor]:
    """`count` particle states (and sprite classes) drawn from the flow, inside the training states' range
    widened by a twentieth; with `mirror`, pairs of a drawn particle and its mirror image."""
    device = result.low.device
    generator = torch.Generator(device=device).manual_seed(seed)
    drawn = count // 2 if mirror else count
    states, sprites = result.flow.sample(drawn, generator)
    margin = 0.05 * (result.high - result.low)
    states = torch.maximum(torch.minimum(states, result.high + margin), result.low - margin)
    states[:, VZ] = states[:, VZ].clamp(max=0)
    if mirror:
        states = torch.stack([states, mirrored(states)], 1).reshape(-1, states.shape[1])
        sprites = sprites.repeat_interleave(2)
    return states, sprites
