import { getMimeLabel } from './report-utils.js';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_WRITE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const PARTIAL_TEXT_MAX_BYTES = 65535; // 64 KB ceiling for direct text/code Range fetches

const WORKSPACE_EXPORT_MIMES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain'
};

const DIRECT_TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/x-yaml',
  'text/yaml',
  'application/sql'
]);

const DIRECT_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sql', 'sh', 'ps1', 'log', 'ini', 'toml', 'html', 'css'
]);

/**
 * Determine how a Google Drive file should be read locally:
 * - 'workspace-export': Export Docs/Sheets/Slides to plain text or CSV
 * - 'partial-text': Download first 64 KB via Range header
 * - 'metadata': Binary/PDF/Office/Media — zero binary download, classify via metadata
 */
export function getExtractionStrategy(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const ext = (String(file.name || '').split('.').pop() || '').toLowerCase();

  if (WORKSPACE_EXPORT_MIMES[mime]) {
    return {
      mode: 'workspace-export',
      exportMimeType: WORKSPACE_EXPORT_MIMES[mime]
    };
  }

  if (
    mime.startsWith('text/') ||
    DIRECT_TEXT_MIMES.has(mime) ||
    (ext && ext !== String(file.name || '').toLowerCase() && DIRECT_TEXT_EXTENSIONS.has(ext))
  ) {
    return { mode: 'partial-text' };
  }

  return { mode: 'metadata' };
}

/**
 * Escape single quotes and backslashes inside Google Drive `q` query string literals.
 */
export function escapeDriveQueryValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const APPS_SCRIPT_WEBAPP_REGEX =
  /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+\/|macros\/)s\/[a-zA-Z0-9_-]+\/(?:exec|dev)(?:\?.*)?$/;

/**
 * Validate that a URL is a genuine Google Apps Script Web App (`/exec` or `/dev`),
 * supporting both consumer (`script.google.com/macros/s/...`) and Google Workspace
 * domain (`script.google.com/a/macros/<domain>/s/...`) URLs.
 */
export function isValidAppsScriptWebAppUrl(url) {
  return APPS_SCRIPT_WEBAPP_REGEX.test(String(url || '').trim());
}

/**
 * Generate a cryptographic random state nonce to protect auth callbacks against CSRF.
 */
