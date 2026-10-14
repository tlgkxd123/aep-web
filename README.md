# Audio Visualizer

Turn your music into motion. A music visualizer that runs in your browser and on Android.

<!-- ![Demo](docs/demo.gif) -->

## Features

- Real-time visuals driven by your music: bars, waveform, circular spectrum
- Layer and timeline editor for building your own looks
- Audio-reactive properties linked to bass, mids, and treble
- Export to video, GIF, or image sequence
- Works in any modern browser and as an Android `.apk`, built with [Capacitor](https://capacitorjs.com)

## Getting Started

```bash
git clone https://github.com/tlgkxd123/aep-web.git
cd aep-web
npm install
npm run dev
```

Open the local address shown in your terminal, load a song, and press play.

### Android

```bash
npm run build
npx cap sync android
npx cap open android
```

Then build the `.apk` from Android Studio (**Build → Build APK(s)**), copy it to your device, and install it. You may need to allow installs from unknown sources.

> No prebuilt releases yet.

## Contributing

Pull requests are welcome. Fork the repo, create a branch, and open a PR.

## License

MIT
