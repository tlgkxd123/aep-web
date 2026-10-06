# Builds refs/fixtures/fxmisc.aep: Polar Coordinates, Audio Spectrum and Deep Glow 2
# fixtures. py-aep can only add an installed effect when the project already
# defines it (LIST:EfdG), so the definitions are cloned from a donor project:
# FXMISC_DONOR, else the previously built fxmisc.aep, else the user's project
# that first supplied them. Synthetic test tones are written to refs/fixtures/fxmisc_audio.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_fxmisc.py
import json
import math
import os
import random
import struct
import sys
import wave
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, BlendingMode, MaskMode, Shape, Suite, add, add_mask, fill, gtr, shape_group, tr  # noqa: E402

import py_aep  # noqa: E402
from py_aep import ImportOptions  # noqa: E402
from py_aep.binary.chunk import ListChunk, read_chunks, write_chunk  # noqa: E402
from py_aep.binary.mutations import clone_chunk_tree  # noqa: E402
from py_aep.binary.utils import filter_by_list_type, find_by_list_type  # noqa: E402
from py_aep.enums.property import PropertyControlType  # noqa: E402
from py_aep.models.properties.gradient import Gradient, GradientAlphaStop, GradientColorStop  # noqa: E402

EFFECTS = ["ADBE Polar Coordinates", "ADBE AudSpect", "PEDG2"]
#: Accepted approximations, "comp@frame" -> reason (still held to a mean error of 1/255).
KNOWN: dict[str, str] = {}
DONORS = [
    os.environ.get("FXMISC_DONOR"),
    str(REFS / "fxmisc.aep"),
    "C:/Users/schxm/Downloads/TN 2020 2.aep",
]
AUDIO = REFS / "fxmisc_audio"


def _chunk(kind: str, payload: bytes) -> bytes:
    return kind.encode() + struct.pack(">I", len(payload)) + payload + (b"\0" if len(payload) % 2 else b"")


def _read_one(raw: bytes):
    return read_chunks(BytesIO(raw), len(raw))[0]


def _efdf_chunks(path: str) -> dict:
    """Match name -> LIST:EfDf of the wanted effects defined in `path`."""
    rifx = py_aep.parse(path).project._rifx
    try:
        efdg = find_by_list_type(rifx.chunks, "EfdG")
    except Exception:  # noqa: BLE001 - no definitions in this donor
        return {}
    found = {}
    for efdf in filter_by_list_type(efdg.chunks, "EfDf"):
        tdmn = next(c for c in efdf.chunks if getattr(c, "chunk_type", "") == "tdmn")
        if tdmn.value in EFFECTS:
            found[tdmn.value] = clone_chunk_tree(efdf)
    return found


def install_effect_definitions(suite: Suite) -> None:
    """Adds LIST:EfdG entries (and Pefl names) for EFFECTS, as AE writes them."""
    defs = {}
    for donor in DONORS:
        if donor and Path(donor).exists() and len(defs) < len(EFFECTS):
            for name, efdf in _efdf_chunks(donor).items():
                defs.setdefault(name, efdf)
    missing = [e for e in EFFECTS if e not in defs]
    if missing:
        raise SystemExit(f"no donor project defines {missing}; set FXMISC_DONOR")
    rifx = suite.project._rifx
    efdfs = []
    for name in EFFECTS:
        buf = BytesIO()
        write_chunk(buf, defs[name])
        efdfs.append(buf.getvalue())
    efdg = _read_one(_chunk("LIST", b"EfdG" + _chunk("EfDC", struct.pack("<I", len(efdfs))) + b"".join(efdfs)))
    pefl = find_by_list_type(rifx.chunks, "Pefl")
    names = {getattr(c, "value", None) for c in pefl.chunks}
    for name in EFFECTS:
        if name not in names:
            pefl.chunks.append(_read_one(_chunk("pjef", name.encode() + b"\0")))
    rifx.chunks.insert(rifx.chunks.index(pefl) + 1, efdg)
    suite.project._effect_definitions_cache = None


def _leaves(group):
    for child in group.properties:
        if hasattr(child, "properties"):
            yield from _leaves(child)
        else:
            yield child


def set_layer_param(prop, layer):
    """Layer parameters keep the referenced layer's id in a tdpi chunk (py-aep's setter only writes cdat)."""
    prop._ensure_materialized()
    prop._tdpi.value = layer.id if layer is not None else 0