export function generateOAuthStateNonce(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoImpl.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Build the Google Apps Script Sign-In Bridge URL (`script.google.com`).
 * Zero Google Cloud Console project or Client ID required.
 */
export function buildAppsScriptBridgeUrl({
  appsScriptUrl,
  returnTo,
  state,
  popup = true
}) {
  const trimmedScriptUrl = String(appsScriptUrl || '').trim();
  if (!isValidAppsScriptWebAppUrl(trimmedScriptUrl)) {
    throw new Error(
      'Invalid Google Apps Script Web App URL. Expected https://script.google.com/macros/s/.../exec (or /dev).'
    );
  }
  const trimmedReturnTo = String(returnTo || '').trim();
  if (!trimmedReturnTo) {
    throw new Error('Missing localhost return_to URL.');
  }
  if (!state || !String(state).trim()) {
    throw new Error('Missing CSRF state nonce.');
  }

  const parsed = new URL(trimmedScriptUrl);
  parsed.searchParams.set('return_to', trimmedReturnTo);
  parsed.searchParams.set('state', String(state).trim());
  if (popup) {
    parsed.searchParams.set('popup', '1');
  } else {
    parsed.searchParams.delete('popup');
  }

  return parsed.toString();
}

/**
 * Parse `#access_token=...` or `#error=...` fragment returned from the Apps Script Bridge.
 * Returns `null` if the URL hash is not an auth callback.
 */
export function parseOAuthHashFragment(
  hash = '',
  expectedState = null,
  { allowFirstAuthRecovery = false } = {}
) {
  const cleaned = String(hash || '').replace(/^#/, '').trim();
  if (!cleaned) return null;

  const params = new URLSearchParams(cleaned);
  if (!params.has('access_token') && !params.has('error')) {
    return null;
  }

  const returnedState = params.get('state') || '';
  const isFirstAuthFallback = allowFirstAuthRecovery && returnedState === 'gas_first_auth';

  if (expectedState && returnedState !== expectedState && !isFirstAuthFallback) {
    return {
      ok: false,
      error: 'state_mismatch',
      errorDescription: 'Sign-in state token mismatch. Please try signing in again.',
      state: returnedState
    };
  }

  if (params.has('error')) {
    const errorCode = params.get('error') || 'auth_error';
    return {
      ok: false,
      error: errorCode,
      errorDescription: params.get('error_description') || '',
      state: returnedState
    };
  }

  const accessToken = params.get('access_token') || '';
  const scope = params.get('scope') || DRIVE_READONLY_SCOPE;
  const expiresIn = Number(params.get('expires_in') || 3300);
  const email = params.get('email') || '';
  const displayName = params.get('name') || '';
  const photoLink = params.get('photo') || '';

  return {
    ok: true,
    accessToken,
    expiresIn,
    scope,
    email,
    displayName,
    photoLink,
    hasWriteAccess: hasWriteScope({ scope }),
    state: returnedState
  };
}

export function hasWriteScope(tokenResponse) {
  const granted = String(tokenResponse?.scope || '').split(/\s+/);
  return granted.includes(DRIVE_WRITE_SCOPE);
}

/**
 * Validate an access token against Drive API and return the signed-in Google user's profile.
 */
export async function fetchDriveUserProfile({
  accessToken,
  signal,
  fetchImpl = fetch
}) {
  const data = await driveFetchJson(
    `${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress,photoLink)`,
    { accessToken, signal, fetchImpl }
  );
  const user = data?.user || {};
  return {
    displayName: user.displayName || '',
    emailAddress: user.emailAddress || '',
    photoLink: user.photoLink || ''
  };
}

/**
 * Inspect actual granted OAuth scopes and validity on a Google token via `tokeninfo`.
 */
export async function inspectTokenScopes({
  accessToken,
  signal,
  fetchImpl = fetch
}) {
  try {
    const res = await fetchImpl(
      `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
      { signal }
    );
    if (res.status === 400 || res.status === 401) {
      return { isInvalid: true, scope: '', hasWriteAccess: false, expiresIn: 0, email: '' };
    }
    if (!res.ok) return null;
    const info = await res.json();
    const scope = String(info?.scope || '');
    return {
      isInvalid: false,
      scope,
      email: String(info?.email || ''),
      hasWriteAccess: hasWriteScope({ scope }),
      expiresIn: Number(info?.expires_in || 0)
    };
  } catch {
    return null;
  }
}

async function driveFetchJson(url, { method = 'GET', accessToken, body, signal, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetchImpl(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let detail = errBody;
    try {
      const parsed = JSON.parse(errBody);
      detail = parsed?.error?.message || errBody;
    } catch {
      // Keep raw text
    }
    throw new Error(`Google Drive API HTTP ${res.status}: ${detail || res.statusText}`);
  }

  return res.json();
}

/**
 * List non-folder, non-trashed loose files sitting directly in the user's Google Drive root folder.
 */
export async function listRootLooseFiles({
  accessToken,
  maxFiles = 25,
  signal,
  fetchImpl = fetch
}) {
  const collected = [];
  let pageToken = '';
  const query = "'root' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false";
  const fields =
    'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,description,capabilities(canMoveItemWithinDrive))';

  while (collected.length < maxFiles) {
    const remaining = Number.isFinite(maxFiles) ? Math.min(100, maxFiles - collected.length) : 100;
    const params = new URLSearchParams({
      q: query,
      pageSize: String(remaining),
      orderBy: 'modifiedTime desc',
      fields
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const data = await driveFetchJson(`${DRIVE_API_BASE}/files?${params.toString()}`, {
      accessToken,
      signal,
      fetchImpl
    });

    const batch = (data.files || []).map((f) => ({
      id: f.id,
      name: f.name || 'Untitled',
      mimeType: f.mimeType || 'application/octet-stream',
      size: f.size ? Number(f.size) : null,
      createdTime: f.createdTime || '',
      modifiedTime: f.modifiedTime || '',
      webViewLink: f.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(f.id)}`,
      description: f.description || '',
      canMove: f.capabilities?.canMoveItemWithinDrive !== false
    }));

    collected.push(...batch);

    if (!data.nextPageToken || batch.length === 0) {
      break;
    }
    pageToken = data.nextPageToken;
  }

  return Number.isFinite(maxFiles) ? collected.slice(0, maxFiles) : collected;
}

