"""Training the audio network (nets.AudioTCN) on the reference.

The app turns the network's log clock speed into particle time exactly as here (dynamics.ts Clock): the
speed is held over each feature frame and integrated. The loss compares that integral with the clock
fitted to the tracks (motion.py) over several horizons, in log, so that both quick changes and the
distance particles cover come out right; frames that sources at 30 fps repeat carry no step of their own,
so the shortest horizon is two frames. The shake head learns the S_Shake Amplitude the browser measured.

The last fifth of the window is held back to choose how long to train; the network is then trained on the
whole window for that long."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch
from torch.nn import functional as F

from .dataset import Analysis
from .graphs import Stepper, cosine, optimizer_for, set_lr
from .motion import Clock
from .nets import AudioTCN

#: Log clock speed is kept within +-MAX_LOG_SPEED (dynamics.ts).
MAX_LOG_SPEED = 3.0
#: Shake Amplitude regressions explaining less than this share of the held-back fifth do not follow the music.
MIN_SHAKE_R2 = 0.1


@dataclass
class DynamicsOptions:
    channels: int = 16
    kernel: int = 3
    dilations: tuple[int, ...] = (1, 2, 4, 8, 16, 32)
    dropout: float = 0.1
    #: Gaussian noise added to the features while training (their units are spreads of the track's levels).
    noise: float = 0.1
    horizons: tuple[int, ...] = (2, 4, 8, 16, 32)
    steps: int = 2500
    check_every: int = 25
    patience: int = 12
    lr: float = 3e-3
    weight_decay: float = 1e-2
    #: Particle steps per frame at which a frame's clock counts fully.
    full_evidence: float = 20.0
    holdout: float = 0.2


@dataclass
class DynamicsResult:
    network: AudioTCN
    #: Share of the 2-frame log clock speed's variance explained on the held-back fifth (by the network trained
    #: without it) and on the whole window (by the final network).
    r2_valid: float
    r2_train: float
    shake_r2: float
    shake_follows: bool
    steps: int
    history: list[tuple[int, float]] = field(default_factory=list)


class Targets:
    """The fitted clock and shake at the window's frames, and the features around the window: a margin of
    a receptive field keeps the network's outputs over the window as they are on the whole track."""

    def __init__(self, analysis: Analysis, clock: Clock, options: DynamicsOptions, device: torch.device):
        fps = analysis.frame_rate
        self.rate = analysis.feature_rate
        frames = len(clock.tau)
        time = (analysis.first + np.arange(frames)) / fps
        margin = 1 + (options.kernel - 1) * sum(options.dilations)
        begin = max(0, int(np.floor(time[0] * self.rate)) - margin)
        end = min(len(analysis.features), int(np.ceil(time[-1] * self.rate)) + margin + 2)
        self.features = torch.as_tensor(analysis.features[begin:end], device=device)
        self.time = torch.as_tensor(time - begin / self.rate, device=device)
        self.tau = clock.tau.to(device)
        evidence = (clock.evidence.to(device) / options.full_evidence).clamp(max=1)
        self.horizons = []
        for h in options.horizons:
            if h >= frames:
                continue
            fitted = self.tau[h:] - self.tau[:-h]
            # A horizon's weight is its least supported frame's.
            support = torch.stack([evidence[i + 1 : frames - h + i + 1] for i in range(h)]).min(0).values
            self.horizons.append((h, torch.log(fitted.clamp(min=0.03 * h / fps)), support))
        self.shake = None
        if analysis.shake is not None:
            self.shake = (torch.as_tensor(analysis.shake.envelope, device=device, dtype=torch.float32), torch.as_tensor(analysis.shake.valid, device=device))
        self.frames = frames

    def clock(self, log_speed: torch.Tensor) -> torch.Tensor:
        """Particle time at the window's frames for a log speed per feature frame (the app's integral)."""
        speed = torch.exp(log_speed.clamp(-MAX_LOG_SPEED, MAX_LOG_SPEED)).double()
        cumulative = torch.cat([speed.new_zeros(1), torch.cumsum(speed, 0)]) / self.rate
        x = self.time * self.rate
        k = x.floor().long().clamp(0, len(speed) - 1)
        return cumulative[k] + (x - k) * speed[k] / self.rate

    def at_frames(self, track: torch.Tensor) -> torch.Tensor:
        """A per-feature-frame series at the window's frames (linear between feature frames)."""
        x = (self.time * self.rate).float()
        k = x.floor().long().clamp(0, len(track) - 2)
        f = (x - k).clamp(0, 1)
        return track[k] * (1 - f) + track[k + 1] * f


