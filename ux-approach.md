# UX Approach

This document defines our UX principles and provides **canonical examples** from the codebase. When implementing new UI, **find and follow these patterns** rather than inventing new approaches.

## Core Philosophy

LLMs follow examples better than rules. Each principle below includes:
- **What it means** — the underlying reasoning
- **Canonical example** — actual code in this project that exemplifies it
- **Reference** — authoritative source for deeper understanding

---

## Principles

### 1. Layout Stability

**Rule:** Fixed structure, only data changes. Never add/remove elements based on state.

**Why:** Users build spatial memory. Elements that appear, disappear, or shift location force cognitive re-mapping.

**Canonical Example:**

```798:842:index.html
<tr id="diag-row-browser-support">
    <td class="diag-test">
        <div class="diag-name">Browser Support</div>
        <div class="diag-detail"></div>
        <div class="diag-action" style="display: none;"></div>
    </td>
    <td class="diag-status"><span class="diag-icon">⏸️</span></td>
</tr>
```

All diagnostic rows exist in the DOM from page load. JavaScript updates the icon and detail text—never adds or removes rows.

**Reference:** Nielsen Heuristic #4 (Consistency and Standards)

---

### 2. Reading Order: Subject → Result

**Rule:** Labels come before values. "Browser Support ✓" not "✓ Browser Support".

**Why:** Matches natural language and scanning patterns. Users scan the left edge for labels, then look right for values.

**Canonical Example:**

```798:805:index.html
<tr id="diag-row-browser-support">
    <td class="diag-test">
        <div class="diag-name">Browser Support</div>
        <!-- ... -->
    </td>
    <td class="diag-status"><span class="diag-icon">⏸️</span></td>
</tr>
```

The test name is in the left column, status icon in the right. Table columns enforce consistent reading order.

**Reference:** Natural language order; F-pattern scanning research

---

### 3. Separate Input from Output

**Rule:** Controls (inputs) appear above results (outputs). Never interleave them.

**Why:** Creates predictable spatial zones. Users know where to look for actions vs. information.

**Canonical Example:**

```782:842:index.html
<!-- Device Selector (shown after permission) - INPUT/CONTROL area -->
<div id="device-selector" style="display: none; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border);">
    <label for="device-select" ...>Test this microphone:</label>
    <select id="device-select" ...></select>
</div>

<!-- Diagnostic Results Table - OUTPUT area, stable structure -->
<table id="diagnostic-table" class="diagnostic-table">
    ...
</table>
```

The device selector (control) is above and visually separated from the diagnostic table (results).

**Reference:** Form design best practices; progressive disclosure

---

### 4. No Information Duplication

**Rule:** Each piece of information appears in exactly one place.

**Why:** Duplicated information can become inconsistent and increases cognitive load. Users shouldn't wonder "which one is current?"

**Canonical Example:**

The selected microphone appears only in `#device-select`. There's no separate "Currently testing: X" label that would need to stay in sync.

**Anti-pattern to avoid:** Showing the device name in both a dropdown AND a header/status area.

**Reference:** DRY principle applied to UI

---

### 5. Section Headers

**Rule:** Smaller font, uppercase, muted color, more vertical space above than below.

**Why:** Creates visual hierarchy without competing with content. The extra space above signals "new section" while proximity below groups content with its header.

**Canonical Example:**

```822:824:index.html
<tr class="diag-section-row">
    <td colspan="2" class="diag-section-header">Selected Microphone</td>
</tr>
```

```304:317:index.html (CSS)
.diag-section-row td {
    padding-top: 1rem;          /* more space above */
    padding-bottom: 0.4rem;     /* less space below */
    border-bottom: none;
}

.diag-section-header {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
}
```

**Reference:** iOS Human Interface Guidelines; Material Design 3

---

### 6. Error Messages: What, Why, How

**Rule:** Every error message must include:
1. What happened (the problem)
2. Why it matters or why it happened
3. How to fix it (specific action)

**Canonical Example:**

```905:912:index.html
<div id="playback-warning" class="status-card warning" ...>
    <span class="status-icon">🔇</span>
    <div class="status-text">
        <div class="status-title">We didn't hear much</div>           <!-- WHAT -->
        <div class="status-detail">
            Your mic may be too quiet.                                 <!-- WHY -->
            <a href="#" id="link-playback-level-check">Run a Level Check</a> to diagnose.  <!-- HOW -->
        </div>
    </div>
</div>
```

**Reference:** Nielsen Heuristic #9 (Help users recognize, diagnose, and recover from errors)

---

### 7. Warnings Only When Actionable

**Rule:** Never show a warning unless:
1. The condition is actually a problem (not just unusual)
2. The user can do something about it
3. We're confident in the diagnosis

**Why:** False positives erode trust. Users learn to ignore warnings if they're often wrong or unhelpful.

**Canonical Example:**

The playback warning (above) only appears when:
- Recording detected very low audio (confident diagnosis)
- User can take action (Level Check link provided)

We do NOT warn about things like "unusual sample rate" that aren't problems.

**Reference:** Nielsen Heuristic #5 (Error prevention); alarm fatigue research

---

### 8. Inline Actions (Proximity Principle)

**Rule:** Actions and fixes belong with the content they relate to, not in a separate area.

**Why:** Gestalt proximity principle — items close together are perceived as related. A button visually separated from its context feels disconnected and confusing.

**Canonical Example:**

```798:806:index.html
<tr id="diag-row-permission-state">
    <td class="diag-test">
        <div class="diag-name">Permission Status</div>
        <div class="diag-detail"></div>
        <div class="diag-action" style="display: none;"></div>  <!-- Action goes HERE, in the row -->
    </td>
    <td class="diag-status"><span class="diag-icon">⏸️</span></td>
</tr>
```

The "Request Audio Access" button appears inside the Permission Status row, not as a separate panel elsewhere on the page. Fix instructions for failing diagnostics appear inline in their respective rows.

**Anti-pattern to avoid:** Separate "How to fix" panels at the bottom of the page, disconnected from the failing diagnostic.

**Reference:** Gestalt proximity principle; Nielsen Heuristic #6 (Recognition rather than recall)

---

## Using This Document

### For AI Agents

Before implementing new UI:
1. Identify which principles apply
2. Find the canonical example for each
3. Match the pattern exactly unless there's a specific reason not to
4. If adding a genuinely new pattern, add it here with rationale

### For Humans

When reviewing AI-generated code:
1. Check that new UI follows these patterns
2. If the AI deviated, determine if it's an improvement worth documenting or a mistake to correct
3. Add new canonical examples as the codebase evolves

---

## Adding New Examples

When you implement something that exemplifies a principle well, add it here:

```markdown
**Canonical Example:**

```start:end:path/to/file.ext
// the relevant code
```

Brief explanation of why this is a good example.
```

This document is the source of truth for UX patterns. Keep it current.