/**
 * Extract local text snippet or metadata descriptor for a single Drive file.
 */
export async function extractFileContent(
  file,
  { accessToken, signal, fetchImpl = fetch } = {}
) {
  const mimeLabel = getMimeLabel(file.mimeType, file.name);

  // Demo Mode sample shortcut
  if (typeof file.demoSnippet === 'string') {
    return {
      text: file.demoSnippet,
      extractionSource: file.demoSnippet ? 'demo-text' : 'metadata',
      mimeLabel
    };
  }

  const strategy = getExtractionStrategy(file);

  if (strategy.mode === 'metadata') {
    return {
      text: '',
      extractionSource: 'metadata',
      mimeLabel
    };
  }

  try {
    if (strategy.mode === 'workspace-export') {
      const exportUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(
        file.id
      )}/export?mimeType=${encodeURIComponent(strategy.exportMimeType)}`;

      const res = await fetchImpl(exportUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal
      });

      if (!res.ok) {
        return { text: '', extractionSource: 'metadata', mimeLabel };
      }

      const text = await res.text();
      return {
        text,
        extractionSource: 'workspace-export',
        mimeLabel
      };
    }

    if (strategy.mode === 'partial-text') {
      const mediaUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`;
      const res = await fetchImpl(mediaUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Range: `bytes=0-${PARTIAL_TEXT_MAX_BYTES}`
        },
        signal
      });

      if (!res.ok) {
        return { text: '', extractionSource: 'metadata', mimeLabel };
      }

      const text = await res.text();
      return {
        text,
        extractionSource: 'partial-text',
        mimeLabel
      };
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      throw err;
    }
    return {
      text: '',
      extractionSource: 'metadata',
      mimeLabel
    };
  }

  return { text: '', extractionSource: 'metadata', mimeLabel };
}

/**
 * Find an existing non-trashed folder under `parentId` with the exact `folderName`,
 * or create it if none exists. Uses `folderCache` across a batch to prevent duplicates.
 */
export async function findOrCreateFolder({
  folderName,
  parentId = 'root',
  accessToken,
  folderCache,
  signal,
  fetchImpl = fetch
}) {
  const cacheKey = `${parentId}::${folderName.toLowerCase()}`;
  if (folderCache && folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  const escapedName = escapeDriveQueryValue(folderName);
  const escapedParent = escapeDriveQueryValue(parentId);
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${escapedParent}' in parents and trashed = false`;

  const searchParams = new URLSearchParams({
    q,
    pageSize: '1',
    fields: 'files(id,name)'
  });

  const existing = await driveFetchJson(
    `${DRIVE_API_BASE}/files?${searchParams.toString()}`,
    { accessToken, signal, fetchImpl }
  );

  if (existing.files && existing.files.length > 0) {
    const existingId = existing.files[0].id;
    if (folderCache) folderCache.set(cacheKey, existingId);
    return existingId;
  }

  const created = await driveFetchJson(`${DRIVE_API_BASE}/files?fields=id,name`, {
    method: 'POST',
    accessToken,
    body: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    signal,
    fetchImpl
  });

  if (folderCache) folderCache.set(cacheKey, created.id);
  return created.id;
}

/**
 * Move selected Drive root files into their resolved destination folder paths,
 * reusing existing folders and recording an Undo journal.
 *
 * @param {Array<{fileId: string, fileName: string, segments: string[], displayPath: string}>} assignments
 */
export async function moveFilesToTargets(
  assignments,
  { accessToken, onProgress, signal, fetchImpl = fetch } = {}
) {
  const folderCache = new Map();
  const moved = [];
  const failed = [];

  for (let i = 0; i < assignments.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Move operation cancelled', 'AbortError');
    }

    const item = assignments[i];
    if (onProgress) {
      onProgress({ current: i + 1, total: assignments.length, fileName: item.fileName });
    }

    try {
      let currentParentId = 'root';
      for (const segment of item.segments) {
        currentParentId = await findOrCreateFolder({
          folderName: segment,
          parentId: currentParentId,
          accessToken,
          folderCache,
          signal,
          fetchImpl
        });
      }

      const updateParams = new URLSearchParams({
        addParents: currentParentId,
        removeParents: 'root',
        fields: 'id,parents'
      });

      await driveFetchJson(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(item.fileId)}?${updateParams.toString()}`,
        {
          method: 'PATCH',
          accessToken,
          signal,
          fetchImpl
        }
      );

      moved.push({
        fileId: item.fileId,
        fileName: item.fileName,
        fromParentId: 'root',
        toFolderId: currentParentId,
        displayPath: item.displayPath
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      failed.push({
        fileId: item.fileId,
        fileName: item.fileName,
        error: err?.message || String(err)
      });
    }
  }

  return { moved, failed };
}

/**
 * Restore a previously moved batch of files back to `'root'`.
 */
export async function undoMoveBatch(
  undoRecords,
  { accessToken, signal, fetchImpl = fetch } = {}
) {
  const restored = [];
  const failed = [];

  for (const rec of undoRecords) {
    try {
      const updateParams = new URLSearchParams({
        addParents: rec.fromParentId || 'root',
        removeParents: rec.toFolderId,
        fields: 'id,parents'
      });

      await driveFetchJson(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(rec.fileId)}?${updateParams.toString()}`,
        {
          method: 'PATCH',
          accessToken,
          signal,
          fetchImpl
        }
      );
      restored.push(rec);
    } catch (err) {
      failed.push({ ...rec, error: err?.message || String(err) });
    }
  }

  return { restored, failed };
}

