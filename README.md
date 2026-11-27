# Audio Visualizer

Turn your music into motion. A music visualizer that runs in your browser, on Android and on Windows. It opens,
edits and saves real After Effects `.aep` projects and renders them on the GPU.

<!-- ![Demo](docs/demo.gif) -->

## Features

- Real-time visuals driven by your music: bars, waveform, circular spectrum
- Layer and timeline editor for building your own looks
- Audio-reactive properties linked to bass, mids, and treble
- Opens and saves After Effects `.aep` projects, or a `.zip` with their footage
- Imports and exports Avee Player templates (`.viz`)
- Export to video, GIF, or image sequence
- Works in any modern browser, as an Android `.apk` built with [Capacitor](https://capacitorjs.com), and as a
  Windows desktop app built with Electron

## Getting Started

```bash
git clone https://github.com/tlgkxd123/aep-web.git
cd aep-web
npm install
npm run dev
```

Open the local address shown in your terminal, load a song, and press play.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite dev server (with the local footage and Particle Match trainer plugins in `server/`) |
| `npm run build` | Type-checks and builds the web app into `dist/` |
| `npm test` | Runs the vitest suite in `tests/` |
| `npm run check` | Type-check, tests and build, the same checks CI runs |
| `npm run desktop` | Builds and opens the Electron desktop app |
| `npm run dist:desktop` | Builds the portable Windows `.exe` into `dist-desktop/` |

Some tests read the [py-aep](https://github.com/forticheprod/py-aep) sample corpus. Point the `PY_AEP` environment
variable at a checkout of it (CI does this in `.github/actions/setup`).

### Android

```bash
npm run build
npx cap sync android
npx cap open android
```

Then build the `.apk` from Android Studio (**Build → Build APK(s)**), copy it to your device, and install it. You may
need to allow installs from unknown sources. Publishing a GitHub release also builds a signed APK
(`.github/workflows/release.yml`).

### Native Vulkan engine

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build --config Release
ctest --test-dir native/build -C Release
```

The Android build compiles it through Gradle on its own.

## Project layout

```
aep-web/
├── src/                 The web app (React + TypeScript + Vite)
│   ├── aep/             .aep parser, writer and project model
│   ├── edit/            The editor: layers, effects, masks, shapes, templates
│   ├── render/          WebGL2 compositor; effects/ holds one module per effect family
│   ├── playback/        Viewer, playhead and frame caches
│   ├── expressions/     After Effects expression engine
│   ├── media/           Footage decoding (video, audio, PSD, TIFF, PDF, ZIP)
│   ├── export/          Render queue and video/image export
│   ├── quickstart/      Quick Start templates built around your song
│   ├── viz/             Avee Player template import and export
│   ├── extra/pmatch/    Particle Match (browser side)
│   ├── native/          Bridge to the native Vulkan engine
│   └── ui/              The workspace: panels, menus, dialogs, styles
├── public/              Static files served as-is (icon, web manifest)
├── server/              Vite dev-server plugins
├── desktop/             Electron main process
├── android/             Capacitor Android project
├── native/              C++17 Vulkan engine (aevk) used by the Android app
├── ml/pmatch/           Particle Match model training (PyTorch, uv project)
├── tests/               vitest suite; tests/data holds its fixtures
├── scripts/             Verification and tooling, run with node scripts/<folder>/<name>.ts
│   ├── reports/         Gate reports: pixel, corpus, geometry, native, export...
│   ├── checks/
│   │   ├── app/         End-to-end checks of the running app (UI, mobile, desktop, playback)
│   │   └── effects/     Effect checks; one folder per area (keying, distort2, color2...)
│   ├── ae/              After Effects tooling: aerender, reference renders, donors
│   ├── fixtures/        Builders for the .aep test fixtures
│   ├── generate/        Generators of committed data and code (effect library, shaders)
│   ├── inspect/         Readers of projects and the sample corpus
│   ├── research/        One-off measurements and fits (Deep Glow, FX extra, Particular...)
│   ├── pmatch/          Particle Match training and reports
│   ├── project-ops/     Project operations checks and templates
│   ├── export/          Export reports
│   ├── perf/            Benchmarks and profiling
│   ├── device/          GPU, codec and Android probes
│   ├── tools/           Sample writers and small conversions
│   └── lib/             Shared helpers for the scripts
├── refs/                Reference data the tests and scripts compare against
│   ├── fixtures/        Authored .aep fixtures and their manifests
│   ├── frames/          After Effects reference renders
│   └── media/           Sample footage
├── gates/               Verification ledgers, one per feature area (GATES.md is the core one)
├── docs/                Format notes
├── .github/             CI, release and agent workflows
└── AGENTS.md            Detailed architecture notes and working rules
```

`AGENTS.md` goes into each part in depth.

## Contributing

Pull requests are welcome. Fork the repo, create a branch, and open a PR. `npm run check` should pass before you
open it.

## License

MIT