def effect(layer, match_name, **params):
    fx = layer["ADBE Effect Parade"].add_property(match_name)
    for leaf in _leaves(fx):
        # A cloned definition still names the donor's layers; point every layer parameter at None.
        if getattr(leaf, "_tdpi", None) is not None and not leaf.match_name.endswith("-0000"):
            leaf._tdpi.value = 0
        # py-aep resets popups to a 0 below their range; the declared default is the pard's last value.
        if leaf._property_control_type == PropertyControlType.ENUM and leaf.value == 0 and leaf.last_value:
            leaf.value = leaf.last_value
    for index, value in params.items():
        fx[f"{match_name}-{int(index[1:]):04d}"].value = value
    return fx


def param(fx, index):
    return fx[f"{fx.match_name}-{index:04d}"]


def keyed(prop, values, fps=24.0, first=0):
    for k, v in enumerate(values):
        prop.set_value_at_time((first + k) / fps, v)


# --- Test tones -------------------------------------------------------------------

def write_wav(name: str, seconds: float, sample, rate: int = 44100) -> Path:
    """16-bit WAVE; `sample(t)` returns one value (mono) or a tuple (one per channel)."""
    AUDIO.mkdir(parents=True, exist_ok=True)
    path = AUDIO / f"{name}.wav"
    frames = bytearray()
    channels = 1
    for i in range(int(seconds * rate)):
        values = sample(i / rate)
        values = values if isinstance(values, tuple) else (values,)
        channels = len(values)
        for v in values:
            frames += struct.pack("<h", int(round(max(-1.0, min(1.0, v)) * 32767)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return path


def sine(freq, amp):
    return lambda t: amp * math.sin(2 * math.pi * freq * t)


STEP_AMPS = [0.05, 0.1, 0.2, 0.4, 0.8]
_noise = random.Random(7)
_noise_samples = [_noise.uniform(-1, 1) for _ in range(44100 * 2)]

TONES = {
    "fxmisc_sine440": (2.0, sine(440, 0.5)),
    "fxmisc_sine440_steps": (len(STEP_AMPS) * 0.5, lambda t: STEP_AMPS[min(len(STEP_AMPS) - 1, int(t / 0.5))] * math.sin(2 * math.pi * 440 * t)),
    "fxmisc_two_tones": (2.0, lambda t: 0.4 * math.sin(2 * math.pi * 300 * t) + 0.2 * math.sin(2 * math.pi * 1200 * t)),
    "fxmisc_sweep": (2.0, lambda t: 0.5 * math.sin(2 * math.pi * (20 * t + 990 * t * t / 2.0))),
    "fxmisc_noise": (2.0, lambda t: 0.3 * _noise_samples[min(len(_noise_samples) - 1, int(t * 44100))]),
    "fxmisc_bass": (2.0, lambda t: 0.5 * math.sin(2 * math.pi * 55 * t) * (0.6 + 0.4 * math.sin(2 * math.pi * 1.5 * t)) + 0.3 * math.sin(2 * math.pi * 92 * t)),
    # Silence, then a 440 Hz tone from 1 s: the bar height around the onset shows where the window sits.
    "fxmisc_onset": (2.5, lambda t: 0.5 * math.sin(2 * math.pi * 440 * t) if t >= 1.0 else 0.0),
    "fxmisc_stereo": (2.0, lambda t: (0.5 * math.sin(2 * math.pi * 440 * t), 0.5 * math.sin(2 * math.pi * 300 * t))),
    "fxmisc_music": (3.0, lambda t: _music(t)),
    # 440 Hz on for [0.25, 0.5) of every half second: locates the analysis window at any time.
    "fxmisc_gate": (4.0, lambda t: 0.5 * math.sin(2 * math.pi * 440 * t) if t % 0.5 >= 0.25 else 0.0),
}


def _music(t):
    """A deterministic bass-heavy loop: pitch-dropping kicks every 0.5 s, a bass line, hats; stereo."""
    beat = t % 0.5
    kick = 0.6 * math.exp(-beat * 9.0) * math.sin(2 * math.pi * (45.0 * beat + 60.0 * (1 - math.exp(-beat * 30.0)) / 30.0))
    note = [55.0, 55.0, 73.4, 65.4, 49.0, 55.0][int(t / 0.5) % 6]
    env = min(1.0, (t % 0.5) * 40.0) * (0.5 + 0.5 * math.exp(-(t % 0.5) * 3.0))
    bass = 0.25 * env * (math.sin(2 * math.pi * note * t) + 0.35 * math.sin(4 * math.pi * note * t) + 0.15 * math.sin(6 * math.pi * note * t))
    hat = 0.08 * math.exp(-((t + 0.25) % 0.5) * 60.0) * _noise_samples[int(t * 44100) % len(_noise_samples)]
    wobble = 0.12 * math.sin(2 * math.pi * 110.0 * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 3.0 * t))
    return (kick + bass + hat + wobble, kick + bass - hat + 0.8 * wobble)


suite = Suite("fxmisc")
install_effect_definitions(suite)
case = suite.case
folder = suite.folder
footage = {}


def tone(name):
    if name not in footage:
        seconds, fn = TONES[name]
        footage[name] = suite.project.import_file(ImportOptions(write_wav(name, seconds, fn)))
    return footage[name]


# --- Source images ----------------------------------------------------------------

def gradient(c0, c1):
    return Gradient(
        [GradientColorStop(0.0, 0.5, tuple(c0)), GradientColorStop(1.0, 0.5, tuple(c1))],
        [GradientAlphaStop(0.0, 0.5, 1.0), GradientAlphaStop(1.0, 0.5, 1.0)],
    )


def coordinate_source(name, w, h):
    """R grows with x and G with y over the whole w x h frame (B = 0, opaque)."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    for axis, color, start, end in (
        ("x", [1.0, 0.0, 0.0], [-w / 2, 0.0], [w / 2, 0.0]),
        ("y", [0.0, 1.0, 0.0], [0.0, -h / 2], [0.0, h / 2]),
    ):
        layer = comp.add_shape()
        layer.name = f"ramp_{axis}"
        g = shape_group(layer)
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(w), float(h)]})
        grad = add(g, "ADBE Vector Graphic - G-Fill", **{"ADBE Vector Grad Start Pt": start, "ADBE Vector Grad End Pt": end})
        grad["ADBE Vector Grad Colors"].value = gradient([0.0, 0.0, 0.0], color)
        if axis == "y":
            layer.blending_mode = BlendingMode.ADD
    return comp


def bars_source(name, w, h):
    """White bars standing on a horizontal baseline, on transparency (a spectrum-like image)."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    # One group per bar: AE ignores static rectangle positions and Repeater offsets written by py-aep.
    for k in range(w // 10):
        height = 6.0 + (k * 7) % 30
        g = shape_group(layer)
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [4.0, height]})
        gtr(g, "ADBE Vector Position", [-w / 2 + 8.0 + 10.0 * k, 10.0 - height / 2])
        fill(g, [1.0, 1.0, 1.0])
    base = shape_group(layer)
    add(base, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(w - 10), 3.0]})
    gtr(base, "ADBE Vector Position", [0.0, 11.5])
    fill(base, [1.0, 0.5, 0.0])
    return comp


