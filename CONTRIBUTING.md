# Contributing to Mic Check

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run locally: `python3 -m http.server 8765`
4. Open `http://localhost:8765`

## Pull Requests

- One feature or fix per PR
- Test in Chrome and Firefox
- Update SPEC_ISSUES.md if you discover browser quirks

## Code Style

- Single HTML file with embedded CSS/JS
- No build tools required
- Vanilla JS only (no frameworks)

## UX Guidelines

These principles guide our design decisions. See primary sources for details.

| Principle | Reference |
|-----------|-----------|
| Layout stability: fixed structure, only data changes | Nielsen Heuristic #4 (Consistency) |
| Reading order: Subject → Result ("Browser Support ✓") | Natural language order |
| Separate input from output: controls above, results below | Form design best practices |
| No information duplication across UI elements | DRY principle applied to UI |
| Section headers: smaller, uppercase, muted, more space above | iOS HIG, Material Design 3 |
| Error messages: what happened, why, how to fix | Nielsen Heuristic #9 |
| Warnings only when actionable and accurate | Nielsen Heuristic #5 |

## Diagnostic Modules

Each diagnostic in `js/diagnostics/` follows this pattern:

```javascript
export const diagnostic = {
    id: 'unique-id',
    name: 'Display Name',
    scope: SCOPE.DEVICE,  // ENVIRONMENT | SITE | DEVICE
    async test(context) {
        return { status, message, fix? };
    }
};
```

Scopes:
- `ENVIRONMENT`: Browser capabilities (run once)
- `SITE`: Permissions for this origin (run once)  
- `DEVICE`: Specific microphone (re-run on device switch)

## Questions?

Open an issue or discussion.
