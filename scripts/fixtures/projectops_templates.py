# Builds the chunk templates the browser's project operations clone
# (src/edit/data/project-templates.json):
#   - "empty": the AE 25.6 fixture base project (8 bpc, no working space) with
#     every item and render-queue item removed (File > New > New Project);
#   - "templates": the same empty project plus one item of each kind, authored
#     with py-aep (MIT, https://github.com/forticheprod/py-aep): a folder
#     (add_folder), a composition (add_comp), file footage (import_file of a
#     PNG, a JPEG, an MP4 and a PNG sequence) and a composition holding a solid
#     and a footage layer (add_solid / add).
# The TS side clones these item blocks and patches ids, names, sizes, times and
# file paths. Color-profile records are left empty (py-aep's no-ICC-store
# path): the profile bytes AE would embed come from Adobe's ICC library.
#
# Run through `node scripts/projectops-templates.ts`, which packs the output
# (argv[1], a JSON file of base64 projects) into the item blocks the app ships.
import base64
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BASE, py_aep  # noqa: E402

import py_aep.models.sources.file as file_source  # noqa: E402
from py_aep.models.import_options import ImportOptions  # noqa: E402

file_source._catalogued_profile = lambda name: None

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "refs" / "media"


def empty_project():
    app = py_aep.parse(BASE)
    project = app.project
    for item in list(project.root_folder.items):
        item.remove()
    return app, project


def save_bytes(project) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "out.aep"
        project.save(path)
        return path.read_bytes()


def footage(project, path: Path, name: str, sequence: bool = False):
    options = ImportOptions(path)
    if sequence:
        options.sequence = True
    item = project.import_file(options)
    item.name = name
    return item


def main() -> None:
    _, project = empty_project()
    empty = save_bytes(project)

    _, project = empty_project()
    project.root_folder.add_folder("T_FOLDER")
    comp = project.root_folder.add_comp("T_COMP", 640, 360, 1.0, 10.0, 25.0)
    png = footage(project, MEDIA / "straight.png", "T_PNG")
    footage(project, MEDIA / "photo.jpg", "T_JPEG")
    footage(project, MEDIA / "clip.mp4", "T_MP4")
    footage(project, MEDIA / "seq" / "seq_0001.png", "T_SEQ", sequence=True)
    layers = project.root_folder.add_comp("T_LAYERS", 640, 360, 1.0, 10.0, 25.0)
    layers.add(png)
    layers.add_solid([1.0, 0.0, 0.0], "T_SOLID")
    del comp
    templates = save_bytes(project)

    out = Path(sys.argv[1])
    out.write_text(
        json.dumps(
            {
                "empty": base64.b64encode(empty).decode("ascii"),
                "templates": base64.b64encode(templates).decode("ascii"),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"empty {len(empty)} bytes, templates {len(templates)} bytes -> {out}")


if __name__ == "__main__":
    main()
