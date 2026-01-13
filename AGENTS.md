# Agent Instructions

This file contains instructions for AI coding agents working on this project.

## Git Operations - CRITICAL

**Never commit or push code without explicit user request.**

- Do NOT run `git commit` unless the user explicitly asks to commit
- Do NOT run `git push` unless the user explicitly asks to push
- Do NOT create branches unless the user explicitly asks
- Staging files (`git add`) is acceptable when preparing to show a diff, but do not proceed to commit

If you need to show the user what would be committed, use `git status` or `git diff` instead.

## Project Overview

mic-check is a browser-based microphone diagnostic tool. It helps users:
- Test if their microphone is working
- Diagnose stereo misconfiguration issues (dead channel detection)
- Compare audio levels to broadcast/streaming standards
- Generate downloadable diagnostic reports

## Tech Stack

- Single HTML file with embedded CSS and JavaScript
- No build process required
- Uses Web Audio API, MediaDevices API, Permissions API

## Running Locally

```bash
# From the project root directory:
python3 -m http.server 8765
# Then open http://localhost:8765
```

## Key Features

- Quality analysis with LUFS measurements
- Stereo channel balance detection
- Dead channel diagnosis with fix instructions
- Downloadable JSON diagnostics
- Privacy-focused (no server uploads)

## Code Review with CodeRabbit

To review uncommitted changes in plain text mode:

```bash
coderabbit review --type uncommitted --plain
```
