# Probe: what py-aep (MIT, https://github.com/forticheprod/py-aep) writes for new
# layers, and which bytes change with the comp and layer settings.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/probe_layers.py
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BASE, py_aep  # noqa: E402
from py_aep.binary.chunk import write_chunk  # noqa: E402


def leaves(chunk, path=""):
    kind = getattr(chunk, "chunk_type", "?")
    lt = getattr(chunk, "list_type", None)
    if lt is not None:
        seen = {}
        for c in chunk.chunks:
            key = getattr(c, "list_type", None) or getattr(c, "chunk_type", "?")
            if getattr(c, "chunk_type", "") == "tdmn":
                buf = BytesIO()
                write_chunk(buf, c)
                key = "tdmn=" + buf.getvalue()[8:].rstrip(b"\0").decode()
            seen[key] = seen.get(key, 0) + 1
            yield from leaves(c, f"{path}/{key}#{seen[key]}")
        return
    buf = BytesIO()
    write_chunk(buf, chunk)
    yield path, buf.getvalue()[8:]


def build(mode, w=160, h=120, par=1.0, dur=1.0, fps=24.0, sw=60, sh=40, color=(1.0, 0.5, 0.0)):
    app = py_aep.parse(BASE)
    project = app.project
    folder = project.root_folder.add_folder("probe")
    comp = folder.add_comp("probe_comp", w, h, par, dur, fps)
    if mode == "solid":
        layer = comp.add_solid(list(color), "box", sw, sh)
    elif mode == "null":
        layer = comp.add_null()
    elif mode == "shape":
        layer = comp.add_shape()
    elif mode == "comp":
        inner = folder.add_comp("inner", sw, sh, 1.0, 2.0, fps)
        layer = comp.add(inner)
    elif mode == "item":
        donor = folder.add_comp("donor", w, h, par, dur, fps)
        solid = donor.add_solid(list(color), "box", sw, sh)
        layer = comp.add(project.items[solid._ldta.source_id])
    chunks = comp._item_list.chunks
    start, end = comp._layer_block_slice(layer)
    out = {}
    for i, c in enumerate(chunks[start:end]):
        for p, raw in leaves(c, f"L{i}"):
            out[p] = raw
    if mode in ("solid", "null"):
        for p, raw in leaves(project.items[layer._ldta.source_id]._item_list, "S"):
            out[p] = raw
    return out


def diff(a, b, label):
    print(f"== {label}")
    for p in sorted(set(a) | set(b)):
        x, y = a.get(p), b.get(p)
        if x == y:
            continue
        if x is None or y is None or len(x) != len(y):
            print(f"  {p}: length {None if x is None else len(x)} vs {None if y is None else len(y)}")
            continue
        offs = [i for i in range(len(x)) if x[i] != y[i]]
        print(f"  {p}: offsets {offs[:40]}")


mode = sys.argv[1] if len(sys.argv) > 1 else "solid"
base = build(mode)
if "--dump" in sys.argv:
    for p, raw in base.items():
        print(p, len(raw), raw.hex())
diff(base, build(mode), "same again")
diff(base, build(mode, w=1920, h=1080), "comp size")
diff(base, build(mode, fps=29.97), "fps 29.97")
diff(base, build(mode, fps=25.0), "fps 25")
diff(base, build(mode, par=0.9), "par 0.9")
diff(base, build(mode, dur=3.0), "duration 3")
if mode in ("solid", "comp"):
    diff(base, build(mode, sw=200, sh=50), "source size")
if mode == "solid":
    diff(base, build(mode, color=(0.2, 0.3, 0.4)), "color")