GRAD = coordinate_source("fxmisc_src_grad", 160, 120)
GRAD_TALL = coordinate_source("fxmisc_src_grad_tall", 90, 110)
GRAD_WIDE = coordinate_source("fxmisc_src_grad_wide", 150, 70)
BARS = bars_source("fxmisc_src_bars", 160, 120)

# --- Polar Coordinates --------------------------------------------------------------

INTERP = [1.0, 0.75, 0.5, 0.25, 0.0]

for conversion, label in ((1, "r2p"), (2, "p2r")):
    for src, tag in ((GRAD, "grad"), (GRAD_TALL, "tall"), (GRAD_WIDE, "wide"), (BARS, "bars")):

        @case(f"fxmisc_polar_{tag}_{label}", frames=tuple(range(len(INTERP))))
        def _(comp, src=src, conversion=conversion):
            comp.add_solid([0.2, 0.2, 0.2], "bg")
            layer = comp.add(src)
            fx = effect(layer, "ADBE Polar Coordinates", p2=conversion)
            keyed(param(fx, 1), INTERP)


# --- Audio Spectrum ----------------------------------------------------------------


SPECTRUM_DEFAULTS = {"p14": [1.0, 0.3, 0.7, 1.0], "p15": [0.2, 0.6, 1.0, 1.0], "p20": 1, "p21": 1}


