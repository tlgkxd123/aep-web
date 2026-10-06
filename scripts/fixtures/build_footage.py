# Builds refs/fixtures/footage.aep: footage layers (stills, image sequences, an
# H.264 clip, placeholders, missing files) with their Interpret Footage settings,
# authored with py-aep on the media in refs/media (see make_media.ts).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_footage.py
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, REFS, Suite, tr  # noqa: E402
from py_aep import ImportOptions  # noqa: E402
from py_aep.binary.footage_chunks import OptiChunk, build_generic_opti_data  # noqa: E402
from py_aep.enums import AlphaMode  # noqa: E402

MEDIA = REFS.parent / "media"
GRAY = [0.5, 0.5, 0.5]

suite = Suite("footage")
case = suite.case
project = suite.project


def relative_to_project(item, relative: str) -> None:
    """Records the media path relative to refs/fixtures/footage.aep as well, the
    way AE does, so the project still finds refs/media after the repo moves."""
    pin = item.main_source._pin
    als2 = next(c for c in pin.chunks if getattr(c, "list_type", None) == "Als2")
    alas = als2.chunks[0]
    data = json.loads(alas.value)
    data["ascendcount_base"] = 2
    data["ascendcount_target"] = len(Path(relative).parts) + (1 if data["target_is_folder"] else 0)
    alas.value = json.dumps(data, sort_keys=True, separators=(",", ":"))


def for_ae_2025(item, name: str, sequence: bool) -> None:
    """py-aep writes the importer records AE 2026 accepts; the AE 2025 that
    renders the references fails a PNG still with an empty `opti` ("error in the
    PNG format plugin") and does not find a BMP tagged with the macOS still
    importer. Give them the generic header and the Windows importer code."""
    source = item.main_source
    suffix = Path(name).suffix.lower()
    code = "STIL" if suffix == ".bmp" else "png!" if suffix == ".png" and not sequence else None
    if code is None:
        return
    source._sspc.source_format_type = code
    data = build_generic_opti_data(code)
    source._swap_opti(OptiChunk.read(io.BytesIO(data), len(data), chunk_type="opti"))


def footage(name: str, sequence: bool = False):
    options = ImportOptions(MEDIA / name)
    options.sequence = sequence
    item = project.import_file(options)
    for_ae_2025(item, name, sequence)
    relative_to_project(item, "media/" + (str(Path(name).parent).replace("\\", "/") if sequence else name))
    item.parent_folder = suite.folder
    return item


def centered(comp, item, bg=True):
    if bg:
        comp.add_solid(GRAY, "bg")
    return comp.add(item)


straight = footage("straight.png")
straight_ignore = footage("straight.png")
straight_ignore.main_source.alpha_mode = AlphaMode.IGNORE
straight_invert = footage("straight.png")
straight_invert.main_source.invert_alpha = True
premul = footage("premul.png")
premul.main_source.alpha_mode = AlphaMode.PREMULTIPLIED
premul.main_source.premul_color = [64 / 255, 128 / 255, 1.0]
premul_black = footage("premul.png")
premul_black.main_source.alpha_mode = AlphaMode.PREMULTIPLIED
premul_black.main_source.premul_color = [0.0, 0.0, 0.0]
photo = footage("photo.jpg")
bmp = footage("still.bmp")
tiff = footage("alpha.tif")
tiff_raw = footage("alpha_raw.tif")
tiff_assoc = footage("alpha_assoc.tif")
tiff_assoc_premul = footage("alpha_assoc.tif")
tiff_assoc_premul.main_source.alpha_mode = AlphaMode.PREMULTIPLIED
tiff_assoc_premul.main_source.premul_color = [0.0, 0.0, 0.0]
big = footage("big.png")
wide = footage("photo.jpg")
wide.pixel_aspect = 2.0


@case("footage_png_straight")
def _(comp):
    centered(comp, straight)


@case("footage_png_straight_clear", frames=(0,))
def _(comp):
    comp.add(straight)


@case("footage_png_ignore")
def _(comp):
    centered(comp, straight_ignore)


@case("footage_png_invert")
def _(comp):
    centered(comp, straight_invert)


@case("footage_png_premul")
def _(comp):
    comp.add(premul)


@case("footage_png_premul_black")
def _(comp):
    comp.add(premul_black)


@case("footage_jpeg")
def _(comp):
    centered(comp, photo, bg=False)


@case("footage_bmp")
def _(comp):
    comp.add(bmp)


@case("footage_tiff")
def _(comp):
    centered(comp, tiff)


@case("footage_tiff_raw")
def _(comp):
    centered(comp, tiff_raw)


@case("footage_tiff_assoc")
def _(comp):
    centered(comp, tiff_assoc)


@case("footage_tiff_assoc_premul")
def _(comp):
    centered(comp, tiff_assoc_premul)


@case("footage_big")
def _(comp):
    comp.add(big)


