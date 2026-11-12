# Drive Nano Categorizer (`drive-nano-categorizer`)

A privacy-first, zero-build Single-Page Application that scans loose files in the root folder of Google Drive, summarizes and classifies them **100% locally on-device** using Chrome's Built-in AI (**Gemini Nano**), exports **Markdown & CSV** reports at **$0.00 API token cost**, and requires **zero Google Cloud Console setup**.

---

## Key Features

- **Zero Google Cloud Dependency:** Authenticates via a tiny **Google Apps Script Sign-In Bridge** (`script.google.com`), using Google's built-in Drive session (`USER_ACCESSING`)—no GCP project, no OAuth consent screen config, and no Client ID required.
- **100% Local Inference:** Uses Chrome's Built-in AI (`LanguageModel` in Chrome 138+ with fallback to `window.ai.languageModel`), keeping all document excerpts strictly on-device.
- **Per-File Context Isolation:** Clones and destroys a clean Gemini Nano session per file (`~1,000` words / `≤8,000` chars max) so context never bleeds or overflows across large batches.
- **Smart Content Extraction:**
  - Exports Google Docs (`text/plain`), Sheets (`text/csv`), and Slides (`text/plain`).
  - Fetches the first 64 KB (`Range: bytes=0-65535`) of plain-text, Markdown, CSV, JSON, and code files.
  - Classifies binary/PDF/Office/media files via filename and MIME metadata without downloading multi-MB blobs.
- **Strict Read-Only Default + Optional Folder Move:**
  - Ships with strict read-only scope (`https://www.googleapis.com/auth/drive.readonly`) in `apps-script/appsscript.json`.
  - Automatically restores your active Google session on launch, and supports moving selected files into categorized Drive folders (with one-click **Undo Last Move**) if you opt into `https://www.googleapis.com/auth/drive` in `appsscript.json`.
- **Instant Demo Mode & Heuristic Fallback:** Click **Try Sample Drive Data (Demo)** to test the entire workflow immediately with zero setup.

---

## Quick Start

### 1. Start the Local Server

Requires **Node.js 18+** (zero `npm install` packages needed):

```bash
npm start
```

Open **http://localhost:5173** in Google Chrome.

### 2. 60-Second Sign-In Bridge Setup (Zero Google Cloud)

1. Open [https://script.google.com](https://script.google.com) and click **New project**.
2. In **Project Settings** (gear icon), check **Show "appsscript.json" manifest file in editor**.
3. Copy in the three files from [`apps-script/`](./apps-script):
   - Replace `Code.gs` with [`apps-script/Code.gs`](./apps-script/Code.gs).
   - Add an HTML file named **`Bridge`** (`Bridge.html`) with [`apps-script/Bridge.html`](./apps-script/Bridge.html).
   - Replace `appsscript.json` with [`apps-script/appsscript.json`](./apps-script/appsscript.json). *(Tip: change `"access": "MYSELF"` to `"DOMAIN"` to share the bridge with teammates in your Google Workspace org, or change `drive.readonly` to `drive` if you want live folder moves enabled.)*
4. Click **Deploy → New deployment → Select type: Web app**:
   - **Execute as:** *User accessing the web app*
   - **Who has access:** *Only myself* (or *Anyone within `<Your Org>`*)
5. Copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`) and paste it into `.env` (`APPS_SCRIPT_WEBAPP_URL=...`) or directly into the setup box on `http://localhost:5173`.

### 3. Enable Chrome Built-in AI (Gemini Nano)

1. Open `chrome://flags/#optimization-guide-on-device-model` and set to **Enabled BypassPerfRequirement**.
2. Open `chrome://flags/#prompt-api-for-gemini-nano` and set to **Enabled**, then relaunch Chrome.
3. Open `chrome://components`, find **Optimization Guide On Device Model**, and click **Check for update** if version shows `0.0.0.0`.

---

## Running Automated Tests

```bash
npm test
```