def spectrum_comp(comp, audio, w, h, audio_start=0.0, sound=None, masks=(), solid_color=(0.0, 0.0, 0.0), **params):
    """Adds the audio layer (unless given) and a solid with Audio Spectrum; returns the solid and the effect."""
    if sound is None:
        sound = comp.add(tone(audio))
        sound.start_time = audio_start
    solid = comp.add_solid(list(solid_color), "spectrum", w, h)
    for shape in masks:
        add_mask(solid, shape, MaskMode.NONE)
    fx = effect(solid, "ADBE AudSpect")
    set_layer_param(param(fx, 1), sound)
    for index, value in {**SPECTRUM_DEFAULTS, **params}.items():
        param(fx, int(index[1:])).value = value
    return solid, fx


KAPPA = 0.5522847498


def circle(cx, cy, r):
    """A closed four-vertex circle starting at the top and running top, left, bottom, right (as AE's ellipse mask tool draws)."""
    k = r * KAPPA
    return Shape(
        [[cx, cy - r], [cx - r, cy], [cx, cy + r], [cx + r, cy]],
        [[k, 0.0], [0.0, -k], [-k, 0.0], [0.0, k]],
        [[-k, 0.0], [0.0, k], [k, 0.0], [0.0, -k]],
        closed=True,
    )


def open_curve(points):
    return Shape([list(p) for p in points], [[0.0, 0.0]] * len(points), [[0.0, 0.0]] * len(points), closed=False)


@case("fxmisc_as_default", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, p2=[20.0, 140.0], p3=[220.0, 140.0])


@case("fxmisc_as_lobe", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, p2=[20.0, 150.0], p3=[220.0, 150.0], p6=400.0, p7=480.0, p8=81, p9=100.0, p12=1.0, p13=0.0)


@case("fxmisc_as_lobe_long", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, p2=[20.0, 150.0], p3=[220.0, 150.0], p6=400.0, p7=480.0, p8=81, p9=100.0, p10=360.0, p12=1.0, p13=0.0)


# Frames start at 0 because render-refs numbers incremented outputs from 0; the audio starts
# 0.25 s early so frame 12k analyses the middle of amplitude step k.
@case("fxmisc_as_steps", frames=tuple(12 * k for k in range(len(STEP_AMPS))), width=240, height=160, duration=2.5)
def _(comp):
    spectrum_comp(
        comp, "fxmisc_sine440_steps", 240, 160, audio_start=-0.25,
        p2=[20.0, 150.0], p3=[220.0, 150.0], p6=420.0, p7=460.0, p8=41, p9=100.0, p12=1.0, p13=0.0,
    )