def _losses(targets: Targets, outputs: torch.Tensor, frames: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None]:
    """Clock and shake losses over the window frames in `frames` (a boolean mask)."""
    tau = targets.clock(outputs[0])
    clock_terms = []
    for h, fitted, support in targets.horizons:
        predicted = torch.log((tau[h:] - tau[:-h]).clamp(min=1e-9)).float()
        weight = support.float() * (frames[h:] & frames[:-h]).float()
        clock_terms.append((weight * (predicted - fitted.float()) ** 2).sum() / weight.sum().clamp(min=1))
    shake = None
    if targets.shake is not None:
        envelope, valid = targets.shake
        mask = (valid & frames).float()
        shake = (mask * (targets.at_frames(outputs[2]) - envelope) ** 2).sum() / mask.sum().clamp(min=1)
    return torch.stack(clock_terms).mean(), shake


def _r2(predicted: torch.Tensor, actual: torch.Tensor, mask: torch.Tensor) -> float:
    p, y = predicted[mask].double(), actual[mask].double()
    if y.numel() < 3:
        return 0.0
    total = ((y - y.mean()) ** 2).sum()
    return float(1 - ((y - p) ** 2).sum() / total) if total > 0 else 0.0


def _pair_log_speed(targets: Targets, tau: torch.Tensor) -> torch.Tensor:
    fps_step = targets.time[1] - targets.time[0]
    return torch.log(((tau[2:] - tau[:-2]) / (2 * fps_step)).clamp(min=0.03))


def _linear_start(network: AudioTCN, features: torch.Tensor, targets: Targets, frames: torch.Tensor) -> None:
    """Starts the network as the ridge regression of the 2-frame log speed on the features at each frame."""
    x = torch.stack([targets.at_frames(features[:, i]) for i in range(features.shape[1])], 1).double()[1:-1]
    y = _pair_log_speed(targets, targets.tau)
    m = frames[1:-1] & frames[:-2] & frames[2:]
    x, y = x[m], y[m]
    if len(y) < 10:
        return
    design = torch.cat([torch.ones(len(y), 1, dtype=x.dtype, device=x.device), x], 1)
    gram = design.T @ design
    gram[1:, 1:] += 0.05 * len(y) * torch.eye(x.shape[1], dtype=x.dtype, device=x.device)
    coef = torch.linalg.solve(gram, design.T @ y)
    with torch.no_grad():
        network.head.bias[0] = float(coef[0])
        network.skip.weight[0, :, 0] = coef[1:].float()


