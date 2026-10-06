# Exports the chunk layouts py-aep (MIT, https://github.com/forticheprod/py-aep)
# writes for new layers and solids to src/edit/data/layer-templates.json, and
# reference blocks for several comp and layer settings to
# tests/data/layer-templates-cases.json, which tests/layer-ops.test.ts compares
# src/edit/layers.ts against byte for byte.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/export_layer_templates.py
import base64
import json
import subprocess
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BASE, PY_AEP, py_aep  # noqa: E402
from py_aep.binary.chunk import write_chunk  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def b64(chunk) -> str:
    buf = BytesIO()
    write_chunk(buf, chunk)
    return base64.b64encode(buf.getvalue()).decode()


def layer_block(comp, layer) -> list[str]:
    start, end = comp._layer_block_slice(layer)
    return [b64(c) for c in comp._item_list.chunks[start:end]]


def item_block(folder, item) -> list[str]:
    """The item's LIST:Item and the view septet that follows it in the folder."""
    chunks = folder._children_container
    i = next(k for k, c in enumerate(chunks) if c is item._item_list)
    end = i + 1
    while end < len(chunks) and getattr(chunks[end], "list_type", None) is None:
        end += 1
    return [b64(c) for c in chunks[i:end]]


def new_comp(w=160, h=120, par=1.0, dur=1.0, fps=24.0):
    project = py_aep.parse(BASE).project
    folder = project.root_folder.add_folder("templates")
    return project, folder, folder.add_comp("templates_comp", w, h, par, dur, fps)


def make(kind, **settings):
    """One new layer of `kind` in a fresh comp: (inputs, layer block, source item block)."""
    project, folder, comp = new_comp(**{k: v for k, v in settings.items() if k in ("w", "h", "par", "dur", "fps")})
    head_before = project._head.next_item_id
    solid_args = settings.get("solid", ([1.0, 0.5, 0.0], "box", 60, 40, 1.0))
    if kind == "solid":
        color, name, sw, sh, spar = solid_args
        layer = comp.add_solid(color, name, sw, sh, spar)
    elif kind == "null":
        layer = comp.add_null()
    elif kind == "shape":
        layer = comp.add_shape()
    elif kind == "comp":
        inner = folder.add_comp("templates_inner", 80, 60, 1.0, settings.get("inner_dur", 2.0), comp.frame_rate)
        head_before = project._head.next_item_id
        layer = comp.add(inner)
    else:
        raise ValueError(kind)
    source = project.items.get(layer._ldta.source_id) if kind in ("solid", "null") else None
    solids = project._solids_folder
    case = {
        "kind": kind,
        "comp": {"width": comp.width, "height": comp.height, "pixelAspect": comp.pixel_aspect, "duration": comp.duration,
                 "frameRate": comp.frame_rate, "internalTimebase": comp._cdta.internal_timebase},
        "headBefore": head_before,
        "headAfter": project._head.next_item_id,
        "layerId": layer.id,
        "sourceId": layer._ldta.source_id,
        "label": layer.label.value if hasattr(layer.label, "value") else int(layer.label),
        "layerName": layer.name,
        "layer": layer_block(comp, layer),
    }
    if kind == "solid":
        case["solid"] = {"color": solid_args[0], "name": solid_args[1], "width": solid_args[2], "height": solid_args[3], "pixelAspect": solid_args[4]}
    if source is not None:
        case["sourceName"] = source.name
        case["solidsFolderId"] = solids.id
        case["item"] = item_block(solids, source)
    if kind == "comp":
        case["source"] = {"width": 80, "height": 60, "duration": settings.get("inner_dur", 2.0)}
    return case


def folder_template():
    project = py_aep.parse(BASE).project
    folder = project.root_folder.add_folder("Solids")
    root = project.root_folder
    return item_block(root, folder)


TRANSFORM_VALUES = {
    "ADBE Anchor Point": [1.0, 2.0, 0.0],
    "ADBE Position": [3.0, 4.0, 0.0],
    "ADBE Scale": [50.0, 60.0, 100.0],
    "ADBE Rotate Z": 7.0,
    "ADBE Opacity": 50.0,
}


def transform_props(kind):
    """Every Transform property of a new `kind` layer with non-default values, so py-aep writes each one:
    (matchName order, {matchName: [tdmn, property list]})."""
    _, _, comp = new_comp()
    layer = comp.add_solid([1.0, 0.0, 0.0], "t", 10, 10, 1.0) if kind == "solid" else comp.add_shape()
    for match_name, value in TRANSFORM_VALUES.items():
        layer.transform[match_name].value = value
    group = layer.transform._tdgp if hasattr(layer.transform, "_tdgp") else None
    if group is None:
        layr = layer._layer_list
        root = next(c for c in layr.chunks if getattr(c, "list_type", None) == "tdgp")
        i = next(k for k, c in enumerate(root.chunks) if c.chunk_type == "tdmn" and c.value == "ADBE Transform Group")
        group = root.chunks[i + 1]
    order, props = [], {}
    chunks = group.chunks
    for k, c in enumerate(chunks):
        if c.chunk_type == "tdmn" and k + 1 < len(chunks) and getattr(chunks[k + 1], "list_type", None):
            order.append(c.value)
            props[c.value] = [b64(c), b64(chunks[k + 1])]
    return order, props


commit = subprocess.run(["git", "-C", str(PY_AEP), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
base = {k: make(k) for k in ("solid", "null", "shape", "comp")}
templates = {
    "source": f"py-aep {commit}, {BASE.name}",
    "avLayer": base["comp"]["layer"],
    "shapeLayer": base["shape"]["layer"],
    "solidItem": base["solid"]["item"],
    "nullItem": base["null"]["item"],
    "folderItem": folder_template(),
}
order, props = transform_props("solid")
templates["transformOrder"] = order
templates["transformProps"] = props
shape_order, shape_props = transform_props("shape")
out = ROOT / "src" / "edit" / "data" / "layer-templates.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(templates, indent=1) + "\n", encoding="utf-8")

cases = [
    *base.values(),
    make("solid", w=1920, h=1080, fps=29.97, dur=5.0, solid=([0.2, 0.3, 0.4], "Deep Blue Solid 1", 640, 360, 1.0)),
    make("solid", w=720, h=480, par=0.9, fps=25.0, dur=2.0, solid=([1.0, 1.0, 1.0], "Adjustment Layer 1", 720, 480, 0.9)),
    make("null", w=1280, h=720, fps=30.0, dur=10.0),
    make("shape", w=333, h=777, fps=23.976, dur=3.0),
    make("comp", w=640, h=360, fps=60.0, dur=4.0, inner_dur=7.5),
]
check = ROOT / "tests" / "data" / "layer-templates-cases.json"
check.parent.mkdir(parents=True, exist_ok=True)
check.write_text(json.dumps(cases, indent=1) + "\n", encoding="utf-8")
transform_check = ROOT / "tests" / "data" / "transform-props-cases.json"
transform_check.write_text(json.dumps({"values": TRANSFORM_VALUES, "shapeOrder": shape_order, "shapeProps": shape_props}, indent=1) + "\n", encoding="utf-8")
print(f"wrote {out} and {len(cases)} cases to {check}")
