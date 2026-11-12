# SPEC.md: Google Drive File Categorizer & Summarizer (Chrome Built-in AI)

## 1. Executive Summary & Scope

- **Project Name:** Local Drive Categorizer (`drive-nano-categorizer`)
- **Problem Statement:** Loose files in the root folder of Google Drive require manual inspection to organize, categorize, and summarize. Cloud-based LLM batch pipelines introduce API costs and token limit overheads when iterating across multiple files.
- **Solution:** A zero-build client-side web app using Chrome's Built-in AI (`LanguageModel` / `window.ai.languageModel` — Gemini Nano) to summarize and classify Drive files locally on-device via the Google Drive API, with interactive Markdown/CSV export and opt-in folder organization.
- **Target Audience:** Individual Logitech employees / Internal team ops.
- **Frequency:** On-demand batch execution.
- **Builder Persona:** Citizen Developer / Automation Specialist.
- **Duplicate Project Check:** Verified no identical client-side Gemini Nano Drive indexer exists in the AI Project Lifecycle Tracker.

---

## 2. Architecture & Tiering Classification

- **Approved Architectural Tier:** **Tier 1 (Lightweight Browser & Local Automation)**
- **Deployment Surface:** Zero-build Local Single-Page Application (vanilla ES Modules served via built-in Node static server `server.js`).
- **Execution Environment:** Google Chrome (v128–137 via `window.ai.languageModel` or v138+ via global `LanguageModel` with `#optimization-guide-on-device-model` and `#prompt-api-for-gemini-nano` enabled; includes opt-in local heuristic fallback and Demo Mode).
- **Architectural Flow:**
  `[User Browser]` ──(OAuth 2.0 `drive.readonly`)──> `[Google Drive API]` ──(Export Docs/Sheets/Slides & Partial Text / Metadata)──> `[Local Memory]` ──(Prompt API + JSON Schema)──> `[On-Device Gemini Nano]` ──> `[Interactive Markdown/CSV Table + Opt-In Folder Move]`

---

## 3. AI & Token Governance Specification

- **Model Selection:** **Gemini Nano** via Chrome Built-in AI (`self.LanguageModel` with fallback to `window.ai.languageModel`).
- **Cost & Quota Impact:** **$0.00 (Zero API Token Costs)**. All inference occurs locally on GPU/NPU.
- **Context Window Budget:** 
  - Max input per file chunk: ~2,000 tokens (truncate large document bodies; process titles and first 1,000 words / ≤6,000 chars).
  - Session Isolation: Base session initialized with system prompt & editable category taxonomy; cloned (`session.clone()`) and destroyed per file to prevent context overflow or cross-file contamination.
  - Temperature: `0.2` (applied with valid `topK` when supported by `params()`, with automatic web-origin fallback).
- **Tabular Data Mandate:**
  - File metadata (IDs, names, MIME types, creation/modification dates, links) is handled deterministically via client-side JavaScript.
  - Workspace files are exported to plain text/CSV; text/code files use `Range: bytes=0-65535` partial fetches; binary/PDF/media files are classified deterministically via filename + MIME metadata without downloading binary blobs.

---

## 4. Data Privacy, Security & Compliance

- **Data Classification:** **Green / Yellow** (Internal documents & operational files).
- **Data Privacy Guarantee:** 100% Local On-Device processing. No document body or text snippet is transmitted to external AI endpoints or cloud servers.
- **Authentication & Scopes (Zero Google Cloud Console):**
  - Protocol: Google Apps Script Sign-In Bridge (`script.google.com` Web App configured with `executeAs: "USER_ACCESSING"` + `BroadcastChannel` popup relay and automatic `localStorage` session restore on launch). Zero GCP project or OAuth Client ID required.
  - Default Scope: `https://www.googleapis.com/auth/drive.readonly` (strictly read-only for scanning, summarizing, and exporting).
  - Opt-In Folder Move Scope: `https://www.googleapis.com/auth/drive` (enabled only if configured in `apps-script/appsscript.json`; reuses existing root folders and supports one-click Undo back to root).
  - Access Level: Runs strictly under the logged-in user's credentials with zero elevated service accounts.

---

## 5. Implementation Guide for Antigravity AI IDE

### Project Directory Structure

```text
google-drive-file-categorizer/
├── index.html             # Main UI dashboard with Google Sign-In Gate, diagnostics, filters & move modal
├── app.js                 # Orchestration: Apps Script auth -> Drive fetch -> Gemini Nano -> Export / Move
├── drive-api.js           # Google Drive API v3 Client (Apps Script Bridge, Fetchers, Folder Move & Undo)
├── gemini-nano.js         # Dual-API wrapper for Chrome LanguageModel / window.ai.languageModel + Heuristic
├── report-utils.js        # Pure CSV (formula-safe), Markdown table, filter/sort & target folder path utilities
├── style.css              # Clean responsive dashboard styling
├── server.js              # Zero-dependency local Node server exposing .env APPS_SCRIPT_WEBAPP_URL via /api/config
├── package.json           # Scripts for npm start & npm test (zero external npm dependencies)
├── .env.example           # Apps Script Web App URL & port configuration reference
├── apps-script/           # Zero-GCP Google Apps Script Sign-In Bridge (0/100 Low Risk GAS manifest & code)
│   ├── appsscript.json
│   ├── Code.gs
│   └── Bridge.html
└── tests/
    └── categorizer.test.js # Automated Node unit, security & integration tests
```