@case("fxmisc_as_two_tones", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_two_tones", 240, 160, p2=[20.0, 150.0], p3=[220.0, 150.0], p8=100, p9=200.0, p12=1.0, p13=0.0)


@case("fxmisc_as_style", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(
        comp, "fxmisc_noise", 240, 160,
        p2=[20.0, 120.0], p3=[220.0, 60.0], p8=24, p9=600.0, p12=6.0, p13=0.5,
        p14=[1.0, 0.1, 0.1, 1.0], p15=[0.1, 0.3, 1.0, 1.0], p21=3,
    )


@case("fxmisc_as_analog", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_noise", 240, 160, p2=[20.0, 80.0], p3=[220.0, 80.0], p8=32, p9=400.0, p12=2.0, p20=2, p21=3)


@case("fxmisc_as_dots", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_noise", 240, 160, p2=[20.0, 80.0], p3=[220.0, 80.0], p8=32, p9=400.0, p12=4.0, p20=3, p21=1)


@case("fxmisc_as_bass", frames=(12, 13, 14), width=240, height=160)
def _(comp):
    spectrum_comp(
        comp, "fxmisc_bass", 240, 160,
        p2=[0.0, 80.0], p3=[120.0, 80.0], p6=25.0, p7=125.0, p8=500, p9=600.0, p10=195.0, p11=88.0, p12=4.0,
        p14=[1.0, 1.0, 1.0, 1.0], p15=[1.0, 1.0, 1.0, 1.0], p21=2,
    )


# Window placement: bars of a 440 Hz tone that starts at 1 s, frame by frame around the onset.
LOBE = dict(p2=[20.0, 150.0], p3=[220.0, 150.0], p6=400.0, p7=480.0, p8=81, p9=100.0, p12=1.0, p13=0.0)
ONSET_FRAMES = tuple(range(18, 37))


def onset_case(name, frames=ONSET_FRAMES, configure=None, **params):
    @case(name, frames=frames, width=240, height=160, duration=2.5)
    def _(comp):
        sound = comp.add(tone("fxmisc_onset"))
        if configure:
            configure(sound)
        spectrum_comp(comp, None, 240, 160, sound=sound, **{**LOBE, **params})


onset_case("fxmisc_as_onset_90", p10=90.0)
onset_case("fxmisc_as_onset_200", p10=200.0)
onset_case("fxmisc_as_onset_off", p10=90.0, p11=100.0)
onset_case("fxmisc_as_onset_neg", p10=90.0, p11=-150.0)
onset_case("fxmisc_as_onset_start", configure=lambda s: setattr(s, "start_time", 0.25), p10=90.0)
onset_case("fxmisc_as_onset_in", configure=lambda s: setattr(s, "in_point", 1.1), p10=90.0)


@case("fxmisc_as_onset_stretch", frames=tuple(range(42, 55)), width=240, height=160, duration=3.0)
def _(comp):
    sound = comp.add(tone("fxmisc_onset"))
    sound.stretch = 200.0
    spectrum_comp(comp, None, 240, 160, sound=sound, **{**LOBE, "p10": 90.0})


# Channels: left 440 Hz, right 300 Hz, both at 0.5.
@case("fxmisc_as_stereo", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_stereo", 240, 160, p2=[20.0, 150.0], p3=[220.0, 150.0], p8=100, p9=200.0, p12=1.0, p13=0.0)


# The audio layer is a precomp: a 440 Hz layer starting at 0.25 s and a two-tone layer with its audio switched off.
AUDIO_PRECOMP = folder.add_comp("fxmisc_src_audio", 240, 160, 1.0, 2.5, 24.0)
AUDIO_PRECOMP.add(tone("fxmisc_sine440")).start_time = 0.25
AUDIO_PRECOMP.add(tone("fxmisc_two_tones")).audio_enabled = False


@case("fxmisc_as_precomp", frames=(6, 12), width=240, height=160)
def _(comp):
    sound = comp.add(AUDIO_PRECOMP)
    sound.start_time = 0.1
    spectrum_comp(comp, None, 240, 160, sound=sound, p2=[20.0, 150.0], p3=[220.0, 150.0], p8=100, p9=200.0, p12=1.0, p13=0.0)


# Stroke profiles: nine separated bars (25 px apart, at fractional positions) per thickness / softness.
PROFILE = dict(p2=[20.3, 130.0], p3=[220.3, 130.0], p6=400.0, p7=480.0, p8=9, p9=100.0, p14=[1.0, 0.1, 0.1, 1.0], p15=[0.1, 0.3, 1.0, 1.0])
for thickness, softness, tag in ((8.0, 0.0, "t8s0"), (8.0, 1.0, "t8s1"), (8.0, 0.5, "t8s05"), (2.0, 1.0, "t2s1"), (13.0, 0.25, "t13s025")):

    @case(f"fxmisc_as_prof_{tag}", frames=(12,), width=240, height=160)
    def _(comp, thickness=thickness, softness=softness):
        spectrum_comp(comp, "fxmisc_sine440", 240, 160, **{**PROFILE, "p12": thickness, "p13": softness})


DEFAULT_LIKE = dict(p2=[20.0, 140.0], p3=[220.0, 140.0])


@case("fxmisc_as_blend", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 100.0], p3=[220.0, 100.0], p8=64, p9=400.0, p12=6.0, p13=0.5, p16=1, p21=3)


@case("fxmisc_as_noblend", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 100.0], p3=[220.0, 100.0], p8=64, p9=400.0, p12=6.0, p13=0.5, p16=0, p21=3)


@case("fxmisc_as_hue", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, **DEFAULT_LIKE, p17=90.0)


@case("fxmisc_as_hue_plain", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, **DEFAULT_LIKE, p17=90.0, p18=0, p19=0)


@case("fxmisc_as_composite", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, solid_color=(0.3, 0.5, 0.2), **DEFAULT_LIKE, p23=1)


@case("fxmisc_as_avg", frames=(12, 13, 14), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 140.0], p3=[220.0, 140.0], p6=20.0, p7=400.0, p8=64, p9=600.0, p22=1)


@case("fxmisc_as_avg_sine", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, **DEFAULT_LIKE, p22=1)


@case("fxmisc_as_avg_lobe", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, **LOBE, p22=1)


@case("fxmisc_as_avg_gate", frames=tuple(range(4, 22, 2)), width=240, height=160, duration=1.0)
def _(comp):
    spectrum_comp(comp, "fxmisc_gate", 240, 160, **LOBE, p22=1)


# Averaged spectra draw near zero; the largest Maximum Height shows their shape and scale.
@case("fxmisc_as_avg_big", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, **{**LOBE, "p9": 32000.0}, p22=1)


@case("fxmisc_as_avg_big_gate", frames=(4, 6, 8, 10), width=240, height=160, duration=1.0)
def _(comp):
    spectrum_comp(comp, "fxmisc_gate", 240, 160, **{**LOBE, "p9": 32000.0}, p22=1)


@case("fxmisc_as_avg_big_music", frames=(12, 13, 14), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 150.0], p3=[220.0, 150.0], p6=20.0, p7=400.0, p8=64, p9=32000.0, p22=1)


HUE_MUSIC = dict(p2=[20.0, 140.0], p3=[220.0, 140.0], p6=20.0, p7=400.0, p8=64, p9=300.0, p12=4.0, p17=120.0)
for dynamic, symmetry, tag in ((1, 0, "dyn"), (0, 1, "sym"), (1, 1, "both")):

    @case(f"fxmisc_as_hue_{tag}", frames=(12,), width=240, height=160)
    def _(comp, dynamic=dynamic, symmetry=symmetry):
        spectrum_comp(comp, "fxmisc_music", 240, 160, **HUE_MUSIC, p18=dynamic, p19=symmetry)


@case("fxmisc_as_blend_lines", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 100.0], p3=[220.0, 100.0], p8=64, p9=400.0, p12=6.0, p13=0.5, p16=1, p20=2, p21=1)


