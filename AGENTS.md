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
python3 dev-server.py
# Then open http://localhost:8765
```

The dev server sends no-cache headers to prevent browser caching issues during development.

## Key Features

- Quality analysis with LUFS measurements
- Stereo channel balance detection
- Dead channel diagnosis with fix instructions
- Downloadable JSON diagnostics
- Privacy-focused (no server uploads)

## UX Approach — Example-Driven Design

**Before implementing any new UI**, consult [ux-approach.md](ux-approach.md).

This document contains:
- UX principles with rationale
- **Canonical code examples** from this codebase for each principle
- Line numbers pointing to real implementations

**Why examples over rules:** LLMs follow patterns better than abstract guidelines. When you see how a principle is implemented, match that pattern exactly.

**Workflow:**
1. Identify which principles apply to your change
2. Find the canonical example for each in `ux-approach.md`
3. Match the pattern in your implementation
4. If you create something that exemplifies a principle well, add it to `ux-approach.md`

**When the user corrects a UX issue:** Consider whether it represents a new principle or example worth documenting.

## Code Review with CodeRabbit

To review uncommitted changes in plain text mode:

```bash
coderabbit review --type uncommitted --plain
```
