"""Command line:

    python -m pmatch train <analysis.safetensors> --out <model.pmwm> [--checkpoint <model.pt>] [--device cuda|cpu] [--seed 1]
    python -m pmatch parity <fixture.json>

`train` prints one JSON object per line: {"stage", "share"} while it works, then {"done", "report", "trainer"},
or {"error"} (and exits 1) when it fails."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

# Deterministic cuBLAS (training is reproducible); it must be set before CUDA starts.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")


def emit(**fields: object) -> None:
    print(json.dumps(fields), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pmatch")
    commands = parser.add_subparsers(dest="command", required=True)
    train_cmd = commands.add_parser("train", help="train a world model on an analysis exported by the browser")
    train_cmd.add_argument("dataset")
    train_cmd.add_argument("--out", required=True, help="the model, as the effect stores it")
    train_cmd.add_argument("--checkpoint", help="also save the PyTorch checkpoint here")
    train_cmd.add_argument("--device", help="cuda or cpu (default: cuda when available)")
    train_cmd.add_argument("--seed", type=int, default=1)
    train_cmd.add_argument("--channels", type=int, help="channels of the audio network")
    train_cmd.add_argument("--bank", type=int, help="particles in the bank the effect draws from")
    parity_cmd = commands.add_parser("parity", help="write the fixture the app's network test checks against")
    parity_cmd.add_argument("out")
    args = parser.parse_args(argv)

    if args.command == "parity":
        from . import parity

        parity.write(args.out)
        print(f"wrote {args.out}")
        return 0

    try:
        import torch

        from .dataset import load
        from .train import TrainOptions, train

        options = TrainOptions(device=args.device, seed=args.seed)
        if args.channels:
            options.dynamics.channels = args.channels
        if args.bank:
            options.bank = args.bank
        model = train(load(args.dataset), options, lambda stage, share: emit(stage=stage, share=round(share, 4)))
        Path(args.out).write_bytes(model.encode())
        if args.checkpoint:
            torch.save(model.checkpoint(), args.checkpoint)
        emit(done=True, out=str(args.out), report=model.settings.report, trainer=model.settings.trainer)
        return 0
    except Exception as e:  # reported to the caller as one line; the traceback goes to stderr
        traceback.print_exc()
        emit(error=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