def _fit(features: torch.Tensor, targets: Targets, options: DynamicsOptions, train: torch.Tensor, valid: torch.Tensor | None, steps: int, seed: int) -> tuple[AudioTCN, int, list[tuple[int, float]]]:
    torch.manual_seed(seed)
    network = AudioTCN(features.shape[1], options.channels, options.kernel, options.dilations, 3, options.dropout).to(features.device)
    _linear_start(network, features, targets, train)
    if targets.shake is not None:
        envelope, ok = targets.shake
        with torch.no_grad():
            network.head.bias[2] = float(envelope[ok & train].mean()) if bool((ok & train).any()) else 0.0
    decay = [p for n, p in network.named_parameters() if n.endswith("weight")]
    rest = [p for n, p in network.named_parameters() if not n.endswith("weight")]
    optimizer = optimizer_for([{"params": decay, "weight_decay": options.weight_decay}, {"params": rest, "weight_decay": 0.0}], options.lr, 0.0, features.device)
    x = features.T[None]
    generator = torch.Generator(device=features.device).manual_seed(seed)

    def step_once() -> torch.Tensor:
        noisy = x + options.noise * torch.randn(x.shape, generator=generator, device=x.device)
        clock_loss, shake_loss = _losses(targets, network(noisy)[0], train)
        loss = clock_loss + (shake_loss if shake_loss is not None else 0)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(network.parameters(), 1.0)
        optimizer.step()
        return loss

    stepper = Stepper(step_once, optimizer, [generator], features.device)
    best = (float("inf"), 0, {k: v.clone() for k, v in network.state_dict().items()})
    history: list[tuple[int, float]] = []
    stale = 0
    for step in range(1, steps + 1):
        network.train()
        set_lr(optimizer, cosine(options.lr, step - 1, steps))
        stepper()
        if valid is not None and step % options.check_every == 0:
            network.eval()
            with torch.no_grad():
                held_clock, held_shake = _losses(targets, network(x)[0], valid)
                held = float(held_clock + (held_shake if held_shake is not None else 0))
            history.append((step, held))
            if held < best[0] - 1e-5:
                best = (held, step, {k: v.clone() for k, v in network.state_dict().items()})
                stale = 0
            else:
                stale += 1
                if stale >= options.patience:
                    break
    if valid is not None:
        network.load_state_dict(best[2])
        return network, best[1], history
    return network, steps, history


def train_dynamics(analysis: Analysis, clock: Clock, device: torch.device, options: DynamicsOptions = DynamicsOptions(), seed: int = 1) -> DynamicsResult:
    targets = Targets(analysis, clock, options, device)
    features = targets.features
    frames = targets.frames
    split = int(frames * (1 - options.holdout))
    train = torch.arange(frames, device=device) < split
    held_back, best_steps, history = _fit(features, targets, options, train, ~train, options.steps, seed)
    held_back.eval()
    with torch.no_grad():
        outputs = held_back(features.T[None])[0]
        actual = _pair_log_speed(targets, targets.tau)
        predicted = _pair_log_speed(targets, targets.clock(outputs[0]))
        r2_valid = _r2(predicted, actual, ~train[1:-1] & ~train[:-2] & ~train[2:])
        shake_r2 = 0.0
        if targets.shake is not None:
            envelope, ok = targets.shake
            shake_r2 = _r2(targets.at_frames(outputs[2]).clamp(min=0), envelope, ok & ~train)
    everything = torch.ones(frames, dtype=torch.bool, device=device)
    network, _, _ = _fit(features, targets, options, everything, None, max(best_steps, options.check_every), seed)
    network.eval()
    shake_follows = targets.shake is not None and shake_r2 >= MIN_SHAKE_R2
    with torch.no_grad():
        if targets.shake is not None and not shake_follows:
            # The Amplitude does not follow the music: hold it at its mean.
            network.head.weight[2].zero_()
            network.skip.weight[2].zero_()
            network.head.bias[2] = float(analysis.shake.level)
        elif targets.shake is None:
            network.head.weight[2].zero_()
            network.skip.weight[2].zero_()
            network.head.bias[2] = 0.0
        # Nothing measures a zoom of the particles apart from the clock: none is learned.
        network.head.weight[1].zero_()
        network.skip.weight[1].zero_()
        network.head.bias[1] = 0.0
        outputs = network(features.T[None])[0]
        r2_train = _r2(_pair_log_speed(targets, targets.clock(outputs[0])), _pair_log_speed(targets, targets.tau), torch.ones(frames - 2, dtype=torch.bool, device=device))
    return DynamicsResult(network, r2_valid, r2_train, shake_r2, shake_follows, best_steps, history)
