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
#   - effects: py-aep only adds an effect the project already defines (LIST:EfdG;
#     its baked table holds just Transform). Use `install_effects(suite, [...])`
#     before `add_effect(layer, match_name, ...)`: it clones each definition from
#     an After Effects-saved donor project and registers it as AE does.
import json
import os
import struct
import sys
import traceback
from io import BytesIO
from pathlib import Path

PY_AEP = Path(os.environ.get("PY_AEP", "C:/Users/schxm/projects/_ref/py-aep"))
sys.path.insert(0, str(PY_AEP / "src"))
import py_aep  # noqa: E402
from py_aep.binary.chunk import read_chunks, write_chunk  # noqa: E402
from py_aep.binary.mutations import clone_chunk_tree  # noqa: E402
from py_aep.binary.utils import filter_by_list_type, find_by_list_type  # noqa: E402
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


# --- Effects ----------------------------------------------------------------------

#: Projects saved by After Effects whose effect definitions (LIST:EfdG) can be cloned.
#: The py-aep corpus is searched after these.
EFFECT_DONORS = [
    os.environ.get("AEP_EFFECT_DONOR"),
    str(PY_AEP / "samples" / "versions" / "ae2025" / "complete.aep"),
    "C:/Users/schxm/projects/_user/bass-supreme.aep",
    "C:/Users/schxm/Downloads/TN 2020 2.aep",
]
DONOR_CACHE = REFS / "effect-donors.json"


def _chunk_bytes(kind: str, payload: bytes) -> bytes:
    return kind.encode() + struct.pack(">I", len(payload)) + payload + (b"\0" if len(payload) % 2 else b"")


def _read_one(raw: bytes):
    return read_chunks(BytesIO(raw), len(raw))[0]


def _donor_definitions(path: str, wanted: set[str]) -> dict:
    """Match name -> cloned LIST:EfDf for the wanted effects that `path` defines."""
    raw = Path(path).read_bytes()
    if not any(name.encode() in raw for name in wanted):
        return {}
    try:
        efdg = find_by_list_type(py_aep.parse(path).project._rifx.chunks, "EfdG")
    except Exception:  # noqa: BLE001 - unreadable donor or no definitions
        return {}
    found = {}
    for efdf in filter_by_list_type(efdg.chunks, "EfDf"):
        tdmn = next((c for c in efdf.chunks if getattr(c, "chunk_type", "") == "tdmn"), None)
        if tdmn is not None and tdmn.value in wanted:
            found[tdmn.value] = clone_chunk_tree(efdf)
    return found


def _donor_candidates() -> tuple[list[str], dict]:
    cached = json.loads(DONOR_CACHE.read_text(encoding="utf-8")) if DONOR_CACHE.exists() else {}
    explicit = [d for d in EFFECT_DONORS if d and Path(d).exists()]
    corpus = sorted(str(p) for p in (PY_AEP / "samples").rglob("*.aep"))
    return list(dict.fromkeys([*cached.values(), *explicit, *corpus])), cached


def install_effects(suite: "Suite", match_names: list[str]) -> None:
    """Defines the effects in the suite's project so `add_effect` can apply them."""
    wanted = set(match_names)
    candidates, cached = _donor_candidates()
    defs: dict = {}
    for name, donor in cached.items():
        if name in wanted and Path(donor).exists():
            defs.update({k: v for k, v in _donor_definitions(donor, {name}).items()})
    for donor in candidates:
        missing = wanted - defs.keys()
        if not missing:
            break
        for name, efdf in _donor_definitions(donor, missing).items():
            defs[name] = efdf
            cached[name] = donor
    if wanted - defs.keys():
        raise SystemExit(f"no donor project defines {sorted(wanted - defs.keys())}; set AEP_EFFECT_DONOR")
    REFS.mkdir(parents=True, exist_ok=True)
    DONOR_CACHE.write_text(json.dumps(dict(sorted(cached.items())), indent=1) + "\n", encoding="utf-8")

    rifx = suite.project._rifx
    existing = []
    try:
        old = find_by_list_type(rifx.chunks, "EfdG")
        existing = [c for c in filter_by_list_type(old.chunks, "EfDf")]
        index = rifx.chunks.index(old)
        rifx.chunks.remove(old)
    except Exception:  # noqa: BLE001 - the base project defines no effects yet
        index = None
    have = {next(c for c in e.chunks if getattr(c, "chunk_type", "") == "tdmn").value for e in existing}
    entries = existing + [defs[n] for n in match_names if n not in have]
    blobs = []
    for entry in entries:
        buf = BytesIO()
        write_chunk(buf, entry)
        blobs.append(buf.getvalue())
    efdg = _read_one(_chunk_bytes("LIST", b"EfdG" + _chunk_bytes("EfDC", struct.pack("<I", len(blobs))) + b"".join(blobs)))
    pefl = find_by_list_type(rifx.chunks, "Pefl")
    names = {getattr(c, "value", None) for c in pefl.chunks}
    for name in match_names:
        if name not in names:
            pefl.chunks.append(_read_one(_chunk_bytes("pjef", name.encode() + b"\0")))
    rifx.chunks.insert(index if index is not None else rifx.chunks.index(pefl) + 1, efdg)
    suite.project._effect_definitions_cache = None


def _leaves(group):
    for child in group.properties:
        if hasattr(child, "properties"):
            yield from _leaves(child)
        else:
            yield child


def set_layer_param(prop, layer) -> None:
    """Layer parameters keep the referenced layer's id in a tdpi chunk (py-aep's value setter writes only cdat)."""
    prop._ensure_materialized()
    prop._tdpi.value = layer.id if layer is not None else 0


def add_effect(layer, match_name: str, **params):
    """Applies an installed effect; params by 1-based index, e.g. add_effect(l, "ADBE Fill", p2=[1, 0, 0, 1]).

    Parameters start at the defaults stored in the donor's definition, which are
    not always AE's factory defaults: set every parameter a fixture depends on.
    """
    fx = layer["ADBE Effect Parade"].add_property(match_name)
    # Definitions are often stored switched off; an applied effect is on.
    fx.enabled = True
    # A cloned definition still names the donor's layers (AE then fails with "cannot find layer id").
    for leaf in _leaves(fx):
        if getattr(leaf, "_tdpi", None) is not None and not leaf.match_name.endswith("-0000"):
            leaf._tdpi.value = 0
    for key, value in params.items():
        fx[f"{match_name}-{int(key[1:]):04d}"].value = value
    return fx


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
