"""Sprite templates: a codebook of the reference's particle looks (soft dots, stars, rings...) learned from
crops the browser resampled to a common spread (sprites.ts `canonical`). k-means++ seeding, then Lloyd
iterations; a class's template is its members' per-pixel median (peak 1), so that the neighbours a few of
its crops caught leave no dots around it, and its tint is their mean colour."""

from __future__ import annotations

from dataclasses import dataclass

import torch

#: Gaussian spread (texels) a crop's own spread is mapped to; the template is TEMPLATE texels wide (sprites.ts).
TEMPLATE = 64
TEMPLATE_SIGMA = 4.0


@dataclass
class Codebook:
    templates: torch.Tensor
    tint: torch.Tensor
    #: Class of each crop (sorted by class size, largest first).
    labels: torch.Tensor


#: Crops a sprite class needs at least: this many, and this share of all.
MIN_CLASS = 10
MIN_CLASS_SHARE = 0.02
#: Crops whose distance to their CORE_NEIGHBOUR-th nearest crop is above this quantile do not seed classes:
#: an odd crop (two particles, a streak) would take a class of its own, which then has too few crops to keep.
CORE_NEIGHBOUR = 10
CORE_QUANTILE = 0.9


def class_count(crops: int) -> int:
    return 1 if crops < 60 else 2 if crops < 200 else 3 if crops < 600 else 4 if crops < 1000 else 6


def soft_dot(size: int = TEMPLATE) -> torch.Tensor:
    c = (torch.arange(size, dtype=torch.float32) + 0.5 - size / 2) / TEMPLATE_SIGMA
    return torch.exp(-0.5 * (c[None, :] ** 2 + c[:, None] ** 2))


def _lloyd(flat: torch.Tensor, centre: torch.Tensor, iterations: int) -> torch.Tensor:
    assign = torch.full((len(flat),), -1, dtype=torch.long, device=flat.device)
    for _ in range(iterations):
        nearest = torch.cdist(flat, centre).argmin(1)
        changed = bool((nearest != assign).any())
        assign = nearest
        for j in range(len(centre)):
            members = assign == j
            if members.any():
                centre[j] = flat[members].mean(0)
        if not changed:
            break
    return assign


def learn_codebook(templates: torch.Tensor, tints: torch.Tensor, generator: torch.Generator, iterations: int = 25) -> Codebook:
    n = templates.shape[0]
    device = templates.device
    if n == 0:
        return Codebook(soft_dot()[None].to(device), torch.ones(1, 3, device=device), torch.zeros(0, dtype=torch.long, device=device))
    size = templates.shape[-1]
    flat = templates.reshape(n, -1)
    k = min(class_count(n), n)
    pool = flat
    if n > CORE_NEIGHBOUR + 1:
        reach = torch.cdist(flat, flat).topk(CORE_NEIGHBOUR + 1, largest=False).values[:, -1]
        pool = flat[reach <= torch.quantile(reach, CORE_QUANTILE)]
    centres = [pool[torch.randint(len(pool), (1,), generator=generator, device=device)].squeeze(0)]
    while len(centres) < k:
        distance = torch.cdist(pool, torch.stack(centres)).square().min(1).values
        if float(distance.sum()) <= 0:
            break
        pick = torch.multinomial(distance / distance.sum(), 1, generator=generator)
        centres.append(pool[pick].squeeze(0))
    centre = torch.stack(centres)
    assign = _lloyd(flat, centre, iterations)
    # A class too small to learn a look from (a few odd crops) joins the others.
    smallest = max(MIN_CLASS, int(MIN_CLASS_SHARE * n))
    while len(centre) > 1:
        sizes = torch.bincount(assign, minlength=len(centre))
        j = int(sizes.argmin())
        if int(sizes[j]) >= smallest:
            break
        centre = torch.cat([centre[:j], centre[j + 1 :]])
        assign = _lloyd(flat, centre, iterations)
    k = len(centre)
    sizes = torch.bincount(assign, minlength=k)
    order = [j for j in torch.argsort(sizes, descending=True, stable=True).tolist() if sizes[j] > 0]
    out = torch.stack([flat[assign == j].median(0).values for j in order]).reshape(len(order), size, size)
    out = (out / out.amax((1, 2), keepdim=True).clamp(min=1e-6)).clamp(min=0)
    colour = torch.stack([tints[assign == j].sum(0) for j in order])
    colour = colour / colour.amax(1, keepdim=True).clamp(min=1e-6)
    slot = torch.full((k,), -1, dtype=torch.long, device=device)
    slot[torch.as_tensor(order, device=device)] = torch.arange(len(order), device=device)
    return Codebook(out, colour, slot[assign])
