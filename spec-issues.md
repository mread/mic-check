# Specification Issues & Browser Limitations

This document tracks issues with the WebRTC/Media Capture specifications and browser implementations that affect mic-check's ability to diagnose audio problems and provide useful information to users.

**Last updated:** January 2026

---

## Overview

mic-check relies on the [Media Capture and Streams API](https://w3c.github.io/mediacapture-main/) (also known as getUserMedia) to enumerate and access audio devices. Several aspects of this API are under active discussion in the W3C WebRTC Working Group, with inconsistent browser implementations.

This document exists so we can point contributors to it and say: *"We're aware of this limitation, but we're awaiting clarity from the spec."*

---

## Key Issues

### 1. Identifying the Default Audio Device

**Problem:** There's no reliable, cross-browser way to determine which device is the user's system default.

**Impact on mic-check:** We cannot tell users "you're using the system default microphone" vs "you've selected a specific device."

**Spec Status:**

| Issue | Status | Link |
|-------|--------|------|
| Clarify what "system default" means | 🟡 Open | [mediacapture-main #1058](https://github.com/w3c/mediacapture-main/issues/1058) |
| Restore default audio output position first | 🟡 Open | [mediacapture-output #154](https://github.com/w3c/mediacapture-output/issues/154) |
| Add explicit default audio output entry | ✅ Merged Oct 2025 | [mediacapture-main #1057](https://github.com/w3c/mediacapture-main/pull/1057) |

**Browser Behavior (as of Jan 2026):**

| Behavior | Chrome | Firefox | Safari |
|----------|--------|---------|--------|
| Virtual `deviceId: "default"` for mic | ✅ | ❌ | ❌ |
| Virtual `deviceId: "default"` for speaker | Being implemented | ? | ✅ |
| OS default device listed first | ❌ | ✅ | ✅ |
| `devicechange` fires when OS default changes | ❌ | ✅ | ✅ |

**Working Group Resolution (October 2025):**
> "Confirm the spec is as expected for mics (and Chrome needs a fix), camera needs more discussion on interop in a dedicated spec issue"
> — [W3C WebRTC WG Meeting Minutes, Oct 21, 2025](https://www.w3.org/2025/10/21-webrtc-minutes#061e)

**Workaround:** Currently, Firefox and Safari list the OS default device first in `enumerateDevices()`. Chrome does not follow this behavior. We cannot rely on device ordering for Chrome users.

---

### 2. Device Labels Hidden Until Permission Granted

**Problem:** The spec intentionally hides device labels (returning empty strings) until the user grants microphone permission. This is a privacy protection against fingerprinting.

**Impact on mic-check:** Before the user clicks "Test Microphone", we cannot show them a meaningful device picker with names like "AirPods" or "USB Microphone" — only generic entries.

**Spec Reference:** [Media Capture and Streams - Section 9.3: Device Information Exposure](https://w3c.github.io/mediacapture-main/#device-information-exposure)

**This is intentional and will not change.** We should design our UX accordingly.

---

### 3. Chrome's UA Default vs OS Default

**Problem:** When users select a device in Chrome's permission prompt, Chrome treats that as the new "UA default" for the page. This differs from the OS-level system default.

**Impact on mic-check:** 
- The device Chrome gives us via `getUserMedia()` may not match what `enumerateDevices()` lists first
- Changing the default mic in System Settings doesn't trigger `devicechange` in Chrome
- Users may be confused when the "default" in Chrome differs from their OS settings

**Spec Reference:** [mediacapture-main #1058](https://github.com/w3c/mediacapture-main/issues/1058) — jan-ivar (Mozilla) raised this, showing Chrome/Firefox/Safari behave differently.

**No workaround available.** This is a Chrome implementation issue the working group has acknowledged.

---

### 4. Audio Output Device Selection

**Problem:** The ability to enumerate and select audio *output* devices (speakers) is less mature than input devices (microphones).

**Relevant Specs:**
- [Audio Output Devices API](https://w3c.github.io/mediacapture-output/) (mediacapture-output)
- [`setSinkId()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId) for routing audio to specific speakers

**Browser Support:**
- Chrome: Full support
- Safari: Full support  
- Firefox: Behind a preference flag (`media.setsinkid.enabled` in `about:config`)

**Not currently relevant to mic-check** (we focus on microphone input), but noted for future reference.

---

## Where Discussions Happen

If you want to follow or participate in these discussions:

### Standards Bodies

| Venue | Purpose | Link |
|-------|---------|------|
| W3C WebRTC Working Group | API specification | [Charter](https://www.w3.org/groups/wg/webrtc/) |
| public-webrtc mailing list | Technical discussions | [Archives](https://lists.w3.org/Archives/Public/public-webrtc/) |
| GitHub: mediacapture-main | getUserMedia / enumerateDevices spec | [Issues](https://github.com/w3c/mediacapture-main/issues) |
| GitHub: mediacapture-output | Audio output / setSinkId spec | [Issues](https://github.com/w3c/mediacapture-output/issues) |

### Browser Bug Trackers

| Browser | Component | Link |
|---------|-----------|------|
| Chrome | Blink>WebRTC | [bugs.chromium.org](https://bugs.chromium.org/p/chromium/issues/list?q=component:Blink%3EWebRTC) |
| Firefox | Core::WebRTC | [bugzilla.mozilla.org](https://bugzilla.mozilla.org/buglist.cgi?component=WebRTC&product=Core) |
| Safari | WebKit | [bugs.webkit.org](https://bugs.webkit.org/) |

---

## Key People in These Discussions

For context, these are the primary contributors to the relevant spec issues:

- **jan-ivar** (Mozilla) — Spec editor, raised the "system default" clarification issue
- **youennf** (Apple/WebKit) — Spec editor, authored the default audio output PR
- **karlt** (Mozilla) — Raised the issue about restoring default device position
- **guidou** (Google/Chrome) — WebRTC team

---

## What We're Waiting For

1. **Chrome to fix default device ordering** — The WG agreed the spec is correct; Chrome's implementation needs updating
2. **Resolution on #154** — Whether to mandate the default physical device appear in a specific position
3. **Broader interop testing** — The WG is working toward consistent behavior across browsers

---

## Changelog

- **2026-01-14:** Initial document created based on research into W3C discussions and GitHub issues
