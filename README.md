# 🎤 Mic Check

**Browser Microphone Diagnostic Tool**

A free, privacy-first tool to test your microphone, understand browser permissions, and diagnose why your mic might not be working.

🔗 **Live Demo:** [https://mread.github.io/mic-check/](https://mread.github.io/mic-check/)

## Features

- **🔧 Troubleshooter** — Step-by-step diagnosis when your mic isn't working
- **🔐 Privacy Check** — See what microphone access websites have and how to control it
- **🌐 App Debugging** — Diagnose why your mic works on some sites but not others
- **⚡ Quick Test** — Fast microphone test with audio level visualization
- **📊 Level Check** — LUFS measurement per [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770) (same standard used by Spotify, YouTube, and broadcast tools)

## Privacy

- ✅ **No audio recording** — Audio is processed locally, never saved
- ✅ **No data collection** — No analytics, no cookies, no tracking
- ✅ **Runs in your browser** — Nothing is sent to any server
- ✅ **Open source** — Inspect the code yourself

## Browser Compatibility

Works on all modern browsers:
- Chrome, Edge, Brave, Vivaldi
- Firefox, LibreWolf, Waterfox, Zen
- Safari

### Firefox Privacy Settings

Privacy-focused Firefox derivatives (Zen, LibreWolf, etc.) may have settings that block audio analysis. The tool detects this and provides guidance on settings like:
- `media.getusermedia.audio.capture.enabled`
- `privacy.resistFingerprinting`

## Usage

Just open [`index.html`](index.html) in your browser, or visit the [live demo](https://mread.github.io/mic-check/).

## Development

No build process or dependencies required. To run locally:

```bash
python3 dev-server.py
# Open http://localhost:8765
```

The dev server sends no-cache headers to ensure you always see your latest changes.

## License

[MIT License](LICENSE) © 2026 Matt Read