@case("footage_big_offset")
def _(comp):
    layer = comp.add(big)
    tr(layer, "ADBE Position").value = [30.0, 100.0, 0.0]


@case("footage_pixel_aspect")
def _(comp):
    centered(comp, wide)


@case("footage_comp_aspect")
def _(comp):
    comp.pixel_aspect = 0.9
    layer = comp.add(photo)
    tr(layer, "ADBE Position").value = [50.0, 60.0, 0.0]


# --- Image sequences (seq_0001..seq_0012, 64x48) -------------------------------
SW, SH = 64, 48

seq30 = footage("seq/seq_0001.png", sequence=True)
seq12 = footage("seq/seq_0001.png", sequence=True)
seq12.main_source.conform_frame_rate = 12.0
seq24 = footage("seq/seq_0001.png", sequence=True)
seq24.main_source.conform_frame_rate = 24.0
seq_loop = footage("seq/seq_0001.png", sequence=True)
seq_loop.main_source.conform_frame_rate = 24.0
seq_loop.main_source.loop = 3

ALL24 = tuple(range(24))


@case("footage_seq_30fps", frames=ALL24, width=SW, height=SH)
def _(comp):
    comp.add(seq30)


@case("footage_seq_12fps", frames=ALL24, width=SW, height=SH)
def _(comp):
    comp.add(seq12)


@case("footage_seq_stretch", frames=ALL24, width=SW, height=SH)
def _(comp):
    layer = comp.add(seq24)
    layer.stretch = 150.0
    layer.start_time = 0.1


@case("footage_seq_offset", frames=ALL24, width=SW, height=SH)
def _(comp):
    layer = comp.add(seq24)
    layer.start_time = -0.02


@case("footage_seq_loop", frames=tuple(range(0, 36, 1)), width=SW, height=SH, duration=1.5)
def _(comp):
    comp.add(seq_loop)


@case("footage_seq_remap", frames=ALL24, width=SW, height=SH)
def _(comp):
    layer = comp.add(seq24)
    layer.time_remap_enabled = True
    remap = layer["ADBE Time Remapping"]
    remap.set_value_at_time(0.0, 0.0)
    remap.set_value_at_time(1.0, 0.37)


@case("footage_seq_reverse", frames=ALL24, width=SW, height=SH)
def _(comp):
    layer = comp.add(seq24)
    layer.stretch = -100.0
    layer.start_time = 0.5


# --- H.264 clip (30 frames at 30 fps, 96x64) ---------------------------------
VW, VH = 96, 64

clip = footage("clip.mp4")
clip_conform = footage("clip.mp4")
clip_conform.main_source.conform_frame_rate = 15.0
clip_loop = footage("clip.mp4")
clip_loop.main_source.loop = 2


@case("footage_video", frames=ALL24, width=VW, height=VH)
def _(comp):
    comp.add(clip)


@case("footage_video_conform", frames=ALL24, width=VW, height=VH)
def _(comp):
    comp.add(clip_conform)


@case("footage_video_loop", frames=tuple(range(0, 48, 2)), width=VW, height=VH, duration=2.0)
def _(comp):
    comp.add(clip_loop)


@case("footage_video_stretch", frames=ALL24, width=VW, height=VH)
def _(comp):
    layer = comp.add(clip)
    layer.stretch = 80.0
    layer.start_time = 0.05


hd = footage("hd.mp4")


@case("footage_video_hd", frames=(0, 1, 2, 3, 4), width=VW, height=VH, duration=0.25)
def _(comp):
    layer = comp.add(hd)
    tr(layer, "ADBE Position").value = [640.0, 360.0, 0.0]


@case("footage_png_transformed")
def _(comp):
    comp.add_solid(GRAY, "bg")
    layer = comp.add(straight)
    tr(layer, "ADBE Scale").value = [130.0, 80.0, 100.0]
    tr(layer, "ADBE Rotate Z").value = 20.0


# --- Placeholders and missing files --------------------------------------------
# aerender refuses to render a comp that uses either ("Can't render: file not
# found"), so these comps have no reference frames and stay out of the manifest.
placeholder = project.import_placeholder("footage placeholder", 80, 60, 24.0, 1.0)
placeholder.parent_folder = suite.folder

gone_dir = Path(tempfile.mkdtemp(prefix="aep-footage-"))
gone_file = gone_dir / "gone.png"
shutil.copy(MEDIA / "straight.png", gone_file)
missing = project.import_file(ImportOptions(gone_file))
relative_to_project(missing, "media/gone.png")
missing.parent_folder = suite.folder

for name, item in (("footage_placeholder", placeholder), ("footage_missing", missing)):
    comp = suite.folder.add_comp(name, 160, 120, 1.0, 1.0, 24.0)
    centered(comp, item)

suite.save()
shutil.rmtree(gone_dir, ignore_errors=True)

manifest_path = REFS / suite.manifest_file
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["media"] = sorted(str(p.relative_to(REFS.parent)).replace("\\", "/") for p in MEDIA.rglob("*") if p.is_file())
manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
