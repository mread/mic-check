# Browser Microphone Permission Lifecycle

This document describes how different browsers handle microphone permissions. Understanding these differences helps diagnose "it works in Firefox but not Chrome" issues.

## Permission States

All browsers support three fundamental permission states:

| State | Meaning | getUserMedia behavior |
|-------|---------|----------------------|
| **granted** | User previously allowed | Succeeds silently |
| **denied** | User previously blocked | Throws `NotAllowedError` |
| **prompt** | Not yet decided | Shows permission dialog |

## The Permission Hierarchy

Permissions exist at multiple levels. **All levels must allow access** for the microphone to work:

```
┌──────────────────────────────────────────────────────┐
│ 1. SECURE CONTEXT                                    │
│    HTTPS or localhost required                       │
│    If HTTP: mediaDevices is undefined                │
├──────────────────────────────────────────────────────┤
│ 2. OPERATING SYSTEM                                  │
│    Windows: Settings > Privacy > Microphone          │
│    macOS: System Preferences > Security > Microphone │
│    If blocked: browser sees zero devices             │
├──────────────────────────────────────────────────────┤
│ 3. BROWSER SETTINGS                                  │
│    Global microphone permission                      │
│    If blocked: all sites blocked                     │
├──────────────────────────────────────────────────────┤
│ 4. SITE PERMISSION                                   │
│    Per-origin (https://example.com:443)              │
│    This is what the padlock icon controls            │
└──────────────────────────────────────────────────────┘
```

---

## Chrome / Edge / Brave (Chromium-based)

### Permission Storage
- **Persistent** — Permissions survive browser restart
- **Per-origin** — Each site (scheme + host + port) tracked separately
- **Synced** — Chrome syncs permissions across devices if signed in

### Permissions API
```javascript
const result = await navigator.permissions.query({ name: 'microphone' });
// result.state: 'granted' | 'denied' | 'prompt'
```
- ✅ Reliable — state matches actual behavior
- ✅ Supports `onchange` event for state transitions

### Device Enumeration
- Before permission: Returns devices with empty `label` fields
- After permission: Returns full device labels
- Special devices: `deviceId: "default"` and `deviceId: "communications"`

### Chrome-Specific: Default vs Communications Device
Chrome exposes two virtual devices:
- **Default** — OS default audio input device
- **Communications** — OS default communications device (Windows only)

These may point to the same or different hardware. See [SPEC_ISSUES.md](SPEC_ISSUES.md) for details.

### Private/Incognito Mode
- Permissions are **session-only** — not persisted
- Each incognito window is isolated
- User will be prompted again on next incognito session

---

## Firefox

### Permission Storage
- **Persistent** — Permissions survive browser restart
- **Per-origin** — Each site tracked separately
- **Local only** — Not synced across devices

### Permissions API
```javascript
const result = await navigator.permissions.query({ name: 'microphone' });
```
- ⚠️ **May return 'prompt' even when permission was previously granted**
- This happens because Firefox's Permissions API can lag behind actual state
- **Workaround:** Trust getUserMedia success over Permissions API state

### Device Enumeration  
- Before permission: Returns devices with empty `label` fields
- After permission: Returns full device labels
- No "default" virtual device — first device in list is typically OS default

### Firefox-Specific: Container Tabs
If user has Firefox Multi-Account Containers:
- Permissions are **per-container**, not global
- "Personal" container has different permissions than "Work" container
- Same site can be granted in one container, denied in another

### Private Browsing Mode
- Permissions are **session-only**
- Separate from container permissions
- User will be prompted again on next private session

---

## Safari

### Permission Storage
- **Session-only by default** — User is asked every session
- **Per-origin** — Each site tracked separately
- Can enable "Always Allow" per-site in preferences

### Permissions API
- ⚠️ **Partial support** — may not work as expected
- Safer to try `getUserMedia` directly

