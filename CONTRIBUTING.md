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

See **[ux-approach.md](ux-approach.md)** for our UX principles with canonical code examples.

When implementing new UI, find and follow the patterns in that document rather than inventing new approaches.

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