/**
 * Rich realistic loose root Drive files for zero-setup Demo Mode testing.
 */
export const SAMPLE_DRIVE_FILES = [
  {
    id: 'demo-doc-arch-rfc',
    name: 'RFC-042 On-Device AI Telemetry Gateway Architecture',
    mimeType: 'application/vnd.google-apps.document',
    createdTime: '2026-10-14T09:15:00Z',
    modifiedTime: '2026-11-09T17:42:00Z',
    webViewLink: 'https://docs.google.com/document/d/demo-doc-arch-rfc',
    canMove: true,
    demoSnippet:
      'RFC-042 proposes migrating internal browser automation extensions to a zero-egress client-side architecture powered by Chrome Gemini Nano and strict OAuth read-only tokens. Latency benchmarks show p95 inference of 480ms per 800-word document chunk on integrated laptop NPUs while eliminating $1,400/month in cloud API gateway spend.'
  },
  {
    id: 'demo-sheet-q4-budget',
    name: 'FY27 Q1 Team Ops Budget & SaaS Renewal Forecast',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    createdTime: '2026-10-20T14:00:00Z',
    modifiedTime: '2026-11-10T11:20:00Z',
    webViewLink: 'https://docs.google.com/spreadsheets/d/demo-sheet-q4-budget',
    canMove: true,
    demoSnippet:
      'Vendor,Department,Renewal Date,Annual Cost USD,Status\nFigma Enterprise,Product Design,2027-01-15,48000,Approved\nJira Cloud Premium,Engineering,2027-02-01,62500,Pending Procurement Audit\nLogiOps Analytics,Internal Ops,2027-01-30,18400,Invoice Received - PO#88412'
  },
  {
    id: 'demo-pdf-nda',
    name: 'Mutual_NDA_Acme_Semiconductor_Signed_2026.pdf',
    mimeType: 'application/pdf',
    size: 842190,
    createdTime: '2026-09-28T16:30:00Z',
    modifiedTime: '2026-11-02T08:12:00Z',
    webViewLink: 'https://drive.google.com/file/d/demo-pdf-nda/view',
    description: 'Countersigned bilateral non-disclosure agreement for hardware prototype evaluation.',
    canMove: true,
    demoSnippet: ''
  },
  {
    id: 'demo-doc-prd',
    name: 'PRD - Smart Workspace Dock Firmware Auto-Updater v2',
    mimeType: 'application/vnd.google-apps.document',
    createdTime: '2026-10-03T10:00:00Z',
    modifiedTime: '2026-11-08T19:05:00Z',
    webViewLink: 'https://docs.google.com/document/d/demo-doc-prd',
    canMove: true,
    demoSnippet:
      'Product Requirements Document: Users frequently defer dock firmware updates during video calls. This release introduces silent background staging, UX toast scheduling outside calendar meetings, and IT admin policy rings. Target user research NPS lift: +14 points.'
  },
  {
    id: 'demo-doc-meeting-retro',
    name: '2026-11-06 Biweekly Automation Guild Sync & Retro Notes',
    mimeType: 'application/vnd.google-apps.document',
    createdTime: '2026-11-06T16:00:00Z',
    modifiedTime: '2026-11-06T17:05:00Z',
    webViewLink: 'https://docs.google.com/document/d/demo-doc-meeting-retro',
    canMove: true,
    demoSnippet:
      'Attendees: Priya, Marco, Alex, Lin. Agenda & Action Items: 1) Retrospective on Q3 citizen developer intake queue. 2) Marco to publish Apps Script OAuth governance checklist by Friday. 3) Next standup moved to Thursday 10am PST.'
  },
  {
    id: 'demo-slides-gtm',
    name: 'MX Enterprise Series Q1 Go-To-Market & Channel Launch Deck',
    mimeType: 'application/vnd.google-apps.presentation',
    createdTime: '2026-10-18T12:20:00Z',
    modifiedTime: '2026-11-07T15:48:00Z',
    webViewLink: 'https://docs.google.com/presentation/d/demo-slides-gtm',
    canMove: true,
    demoSnippet:
      'Slide 1: Global B2B Channel Campaign Overview. Slide 2: Customer segmentation, webinar demand generation pipeline targets ($4.2M Q1 ARR), and partner co-marketing case studies across EMEA and North America.'
  },
  {
    id: 'demo-md-onboarding',
    name: 'new-hire-onboarding-30-60-90-plan.md',
    mimeType: 'text/markdown',
    size: 12480,
    createdTime: '2026-08-19T11:10:00Z',
    modifiedTime: '2026-10-29T13:33:00Z',
    webViewLink: 'https://drive.google.com/file/d/demo-md-onboarding/view',
    canMove: true,
    demoSnippet:
      '# Automation Specialist Onboarding Handbook (30-60-90 Days)\nWelcome to People & Internal Ops! Week 1 covers IT security benefits enrollment, buddy 1:1 intros, OKR alignment with your hiring manager, and reviewing our Tier 1-3 AI governance policies.'
  },
  {
    id: 'demo-csv-inventory',
    name: 'lab_device_inventory_audit_nov2026.csv',
    mimeType: 'text/csv',
    size: 28900,
    createdTime: '2026-11-01T08:45:00Z',
    modifiedTime: '2026-11-11T09:10:00Z',
    webViewLink: 'https://drive.google.com/file/d/demo-csv-inventory/view',
    canMove: true,
    demoSnippet:
      'AssetTag,Facility,Model,AssignedBench,CalibrationChecklist,SOP_Status\nLOGI-LAB-401,San Jose Bldg B,Rally Bar Huddle,Bench-04,Passed,Compliant\nLOGI-LAB-402,Lausanne HQ,Sight Camera,Bench-11,Due 2026-11-20,Runbook Scheduled'
  },
  {
    id: 'demo-img-whiteboard',
    name: 'IMG_20261104_workshop_whiteboard_capture.png',
    mimeType: 'image/png',
    size: 4192300,
    createdTime: '2026-11-04T18:15:00Z',
    modifiedTime: '2026-11-04T18:15:00Z',
    webViewLink: 'https://drive.google.com/file/d/demo-img-whiteboard/view',
    description: 'Photo of off-site architecture whiteboard diagram.',
    canMove: false,
    demoSnippet: ''
  },
  {
    id: 'demo-txt-scratch',
    name: 'untitled-quick-links-temp.txt',
    mimeType: 'text/plain',
    size: 420,
    createdTime: '2026-11-05T21:00:00Z',
    modifiedTime: '2026-11-05T21:04:00Z',
    webViewLink: 'https://drive.google.com/file/d/demo-txt-scratch/view',
    canMove: true,
    demoSnippet:
      'Misc bookmarks to check later: flight confirmation code XK92LP, coffee beans order link, reminder to clean up Downloads folder.'
  }
];
