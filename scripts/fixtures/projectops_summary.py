# Prints, as JSON, what py-aep (MIT, https://github.com/forticheprod/py-aep)
# reads from projects written by the project operations: every item with its
# folder, kind, size and timing, footage file and alpha, and composition
# layers with their sources. scripts/projectops-check.ts compares it with
# aep-web's own parse.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/projectops_summary.py FILE.aep [...]
import json
import os
import sys
from pathlib import Path

PY_AEP = Path(os.environ.get("PY_AEP", "C:/Users/schxm/projects/_ref/py-aep"))
sys.path.insert(0, str(PY_AEP / "src"))
import py_aep  # noqa: E402


def item_summary(item):
    out = {
        "id": item.id,
        "name": item.name,
        "parent": item.parent_folder.id if item.parent_folder is not None else 0,
        "kind": type(item).__name__,
    }
    if hasattr(item, "width") and out["kind"] != "FolderItem":
        out.update(width=item.width, height=item.height, duration=float(item.duration), pixelAspect=float(item.pixel_aspect))
    if out["kind"] == "CompItem":
        out.update(
            frameRate=float(item.frame_rate),
            bgColor=[float(c) for c in item.bg_color],
            displayStartTime=float(item.display_start_time),
            layers=[{"id": layer.id, "name": layer.name, "source": getattr(getattr(layer, "source", None), "id", 0)} for layer in item.layers],
        )
    if out["kind"] == "FootageItem":
        source = item.main_source
        out["source"] = type(source).__name__
        if hasattr(source, "file"):
            out.update(file=str(source.file), hasAlpha=bool(source.has_alpha), isStill=bool(source.is_still))
    return out


result = {}
for arg in sys.argv[1:]:
    project = py_aep.parse(arg).project
    result[Path(arg).name] = sorted((item_summary(i) for i in project.items.values() if i.id != 0), key=lambda i: i["id"])
print(json.dumps(result))