@case("fxmisc_as_noaudio", frames=(12,), width=240, height=160)
def _(comp):
    # The Audio Layer is a precomp without sound (a "put the song here" placeholder).
    silent = folder.add_comp("fxmisc_src_silent", 240, 160, 1.0, 2.0, 24.0)
    silent.add_solid([0.5, 0.5, 0.5], "placeholder", 240, 160)
    sound = comp.add(silent)
    sound.enabled = False
    spectrum_comp(comp, None, 240, 160, sound=sound, **DEFAULT_LIKE)


@case("fxmisc_as_dots_ab", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_noise", 240, 160, p2=[20.0, 80.0], p3=[220.0, 80.0], p8=32, p9=400.0, p12=4.0, p20=3, p21=3)


# The gated tone, every frame for 3.5 s: where the window sits as time goes on.
for duration, fps, step, tag in ((90.0, 24.0, 1, "90"), (170.0, 24.0, 1, "170"), (170.0, 60.0, 2, "170_60")):

    @case(f"fxmisc_as_gate_{tag}", frames=tuple(range(0, int(3.5 * fps), step)), width=240, height=160, duration=3.5, fps=fps)
    def _(comp, duration=duration):
        spectrum_comp(comp, "fxmisc_gate", 240, 160, **{**LOBE, "p10": duration})


@case("fxmisc_as_music", frames=(12, 13, 14), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[20.0, 140.0], p3=[220.0, 140.0], p6=20.0, p7=400.0, p8=64, p9=600.0, p22=0)


# Paths: masks of the effect's layer (mode None) and the polar path.
RING = dict(p6=20.0, p7=400.0, p8=64, p9=300.0, p12=3.0, p13=0.5)


@case("fxmisc_as_mask_a", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, masks=[circle(120.0, 80.0, 40.0)], p4=1, p21=1, **RING)


@case("fxmisc_as_mask_b", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, masks=[circle(120.0, 80.0, 40.0)], p4=1, p21=2, **RING)


@case("fxmisc_as_mask_second", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(
        comp, "fxmisc_music", 240, 160,
        masks=[open_curve([(20.0, 30.0), (220.0, 30.0)]), open_curve([(20.0, 140.0), (100.0, 70.0), (220.0, 110.0)])],
        p4=2, p21=3, **RING,
    )


@case("fxmisc_as_polar", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[120.0, 80.0], p3=[200.0, 60.0], p5=1, p21=1, **RING)


@case("fxmisc_as_polar_ab", frames=(12,), width=240, height=160)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[110.0, 85.0], p3=[150.0, 85.0], p5=1, p21=3, **RING)


@case("fxmisc_as_polar_top", frames=(12,), width=240, height=160)
def _(comp):
    # 440 Hz in the last of 50 bands: where the band range ends on the circle.
    spectrum_comp(comp, "fxmisc_sine440", 240, 160, p2=[120.0, 80.0], p3=[200.0, 80.0], p5=1, p6=200.0, p7=445.0, p8=50, p9=150.0, p12=3.0)


for display, tag in ((2, "lines"), (3, "dots")):

    @case(f"fxmisc_as_polar_{tag}", frames=(12,), width=240, height=160)
    def _(comp, display=display):
        spectrum_comp(comp, "fxmisc_music", 240, 160, p2=[120.0, 80.0], p3=[200.0, 80.0], p5=1, p20=display, p21=1, **RING)


# The user's settings (Trap Nation visualizers): Side B, Thickness 4, Softness 0.5, 2000 bands of bass.
USER = dict(p6=20.0, p7=250.0, p8=2000, p9=600.0, p10=170.0, p12=4.0, p13=0.5, p14=[1.0, 1.0, 1.0, 1.0], p15=[1.0, 1.0, 1.0, 1.0], p21=2)
USER_FRAMES = (12, 30, 48)


@case("fxmisc_as_user_line", frames=USER_FRAMES, width=480, height=270, duration=3.0)
def _(comp):
    spectrum_comp(comp, "fxmisc_music", 480, 270, p2=[0.0, 100.0], p3=[480.0, 100.0], **USER)


@case("fxmisc_as_user_ring", frames=USER_FRAMES, width=480, height=270, duration=3.0)
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg", 480, 270)
    sound = comp.add(tone("fxmisc_music"))
    for duration, color in ((170.0, [1.0, 1.0, 1.0, 1.0]), (130.0, [1.0, 0.706, 0.0, 1.0]), (90.0, [1.0, 0.5, 0.0, 1.0])):
        spectrum_comp(comp, None, 480, 270, sound=sound, masks=[circle(240.0, 135.0, 68.0)], **{**USER, "p4": 1, "p10": duration, "p14": color, "p15": color})


@case("fxmisc_as_user_polarfx", frames=USER_FRAMES, width=480, height=270, duration=3.0)
def _(comp):
    solid, _ = spectrum_comp(
        comp, "fxmisc_music", 480, 270,
        **{**USER, "p2": [0.0, 135.0], "p3": [240.0, 135.0], "p6": 25.0, "p7": 125.0, "p10": 195.0, "p11": 88.0},
    )
    effect(solid, "ADBE Polar Coordinates", p1=1.0, p2=1)


# --- Deep Glow 2 --------------------------------------------------------------------


def glow_source(name):
    comp = folder.add_comp(name, 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [24.0, 24.0]})
    fill(g, [1.0, 0.6, 0.2])
    bar = shape_group(layer)
    gtr(bar, "ADBE Vector Position", [40.0, 25.0])
    add(bar, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [30.0, 4.0]})
    fill(bar, [0.3, 0.6, 1.0])
    return comp


