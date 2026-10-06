# Shared helpers for building After Effects fixture projects with py-aep
# (MIT, https://github.com/forticheprod/py-aep). Every suite starts from an
# AE 25.6 project that uses AE's default color settings (8 bpc, no working
# space, no linearization), so After Effects 2025 can open and render it.
#
# A suite writes refs/fixtures/<suite>.aep and refs/fixtures/<suite>.manifest.json;
# scripts/render-refs.ts and scripts/pixel-report.ts pick up every manifest.
#
# py-aep authoring quirks found so far (AE reads these differently from py-aep):
#   - static 2D spatial positions of shape items (Rect/Ellipse/Star Position,
#     Repeater Position/Anchor) are ignored by AE; place items with group
#     transforms instead.
#   - py-aep divides mask points by the layer size, but AE reads masks on
#     sourceless (shape/text) layers as layer pixels; pre-scale by (W, H).
#   - stroke dashes cannot be added (add_property raises).
import json
import os
import sys
import traceback
from pathlib import Path

PY_AEP = Path(os.environ.get("PY_AEP", "C:/Users/schxm/projects/_ref/py-aep"))
sys.path.insert(0, str(PY_AEP / "src"))
import py_aep  # noqa: E402
from py_aep.enums import BlendingMode, MaskMode, TrackMatteType  # noqa: E402,F401
from py_aep.models.properties.shape import Shape  # noqa: E402

BASE = PY_AEP / "samples" / "bugs" / "windows-1250_decoding_error.aep"
REFS = Path(__file__).resolve().parents[2] / "refs" / "fixtures"
W, H, FPS, DUR = 160, 120, 24.0, 1.0

BG = [0.12, 0.16, 0.30]
ORANGE = [1.0, 0.5, 0.0]
TEAL = [0.1, 0.7, 0.65]


class Suite:
    """One fixture project. Comp names must be unique across all suites (prefix them)."""

    def __init__(self, name: str, project_file: str | None = None, manifest_file: str | None = None):
        self.name = name
        self.project_file = project_file or f"{name}.aep"
        self.manifest_file = manifest_file or f"{name}.manifest.json"
        self.app = py_aep.parse(BASE)
        self.project = self.app.project
        self.folder = self.project.root_folder.add_folder(name)
        self.manifest: list[dict] = []
        self.failures: list[str] = []

    def case(self, name: str, frames=(0,), width=W, height=H, duration=DUR, fps=FPS):
        def wrap(build):
            try:
                comp = self.folder.add_comp(name, width, height, 1.0, duration, fps)
                build(comp)
                self.manifest.append({"comp": name, "frames": list(frames), "fps": fps})
            except Exception:  # noqa: BLE001 - one failing case must not block the rest
                self.failures.append(f"{name}: {traceback.format_exc(limit=3)}")
            return build

        return wrap

    def save(self) -> None:
        REFS.mkdir(parents=True, exist_ok=True)
        (REFS / self.project_file).unlink(missing_ok=True)
        self.project.save(REFS / self.project_file)
        (REFS / self.manifest_file).write_text(
            json.dumps({"project": self.project_file, "comps": self.manifest}, indent=1) + "\n", encoding="utf-8"
        )
        print(f"built {len(self.manifest)} comps into {REFS / self.project_file}")
        for failure in self.failures:
            print("FAILED", failure)


def tr(layer, match_name):
    return layer["ADBE Transform Group"][match_name]


def rect(x0, y0, x1, y1):
    return Shape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], [[0, 0]] * 4, [[0, 0]] * 4, closed=True)


def add_mask(layer, shape, mode=MaskMode.ADD, inverted=False, opacity=None, feather=None):
    mask = layer["ADBE Mask Parade"].add_property("ADBE Mask Atom")
    mask["ADBE Mask Shape"].value = shape
    mask.mask_mode = mode
    if inverted:
        mask.inverted = True
    if opacity is not None:
        mask["ADBE Mask Opacity"].value = opacity
    if feather is not None:
        mask["ADBE Mask Feather"].value = [feather, feather]
    return mask


# --- Shape layers ---------------------------------------------------------------


def shape_group(layer_or_group, name=None):
    contents = (
        layer_or_group["ADBE Root Vectors Group"]
        if hasattr(layer_or_group, "containing_comp")
        else layer_or_group["ADBE Vectors Group"]
    )
    group = contents.add_property("ADBE Vector Group")
    if name:
        group.name = name
    return group


def add(group, match_name, **values):
    item = group["ADBE Vectors Group"].add_property(match_name)
    for key, value in values.items():
        item[key].value = value
    return item


def fill(group, color, **values):
    return add(group, "ADBE Vector Graphic - Fill", **{"ADBE Vector Fill Color": color + [1.0]}, **values)


def stroke(group, color, width, **values):
    return add(
        group,
        "ADBE Vector Graphic - Stroke",
        **{"ADBE Vector Stroke Color": color + [1.0], "ADBE Vector Stroke Width": width},
        **values,
    )


def gtr(group, match_name, value):
    group["ADBE Vector Transform Group"][match_name].value = value


def shape_comp(comp):
    comp.add_solid(BG, "bg")
    return comp.add_shape()