### Device Enumeration
- Before permission: Returns devices but with **generic labels** (e.g., "Internal Microphone")
- After permission: Labels may still be generic (privacy feature)
- No device IDs exposed in some versions

### Safari-Specific Behaviors
- First-party isolation affects cross-site permissions
- WebKit Tracking Prevention may affect behavior
- iOS Safari has additional restrictions (requires user gesture)

### Private Browsing
- Permissions are **session-only**
- Even stricter than normal mode

---

## Testing Scenarios

When testing permission handling, verify these scenarios:

### Pre-Permission (state: prompt)
- [ ] Permissions API returns 'prompt'
- [ ] Device enumeration returns devices without labels
- [ ] UI shows "Grant Permission" button (doesn't auto-prompt)

### After Grant (state: granted)
- [ ] Permissions API returns 'granted'
- [ ] Device enumeration returns devices WITH labels
- [ ] Stream acquisition succeeds
- [ ] Correct device selected and working

### After Deny (state: denied)
- [ ] Permissions API returns 'denied'
- [ ] getUserMedia throws NotAllowedError
- [ ] UI shows browser-specific reset instructions
- [ ] Instructions match actual browser being used

### Firefox-Specific
- [ ] If Permissions API returns 'prompt' but stream works, update UI to show 'granted'
- [ ] Container tab permissions isolated correctly

### Private/Incognito Mode
- [ ] Permission prompt appears (not remembered from normal mode)
- [ ] After grant, test works correctly
- [ ] On new private session, permission prompt appears again

---

## Error Reference

| Error | Cause | User-facing message |
|-------|-------|---------------------|
| `NotAllowedError` | Permission denied (user or OS) | "Microphone permission blocked" |
| `NotFoundError` | No mic connected | "No microphones found" |
| `NotReadableError` | Device busy or hardware error | "Microphone is in use or unavailable" |
| `OverconstrainedError` | Requested device doesn't exist | "Selected microphone not found" |
| `SecurityError` | Insecure context (HTTP) | "HTTPS required for microphone access" |

---

## Other Factors

These can block microphone access but are outside browser control:

- **OS privacy settings** — Check Windows/macOS privacy settings
- **Antivirus software** — Some security software blocks media access
- **Browser extensions** — Privacy extensions may block WebRTC
- **Corporate policies** — Group Policy can disable camera/microphone
- **VPNs** — Some VPNs interfere with WebRTC

For these issues, suggest testing in a private/incognito window first to isolate the cause.

---

## How Mic Check Handles These Quirks

When we encounter browser quirks during development, we consider whether users might also encounter them. Our approach:

### Quirks We Surface as Diagnostics

These are shown to users because they're actionable or explain confusing behavior:

| Quirk | Diagnostic | Why shown |
|-------|-----------|-----------|
| Private browsing detected | Permission Status shows "(private browsing — won't be saved)" | Explains why permission is asked each session |
| Default ≠ Communications device | Device enumeration shows both | Helps Windows users understand their device list |
| Permission change requires refresh | Level Check error shows "Refresh Page" button | After blocking then unblocking permission, browsers (especially Firefox) may cache the denied state until page reload |

### Quirks We Handle Silently

These are coded around without user notification because showing them would be more confusing:

| Quirk | How handled | Why silent |
|-------|-------------|-----------|
| Firefox Permissions API returns 'prompt' when already granted | Proceed directly with getUserMedia | User sees correct behavior; explaining the quirk adds confusion |
| Safari per-session permissions | Same as private browsing | User experience is consistent |

### Adding New Quirk Handling

When you discover a quirk:
1. Document it in this file
2. Ask: "Would a user be confused by this?"
3. If yes → create a diagnostic that explains
4. If no → handle silently with code comment

---

## Contributing

If you discover browser-specific behaviors not documented here:
1. Open an issue with browser name, version, and OS
2. Describe expected vs actual behavior
3. Include console output if available