GLOW_SRC = glow_source("fxmisc_src_glow")


@case("fxmisc_dg_default", frames=(0,))
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    layer = comp.add(GLOW_SRC)
    effect(layer, "PEDG2")


@case("fxmisc_dg_radius", frames=(0, 1, 2, 3, 4))
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    layer = comp.add(GLOW_SRC)
    fx = effect(layer, "PEDG2")
    keyed(fx["PEDG2-0017"], [10.0, 25.0, 50.0, 100.0, 300.0])


@case("fxmisc_dg_exposure", frames=(0, 1, 2))
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    layer = comp.add(GLOW_SRC)
    fx = effect(layer, "PEDG2")
    fx["PEDG2-0017"].value = 50.0
    keyed(fx["PEDG2-0018"], [0.5, 2.0, 4.0])


@case("fxmisc_dg_alpha", frames=(0,))
def _(comp):
    layer = comp.add(GLOW_SRC)
    fx = effect(layer, "PEDG2")
    fx["PEDG2-0017"].value = 50.0


suite.save()
manifest = REFS / suite.manifest_file
data = json.loads(manifest.read_text(encoding="utf-8"))
data["media"] = sorted(f"fixtures/fxmisc_audio/{name}.wav" for name in footage)
data["known"] = KNOWN
manifest.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
