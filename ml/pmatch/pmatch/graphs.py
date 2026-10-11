"""Training steps replayed as CUDA graphs. The world model's networks are small, so a training step's time
goes to launching its kernels; captured once, after a few eager steps on a side stream that create the
optimizer's state, a step is a single launch. On the CPU a step simply runs."""

from __future__ import annotations

import math
from typing import Callable, Iterable, Sequence

import torch

#: Eager steps before the capture.
WARMUP = 3


def optimizer_for(params: Iterable[torch.nn.Parameter] | list[dict], lr: float, weight_decay: float, device: torch.device) -> torch.optim.AdamW:
    """AdamW that a CUDA graph can replay: on CUDA its learning rate is a device tensor (`set_lr` changes it)."""
    graphed = device.type == "cuda"
    return torch.optim.AdamW(params, lr=torch.tensor(lr, device=device) if graphed else lr, weight_decay=weight_decay, fused=graphed, capturable=graphed)


def cosine(base: float, step: int, steps: int) -> float:
    """CosineAnnealingLR's learning rate after `step` steps of `steps` (to zero)."""
    return 0.5 * base * (1 + math.cos(math.pi * step / steps))


def set_lr(optimizer: torch.optim.Optimizer, value: float) -> None:
    for group in optimizer.param_groups:
        if isinstance(group["lr"], torch.Tensor):
            group["lr"].fill_(value)
        else:
            group["lr"] = value


class Stepper:
    """Calls `step` (forward, backward, optimizer step; returns the loss) with the gradients cleared before
    it: eagerly for the first WARMUP calls, then on CUDA as a captured graph replayed by each later call. The
    generators `step` draws from (besides the default ones) are registered with the graph."""

    def __init__(self, step: Callable[[], torch.Tensor], optimizer: torch.optim.Optimizer, generators: Sequence[torch.Generator], device: torch.device):
        self.step = step
        self.optimizer = optimizer
        self.generators = generators
        self.graphed = device.type == "cuda"
        self.stream = torch.cuda.Stream(device) if self.graphed else None
        self.graph: torch.cuda.CUDAGraph | None = None
        self.loss: torch.Tensor | None = None
        self.calls = 0

    def __call__(self) -> torch.Tensor:
        self.calls += 1
        if not self.graphed:
            self.optimizer.zero_grad(set_to_none=True)
            return self.step()
        assert self.stream is not None
        if self.calls <= WARMUP:
            self.stream.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(self.stream):
                self.optimizer.zero_grad(set_to_none=True)
                loss = self.step()
            torch.cuda.current_stream().wait_stream(self.stream)
            return loss
        if self.graph is None:
            self.graph = torch.cuda.CUDAGraph()
            for generator in self.generators:
                self.graph.register_generator_state(generator)
            # Gradients created inside the capture are rewritten, not added to, by every replay.
            self.optimizer.zero_grad(set_to_none=True)
            with torch.cuda.graph(self.graph):
                self.loss = self.step()
        self.graph.replay()
        assert self.loss is not None
        return self.loss
