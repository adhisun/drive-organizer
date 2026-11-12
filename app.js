import {
  DEFAULT_CATEGORIES,
  CategorizerEngine,
  checkAiAvailability,
  ensureCategoriesList
} from './gemini-nano.js';
import {
  SAMPLE_DRIVE_FILES,
  buildAppsScriptBridgeUrl,
  extractFileContent,
  fetchDriveUserProfile,
  generateOAuthStateNonce,
  inspectTokenScopes,
  isValidAppsScriptWebAppUrl,
  listRootLooseFiles,
  moveFilesToTargets,
  parseOAuthHashFragment,
  undoMoveBatch
} from './drive-api.js';
import {
  filterAndSortResults,
  formatShortDate,
  getMimeLabel,
  resolveTargetFolder,
  sanitizeFolderSegment,
  toCsv,
  toMarkdownTable
} from './report-utils.js';

const AUTH_CHANNEL_NAME = 'drive_nano_auth';

const STORAGE_KEYS = {
  appsScriptUrl: 'driveNano.appsScriptUrl',
  categories: 'driveNano.categories',
  allowHeuristic: 'driveNano.allowHeuristic',
  sessionToken: 'driveNano.authSession',
  oauthState: 'driveNano.oauthState'
};

const state = {
  appsScriptUrl: '',
  appsScriptSource: '',
  accessToken: '',
  tokenExpiresAt: 0,
  hasWriteAccess: false,
  userProfile: null,
  isDemoMode: false,
  aiDiagnostics: null,
  categories: [...DEFAULT_CATEGORIES],
  allowHeuristic: true,
  rows: [],
  selectedIds: new Set(),
  activeCategoryFilter: 'ALL',
  searchQuery: '',
  sortBy: 'modifiedTime',
  sortDir: 'desc',
  includeSubfolderInMove: false,
  isScanning: false,
  scanAbortController: null,
  lastUndoBatch: null
};

const dom = {};
let authChannel = null;

function cacheDom() {
  const ids = [
    'aiStatusBadge', 'authStatusBadge', 'userProfileChip', 'userAvatar', 'userEmailText', 'btnSignOut',
    'btnToggleGuide', 'btnCloseGuide', 'aiFlagsGuide',
    'btnToggleSettings', 'settingsDrawer', 'inputAppsScriptUrl', 'btnSaveAppsScriptUrl', 'appsScriptSourceHint',
    'chkAllowHeuristic', 'taxonomyList', 'inputNewCategory', 'btnAddCategory', 'btnResetCategories',
    'authGatePanel', 'authGateTitle', 'authGateMessage', 'authGateError',
    'gateBridgeSetup', 'inputGateAppsScriptUrl', 'btnSaveGateAppsScriptUrl',
    'btnGoogleGateSignIn', 'btnGateDemo',
    'workspaceArea',
    'btnSignIn', 'selectBatchSize', 'btnScanDrive', 'btnCancelScan', 'btnDemoScan',
    'progressPanel', 'progressText', 'progressCount', 'progressFill',
    'undoBanner', 'undoMessage', 'btnUndoMove',
    'categoryChips', 'inputSearch', 'selectSort', 'resultsSummaryText',
    'btnCopyMarkdown', 'btnDownloadMarkdown', 'btnDownloadCsv', 'btnOpenMoveModal', 'selectedCount',
    'chkSelectAll', 'resultsTbody',
    'moveModal', 'btnCloseMoveModal', 'moveScopeNotice', 'chkIncludeSubfolder',
    'movePreviewTbody', 'btnCancelMove', 'btnConfirmMove',
    'toastContainer'
  ];
  for (const id of ids) {
    dom[id] = document.getElementById(id);
  }
}

function getCleanReturnToUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function showToast(message, type = 'info') {
  if (!dom.toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4500);
}

function saveAuthSession({ accessToken, expiresAt, scope, hasWriteAccess, userProfile = null }) {
  state.accessToken = accessToken;
  state.tokenExpiresAt = expiresAt;
  state.hasWriteAccess = Boolean(hasWriteAccess);
  if (userProfile) {
    state.userProfile = userProfile;
  }

  try {
    localStorage.setItem(
      STORAGE_KEYS.sessionToken,
      JSON.stringify({
        accessToken,
        expiresAt,
        scope,
        hasWriteAccess: state.hasWriteAccess,
        userProfile: state.userProfile
      })
    );
  } catch {
    // Ignore storage errors
  }
}

function clearAuthSession() {
  state.accessToken = '';
  state.tokenExpiresAt = 0;
  state.hasWriteAccess = false;
  state.userProfile = null;
  try {
    localStorage.removeItem(STORAGE_KEYS.sessionToken);
  } catch {
    // Ignore storage errors
  }
}

async function loadInitialConfig() {
  try {
    const storedCategories = JSON.parse(localStorage.getItem(STORAGE_KEYS.categories) || 'null');
    if (Array.isArray(storedCategories) && storedCategories.length > 0) {
      state.categories = ensureCategoriesList(storedCategories);
    }
    const storedHeuristic = localStorage.getItem(STORAGE_KEYS.allowHeuristic);
    if (storedHeuristic !== null) {
      state.allowHeuristic = storedHeuristic === 'true';
    }
    const storedScriptUrl = localStorage.getItem(STORAGE_KEYS.appsScriptUrl) || '';
    if (storedScriptUrl) {
      state.appsScriptUrl = storedScriptUrl;
      state.appsScriptSource = 'Saved in browser Settings';
    }
  } catch {
    // Ignore storage errors
  }

  // Load APPS_SCRIPT_WEBAPP_URL from local server .env (/api/config) if present
  try {
    const res = await fetch('./api/config', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg?.appsScriptUrl && !state.appsScriptUrl) {
        state.appsScriptUrl = cfg.appsScriptUrl;
        state.appsScriptSource = 'Configured via .env';
      }
    }
  } catch {
    // Static host without /api/config — safe to ignore
  }

  dom.inputAppsScriptUrl.value = state.appsScriptUrl;
  dom.inputGateAppsScriptUrl.value = state.appsScriptUrl;
  dom.chkAllowHeuristic.checked = state.allowHeuristic;
  renderAppsScriptUrlHint();
  renderTaxonomyEditor();
}

function renderAppsScriptUrlHint() {
  const valid = isValidAppsScriptWebAppUrl(state.appsScriptUrl);
  dom.gateBridgeSetup.classList.toggle('hidden', valid);

  if (valid) {
    dom.appsScriptSourceHint.textContent = `${state.appsScriptSource || 'Configured'} (script.google.com bridge active)`;
  } else if (state.appsScriptUrl) {
    dom.appsScriptSourceHint.textContent =
      'Invalid URL format. Paste a https://script.google.com/macros/s/.../exec (or /dev) Web App URL.';
  } else {
    dom.appsScriptSourceHint.textContent =
      'Not set yet. Add APPS_SCRIPT_WEBAPP_URL to .env or paste above.';
  }
}

function setGateError(message = '') {
  dom.authGateError.textContent = message;
  dom.authGateError.classList.toggle('hidden', !message);
}

let authPollTimer = null;

function stopAuthSessionPolling() {
  if (authPollTimer) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
}

function startAuthSessionPolling() {
  stopAuthSessionPolling();
  const startedAt = Date.now();
  authPollTimer = setInterval(async () => {
    if (state.accessToken) {
      stopAuthSessionPolling();
      return;
    }
    const ok = await restoreStoredSessionIfValid({ announce: true });
    if (ok || Date.now() - startedAt > 5 * 60 * 1000) {
      stopAuthSessionPolling();
    }
  }, 650);
}

/**
 * Open Google Sign-In via the deployed Google Apps Script Web App (`script.google.com`).
 * Relays the session back via server memory (`/api/auth-session`), BroadcastChannel, and localStorage.
 */
function openAppsScriptSignIn() {
  if (!isValidAppsScriptWebAppUrl(state.appsScriptUrl)) {
    dom.gateBridgeSetup.classList.remove('hidden');
    dom.inputGateAppsScriptUrl.focus();
    showToast('Paste your deployed script.google.com Web App URL first.', 'error');
    return;
  }

  const nonce = generateOAuthStateNonce();
  try {
    localStorage.setItem(STORAGE_KEYS.oauthState, JSON.stringify({ nonce, createdAt: Date.now() }));
  } catch {
    // Ignore storage errors
  }

  const popupUrl = buildAppsScriptBridgeUrl({
    appsScriptUrl: state.appsScriptUrl,
    returnTo: getCleanReturnToUrl(),
    state: nonce,
    popup: true
  });

  const width = 480;
  const height = 580;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));

  const popupWin = window.open(
    popupUrl,
    'driveNanoGasAuth',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );

  if (!popupWin) {
    // Popup blocked by browser — navigate cleanly in the current tab
    const sameTabUrl = buildAppsScriptBridgeUrl({
      appsScriptUrl: state.appsScriptUrl,
      returnTo: getCleanReturnToUrl(),
      state: nonce,
      popup: false
    });
    window.location.assign(sameTabUrl);
  } else {
    popupWin.focus();
    startAuthSessionPolling();
  }
}

async function hydrateSessionAndProfile(rawSession) {
  const [fetchedProfile, tokenScopeInfo] = await Promise.all([
    fetchDriveUserProfile({ accessToken: rawSession.accessToken }).catch(() => null),
    inspectTokenScopes({ accessToken: rawSession.accessToken })
  ]);

  // Only reject if Google explicitly reports the token is invalid/expired (HTTP 400/401)
  if (tokenScopeInfo?.isInvalid) {
    throw new Error('Stored Google session expired or revoked.');
  }

  const profile = fetchedProfile || {
    displayName: rawSession.userProfile?.displayName || '',
    emailAddress: tokenScopeInfo?.email || rawSession.userProfile?.emailAddress || '',
    photoLink: rawSession.userProfile?.photoLink || ''
  };

  const effectiveScope = tokenScopeInfo?.scope || rawSession.scope || '';
  const hasWriteAccess =
    tokenScopeInfo !== null && !tokenScopeInfo.isInvalid
      ? tokenScopeInfo.hasWriteAccess
      : Boolean(rawSession.hasWriteAccess);

  saveAuthSession({
    accessToken: rawSession.accessToken,
    expiresAt: rawSession.expiresAt,
    scope: effectiveScope,
    hasWriteAccess,
    userProfile: profile
  });
}

function setupCrossWindowAuthListeners() {
  if (typeof BroadcastChannel !== 'undefined') {
    authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    authChannel.addEventListener('message', async (event) => {
      if (event.data?.type === 'DRIVE_NANO_AUTH_SUCCESS') {
        if (event.data.session?.accessToken) {
          saveAuthSession(event.data.session);
        }
        await restoreStoredSessionIfValid({ announce: true });
      }
    });
  }

  window.addEventListener('storage', async (event) => {
    if (event.key === STORAGE_KEYS.sessionToken && event.newValue && !state.accessToken) {
      await restoreStoredSessionIfValid({ announce: true });
    }
  });

  window.addEventListener('focus', async () => {
    if (!state.accessToken && authPollTimer) {
      await restoreStoredSessionIfValid({ announce: true });
    }
  });
}

async function restoreStoredSessionIfValid({ announce = false } = {}) {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.sessionToken) || 'null');
  } catch {
    cached = null;
  }

  // Fallback to loopback server in-memory session relay (covers localhost vs 127.0.0.1 or partitioned popups)
  if (!cached?.accessToken || cached.expiresAt <= Date.now()) {
    try {
      const relayRes = await fetch('./api/auth-session', { cache: 'no-store' });
      if (relayRes.ok) {
        const relayData = await relayRes.json();
        if (relayData?.session?.accessToken && relayData.session.expiresAt > Date.now()) {
          cached = relayData.session;
        }
      }
    } catch {
      // Ignore if running without server.js
    }
  }

  if (!cached?.accessToken || cached.expiresAt <= Date.now()) {
    if (cached) clearAuthSession();
    return false;
  }

  try {
    const wasAlreadySignedIn = Boolean(state.accessToken);
    await hydrateSessionAndProfile(cached);
    stopAuthSessionPolling();
    state.isDemoMode = false;
    setGateError('');
    renderAuthAndLayout();
    if (announce && !wasAlreadySignedIn) {
      showToast(
        `Signed in${state.userProfile?.emailAddress ? ` as ${state.userProfile.emailAddress}` : ''}.`,
        'success'
      );
    }
    return true;
  } catch {
    clearAuthSession();
    return false;
  }
}

/**
 * Resolve authentication on app launch:
 * 1. Consume `#access_token=...` callback from the Apps Script Bridge (`?popup=1` relays & closes).
 * 2. Else restore active Google session from `localStorage` / `/api/auth-session` with zero clicks.
 * 3. Else show the official "Sign in with Google" gate card.
 */
async function initializeAuthFlowOnLaunch() {
  const searchParams = new URLSearchParams(window.location.search);
  const isPopupReturn = searchParams.get('popup') === '1';

  let storedState = null;
  try {
    storedState = JSON.parse(localStorage.getItem(STORAGE_KEYS.oauthState) || 'null');
  } catch {
    storedState = null;
  }

  const recentAuthAttempt =
    Boolean(storedState?.createdAt) && Date.now() - Number(storedState.createdAt) < 10 * 60 * 1000;

  const parsedCallback = parseOAuthHashFragment(
    window.location.hash,
    storedState?.nonce || null,
    { allowFirstAuthRecovery: recentAuthAttempt || isPopupReturn }
  );

  if (parsedCallback) {
    // Scrub `#access_token` and `?popup=1` from URL bar & browser history immediately
    window.history.replaceState(null, '', window.location.pathname);
    try {
      localStorage.removeItem(STORAGE_KEYS.oauthState);
    } catch {
      // Ignore
    }

    if (parsedCallback.ok) {
      const expiresAt = Date.now() + Math.max(60, parsedCallback.expiresIn - 60) * 1000;
      const initialProfile =
        parsedCallback.email || parsedCallback.displayName
          ? {
              emailAddress: parsedCallback.email || '',
              displayName: parsedCallback.displayName || '',
              photoLink: parsedCallback.photoLink || ''
            }
          : null;

      const sessionRecord = {
        accessToken: parsedCallback.accessToken,
        expiresAt,
        scope: parsedCallback.scope,
        hasWriteAccess: parsedCallback.hasWriteAccess,
        userProfile: initialProfile
      };

      // Save synchronously to localStorage & relay to local server BEFORE any async calls or window.close()
      saveAuthSession(sessionRecord);
      await fetch('./api/auth-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionRecord)
      }).catch(() => {});

      if (isPopupReturn) {
        if (authChannel) {
          authChannel.postMessage({ type: 'DRIVE_NANO_AUTH_SUCCESS', session: sessionRecord });
        }
        dom.authGateTitle.textContent = 'Signed in!';
        dom.authGateMessage.textContent = 'Returning to Drive Nano Categorizer…';
        setTimeout(() => {
          window.close();
        }, 350);
        return;
      }

      await hydrateSessionAndProfile(sessionRecord).catch(() => {});
      state.isDemoMode = false;
      setGateError('');
      renderAuthAndLayout();
      showToast(
        `Signed in${state.userProfile?.emailAddress ? ` as ${state.userProfile.emailAddress}` : ''}.`,
        'success'
      );
      return;
    }

    setGateError(
      `Google Sign-In did not complete (${parsedCallback.error}${
        parsedCallback.errorDescription ? `: ${parsedCallback.errorDescription}` : ''
      }).`
    );
    renderAuthAndLayout();
    return;
  }

  // Automatic existing-session restore on launch
  const restored = await restoreStoredSessionIfValid({ announce: false });
  if (restored) {
    return;
  }

  renderAuthAndLayout();
}

async function refreshAiStatus() {
  const diag = await checkAiAvailability();
  state.aiDiagnostics = diag;

  dom.aiStatusBadge.title = diag.message;
  if (diag.status === 'ready') {
    dom.aiStatusBadge.textContent = 'Gemini Nano Ready';
    dom.aiStatusBadge.className = 'badge badge-success';
  } else if (diag.status === 'downloadable') {
    dom.aiStatusBadge.textContent = 'Gemini Nano (Download on Scan)';
    dom.aiStatusBadge.className = 'badge badge-info';
  } else if (diag.status === 'downloading') {
    dom.aiStatusBadge.textContent = 'Gemini Nano Downloading…';
    dom.aiStatusBadge.className = 'badge badge-info';
  } else {
    dom.aiStatusBadge.textContent = state.allowHeuristic
      ? 'Chrome AI Off · Heuristic Ready'
      : 'Chrome AI Unavailable';
    dom.aiStatusBadge.className = 'badge badge-warn';
  }
}

function renderAuthAndLayout() {
  const isSignedIn = Boolean(state.accessToken);
  const showWorkspace = isSignedIn || state.isDemoMode;

  dom.authGatePanel.classList.toggle('hidden', showWorkspace);
  dom.workspaceArea.classList.toggle('hidden', !showWorkspace);
  dom.btnScanDrive.disabled = !isSignedIn || state.isScanning;

  if (isSignedIn) {
    dom.authStatusBadge.textContent = state.hasWriteAccess
      ? 'Signed In · Write Enabled'
      : 'Signed In · Read-Only';
    dom.authStatusBadge.className = state.hasWriteAccess
      ? 'badge badge-warn'
      : 'badge badge-success';

    dom.btnSignIn.textContent = 'Refresh Google Session';

    const email =
      state.userProfile?.emailAddress || state.userProfile?.displayName || 'Google Account';
    dom.userEmailText.textContent = email;
    if (state.userProfile?.photoLink) {
      dom.userAvatar.src = state.userProfile.photoLink;
      dom.userAvatar.classList.remove('hidden');
    } else {
      dom.userAvatar.classList.add('hidden');
    }
    dom.userProfileChip.classList.remove('hidden');
    return;
  }

  dom.userProfileChip.classList.add('hidden');

  if (state.isDemoMode) {
    dom.authStatusBadge.textContent = 'Demo Mode (Local Sample)';
    dom.authStatusBadge.className = 'badge badge-info';
    dom.btnSignIn.textContent = 'Sign in with Google';
    return;
  }

  dom.authStatusBadge.textContent = 'Sign-In Required';
  dom.authStatusBadge.className = 'badge badge-neutral';
}

function renderTaxonomyEditor() {
  dom.taxonomyList.innerHTML = '';
  for (const category of state.categories) {
    const chip = document.createElement('span');
    chip.className = 'tax-chip';
    chip.setAttribute('role', 'listitem');

    const label = document.createElement('span');
    label.textContent = category;
    chip.appendChild(label);

    if (category.toLowerCase() !== 'uncategorized') {
      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.title = `Remove ${category}`;
      btnRemove.setAttribute('aria-label', `Remove ${category}`);
      btnRemove.textContent = '×';
      btnRemove.addEventListener('click', () => {
        state.categories = ensureCategoriesList(
          state.categories.filter((c) => c !== category)
        );
        persistCategories();
        renderTaxonomyEditor();
        renderResultsView();
      });
      chip.appendChild(btnRemove);
    }

    dom.taxonomyList.appendChild(chip);
  }
}

function persistCategories() {
  try {
    localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(state.categories));
  } catch {
    // Ignore storage errors
  }
}

function updateProgress({ visible, text = '', current = 0, total = 0, percent = null }) {
  dom.progressPanel.classList.toggle('hidden', !visible);
  if (!visible) return;
  dom.progressText.textContent = text;
  dom.progressCount.textContent = total > 0 ? `${current} / ${total}` : '';
  const pct =
    percent !== null ? percent : total > 0 ? Math.round((current / total) * 100) : 0;
  dom.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function setScanningUiState(scanning) {
  state.isScanning = scanning;
  dom.btnScanDrive.disabled = scanning || !state.accessToken;
  dom.btnDemoScan.disabled = scanning;
  dom.btnSignIn.disabled = scanning;
  dom.selectBatchSize.disabled = scanning;
  dom.btnCancelScan.classList.toggle('hidden', !scanning);
}

function handleSignOut() {
  stopAuthSessionPolling();
  clearAuthSession();
  fetch('./api/auth-session', { method: 'DELETE' }).catch(() => {});
  state.isDemoMode = false;
  state.rows = [];
  state.selectedIds.clear();
  state.lastUndoBatch = null;
  dom.undoBanner.classList.add('hidden');
  renderAuthAndLayout();
  renderResultsView();
  showToast('Signed out of local Google Drive session.');
}

async function handleDriveScan() {
  if (!state.accessToken) {
    openAppsScriptSignIn();
    return;
  }

  const rawBatch = dom.selectBatchSize.value;
  const maxFiles = rawBatch === 'ALL' ? Infinity : Number(rawBatch) || 25;

  await runCategorizationPipeline({
    demo: false,
    fetchFiles: (signal) =>
      listRootLooseFiles({
        accessToken: state.accessToken,
        maxFiles,
        signal
      })
  });
}

async function handleDemoScan() {
  state.isDemoMode = true;
  renderAuthAndLayout();
  await runCategorizationPipeline({
    demo: true,
    fetchFiles: async () => SAMPLE_DRIVE_FILES.map((item) => ({ ...item }))
  });
}

async function runCategorizationPipeline({ demo, fetchFiles }) {
  if (state.isScanning) return;

  const abortController = new AbortController();
  state.scanAbortController = abortController;
  state.rows = [];
  state.selectedIds.clear();
  state.activeCategoryFilter = 'ALL';
  state.lastUndoBatch = null;
  dom.undoBanner.classList.add('hidden');

  setScanningUiState(true);
  renderResultsView();
  updateProgress({
    visible: true,
    text: demo ? 'Loading sample Drive root files…' : 'Listing loose files in Google Drive root…',
    current: 0,
    total: 0,
    percent: 5
  });

  const engine = new CategorizerEngine({
    categories: state.categories,
    allowHeuristicFallback: state.allowHeuristic,
    onDownloadProgress: (pct) => {
      updateProgress({
        visible: true,
        text: `Downloading on-device Gemini Nano model weights (${pct}%)…`,
        current: pct,
        total: 100,
        percent: pct
      });
    }
  });

  try {
    const files = await fetchFiles(abortController.signal);
    if (files.length === 0) {
      showToast('No loose files found in your Google Drive root folder!', 'success');
      return;
    }

    updateProgress({
      visible: true,
      text: 'Initializing local AI session…',
      current: 0,
      total: files.length,
      percent: 8
    });

    const engineInfo = await engine.init({ signal: abortController.signal });
    await refreshAiStatus();

    if (engineInfo.mode === 'heuristic' && state.aiDiagnostics?.status !== 'ready') {
      showToast('Running with local keyword/MIME heuristic (Chrome Gemini Nano inactive).');
    }

    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];

      updateProgress({
        visible: true,
        text: `Processing (${engineInfo.mode === 'gemini-nano' ? 'Gemini Nano' : 'Heuristic'}): ${file.name}`,
        current: i + 1,
        total: files.length
      });

      const extraction = await extractFileContent(file, {
        accessToken: demo ? '' : state.accessToken,
        signal: abortController.signal
      });

      const aiResult = await engine.categorizeFile(file, extraction, {
        signal: abortController.signal
      });

      const row = {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        mimeLabel: extraction.mimeLabel || getMimeLabel(file.mimeType, file.name),
        size: file.size ?? null,
        createdTime: file.createdTime || '',
        modifiedTime: file.modifiedTime || '',
        webViewLink: file.webViewLink || '',
        canMove: file.canMove !== false,
        extractionSource: extraction.extractionSource,
        category: aiResult.category,
        summary: aiResult.summary,
        suggestedFolder: aiResult.suggestedFolder,
        confidence: aiResult.confidence,
        engine: aiResult.engine,
        customTargetPath: '',
        movedToPath: null
      };

      state.rows.push(row);
      renderResultsView();
    }

    showToast(
      `Categorized ${state.rows.length} root file${state.rows.length === 1 ? '' : 's'} locally.`,
      'success'
    );
  } catch (err) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      showToast(`Scan stopped after ${state.rows.length} file(s).`);
    } else {
      showToast(err.message || 'Scan failed.', 'error');
    }
  } finally {
    engine.destroy();
    state.scanAbortController = null;
    setScanningUiState(false);
    updateProgress({ visible: false });
    renderResultsView();
  }
}

function getVisibleRows() {
  return filterAndSortResults(state.rows, {
    category: state.activeCategoryFilter,
    query: state.searchQuery,
    sortBy: state.sortBy,
    sortDir: state.sortDir
  });
}

function renderCategoryChips() {
  dom.categoryChips.innerHTML = '';
  if (state.rows.length === 0) return;

  const counts = new Map();
  for (const row of state.rows) {
    counts.set(row.category, (counts.get(row.category) || 0) + 1);
  }

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = `filter-chip ${state.activeCategoryFilter === 'ALL' ? 'active' : ''}`;
  allChip.textContent = `All (${state.rows.length})`;
  allChip.addEventListener('click', () => {
    state.activeCategoryFilter = 'ALL';
    renderResultsView();
  });
  dom.categoryChips.appendChild(allChip);

  for (const [cat, count] of counts.entries()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${state.activeCategoryFilter === cat ? 'active' : ''}`;
    chip.textContent = `${cat} (${count})`;
    chip.addEventListener('click', () => {
      state.activeCategoryFilter = state.activeCategoryFilter === cat ? 'ALL' : cat;
      renderResultsView();
    });
    dom.categoryChips.appendChild(chip);
  }
}

function renderResultsView() {
  renderCategoryChips();
  const visibleRows = getVisibleRows();
  const hasAnyRows = state.rows.length > 0;

  dom.btnCopyMarkdown.disabled = !hasAnyRows;
  dom.btnDownloadMarkdown.disabled = !hasAnyRows;
  dom.btnDownloadCsv.disabled = !hasAnyRows;

  for (const id of [...state.selectedIds]) {
    const row = state.rows.find((r) => r.id === id);
    if (!row || !row.canMove || row.movedToPath) {
      state.selectedIds.delete(id);
    }
  }

  dom.selectedCount.textContent = String(state.selectedIds.size);
  dom.btnOpenMoveModal.disabled = state.selectedIds.size === 0 || state.isScanning;

  if (!hasAnyRows) {
    dom.resultsSummaryText.textContent = 'No files scanned yet.';
    dom.chkSelectAll.checked = false;
    dom.chkSelectAll.disabled = true;
    dom.resultsTbody.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="7">
          <div class="empty-state">
            <h3>Ready to categorize loose Drive root files locally</h3>
            <p>
              Click <strong>Scan Drive Root Folder</strong> above to summarize and categorize your root files strictly on-device, or click
              <strong>Try Sample Drive Data (Demo)</strong>.
            </p>
          </div>
        </td>
      </tr>`;
    return;
  }

  dom.resultsSummaryText.textContent = `Showing ${visibleRows.length} of ${state.rows.length} categorized file(s).`;

  const movableVisible = visibleRows.filter((r) => r.canMove && !r.movedToPath);
  dom.chkSelectAll.disabled = movableVisible.length === 0;
  dom.chkSelectAll.checked =
    movableVisible.length > 0 && movableVisible.every((r) => state.selectedIds.has(r.id));

  dom.resultsTbody.innerHTML = '';

  if (visibleRows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted-note';
    td.style.textAlign = 'center';
    td.style.padding = '28px';
    td.textContent = 'No files match the current category or search filter.';
    tr.appendChild(td);
    dom.resultsTbody.appendChild(tr);
    return;
  }

  for (const row of visibleRows) {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = state.selectedIds.has(row.id);
    chk.disabled = !row.canMove || Boolean(row.movedToPath);
    chk.title = !row.canMove
      ? 'Cannot move this shared file (insufficient Drive move permissions)'
      : row.movedToPath
      ? `Already moved to ${row.movedToPath}`
      : `Select ${row.name}`;
    chk.addEventListener('change', () => {
      if (chk.checked) {
        state.selectedIds.add(row.id);
      } else {
        state.selectedIds.delete(row.id);
      }
      renderSelectionStateOnly(visibleRows);
    });
    tdCheck.appendChild(chk);
    tr.appendChild(tdCheck);

    const tdFile = document.createElement('td');
    tdFile.className = 'col-file';
    if (row.webViewLink) {
      const link = document.createElement('a');
      link.href = row.webViewLink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'file-link';
      link.textContent = row.name;
      tdFile.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.textContent = row.name;
      tdFile.appendChild(span);
    }

    const subMeta = document.createElement('div');
    subMeta.className = 'file-submeta';

    const mimePill = document.createElement('span');
    mimePill.className = 'mini-pill';
    mimePill.textContent = row.mimeLabel;
    subMeta.appendChild(mimePill);

    if (!row.canMove) {
      const lockPill = document.createElement('span');
      lockPill.className = 'mini-pill mini-pill-locked';
      lockPill.textContent = 'Read-Only Shared';
      subMeta.appendChild(lockPill);
    }

    if (row.movedToPath) {
      const movedPill = document.createElement('span');
      movedPill.className = 'mini-pill mini-pill-moved';
      movedPill.textContent = `Moved → ${row.movedToPath}`;
      subMeta.appendChild(movedPill);
    }

    tdFile.appendChild(subMeta);
    tr.appendChild(tdFile);

    const tdCategory = document.createElement('td');
    tdCategory.className = 'col-category';
    const catSelect = document.createElement('select');
    catSelect.className = 'inline-select';
    catSelect.setAttribute('aria-label', `Category for ${row.name}`);

    const optionsSet = new Set([...state.categories, row.category]);
    for (const catOption of optionsSet) {
      const opt = document.createElement('option');
      opt.value = catOption;
      opt.textContent = catOption;
      if (catOption === row.category) opt.selected = true;
      catSelect.appendChild(opt);
    }
    catSelect.addEventListener('change', () => {
      row.category = catSelect.value;
      renderCategoryChips();
    });
    tdCategory.appendChild(catSelect);
    tr.appendChild(tdCategory);

    const tdSummary = document.createElement('td');
    tdSummary.className = 'col-summary';
    const pSum = document.createElement('p');
    pSum.className = 'summary-cell-text';
    pSum.textContent = row.summary;
    tdSummary.appendChild(pSum);
    tr.appendChild(tdSummary);

    const tdFolder = document.createElement('td');
    tdFolder.className = 'col-folder';
    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'inline-folder-input';
    folderInput.value = row.suggestedFolder || '';
    folderInput.placeholder = 'General';
    folderInput.setAttribute('aria-label', `Suggested subfolder for ${row.name}`);
    folderInput.addEventListener('change', () => {
      row.suggestedFolder = sanitizeFolderSegment(folderInput.value, 'General');
      folderInput.value = row.suggestedFolder;
    });
    tdFolder.appendChild(folderInput);
    tr.appendChild(tdFolder);

    const tdSource = document.createElement('td');
    tdSource.className = 'col-source';
    const sourceWrap = document.createElement('div');
    sourceWrap.className = 'file-submeta';

    const enginePill = document.createElement('span');
    enginePill.className = `mini-pill ${
      row.engine === 'gemini-nano' ? 'mini-pill-nano' : 'mini-pill-heuristic'
    }`;
    const confPct = Math.round((row.confidence ?? 0.75) * 100);
    enginePill.textContent = `${row.engine === 'gemini-nano' ? 'Nano' : 'Heuristic'} · ${confPct}%`;
    sourceWrap.appendChild(enginePill);

    const srcPill = document.createElement('span');
    srcPill.className = 'mini-pill';
    srcPill.textContent =
      row.extractionSource === 'metadata' ? 'Metadata Only' : 'Body Excerpt';
    sourceWrap.appendChild(srcPill);

    tdSource.appendChild(sourceWrap);
    tr.appendChild(tdSource);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date mono-text';
    tdDate.textContent = formatShortDate(row.modifiedTime || row.createdTime);
    tr.appendChild(tdDate);

    dom.resultsTbody.appendChild(tr);
  }
}

function renderSelectionStateOnly(visibleRows) {
  dom.selectedCount.textContent = String(state.selectedIds.size);
  dom.btnOpenMoveModal.disabled = state.selectedIds.size === 0 || state.isScanning;
  const movableVisible = visibleRows.filter((r) => r.canMove && !r.movedToPath);
  dom.chkSelectAll.checked =
    movableVisible.length > 0 && movableVisible.every((r) => state.selectedIds.has(r.id));
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSelectedMovableRows() {
  return state.rows.filter(
    (r) => state.selectedIds.has(r.id) && r.canMove && !r.movedToPath
  );
}

function openMoveModal() {
  const selectedRows = getSelectedMovableRows();
  if (selectedRows.length === 0) return;

  dom.chkIncludeSubfolder.checked = state.includeSubfolderInMove;
  dom.btnConfirmMove.disabled = false;

  if (state.isDemoMode && !state.accessToken) {
    dom.moveScopeNotice.textContent =
      'Demo Mode Dry-Run: Confirming below simulates moving selected files into folders and lets you test the Undo workflow without touching Google Drive.';
  } else if (state.hasWriteAccess) {
    dom.moveScopeNotice.textContent =
      'Write scope (drive) is enabled on your Apps Script bridge. Confirming will find-or-create destination folders in your Drive root and move the selected files.';
  } else {
    dom.moveScopeNotice.textContent =
      'Read-Only Bridge Active: Your Apps Script bridge is currently deployed with strict Read-Only (drive.readonly) scope. To enable live folder moves, change drive.readonly to drive in apps-script/appsscript.json, redeploy, and click Refresh Google Session.';
    dom.btnConfirmMove.disabled = true;
  }

  renderMovePreviewRows();
  dom.moveModal.classList.remove('hidden');
}

function renderMovePreviewRows() {
  const selectedRows = getSelectedMovableRows();
  dom.movePreviewTbody.innerHTML = '';

  for (const row of selectedRows) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = row.name;
    tr.appendChild(tdName);

    const tdTarget = document.createElement('td');
    const resolved = resolveTargetFolder(
      { ...row, customTargetPath: '' },
      { includeSubfolder: state.includeSubfolderInMove }
    );

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-folder-input mono-text';
    input.value = row.customTargetPath || resolved.segments.join('/');
    input.setAttribute('aria-label', `Destination path override for ${row.name}`);
    input.addEventListener('input', () => {
      const val = input.value.trim().replace(/^\/+|\/+$/g, '');
      row.customTargetPath = val === resolved.segments.join('/') ? '' : val;
    });
    tdTarget.appendChild(input);
    tr.appendChild(tdTarget);

    dom.movePreviewTbody.appendChild(tr);
  }
}

function closeMoveModal() {
  dom.moveModal.classList.add('hidden');
}

async function handleConfirmMove() {
  const selectedRows = getSelectedMovableRows();
  if (selectedRows.length === 0) {
    closeMoveModal();
    return;
  }

  const assignments = selectedRows.map((row) => {
    const resolved = resolveTargetFolder(row, {
      includeSubfolder: state.includeSubfolderInMove
    });
    return {
      fileId: row.id,
      fileName: row.name,
      segments: resolved.segments,
      displayPath: resolved.displayPath
    };
  });

  dom.btnConfirmMove.disabled = true;

  try {
    // Demo Mode simulated move + Undo support
    if (state.isDemoMode && !state.accessToken) {
      const demoUndo = [];
      for (const a of assignments) {
        const row = state.rows.find((r) => r.id === a.fileId);
        if (row) {
          row.movedToPath = a.displayPath;
          state.selectedIds.delete(row.id);
          demoUndo.push({
            fileId: a.fileId,
            fileName: a.fileName,
            fromParentId: 'root',
            toFolderId: 'demo-folder',
            displayPath: a.displayPath,
            isDemo: true
          });
        }
      }
      state.lastUndoBatch = demoUndo;
      closeMoveModal();
      renderUndoBanner();
      renderResultsView();
      showToast(`Simulated moving ${demoUndo.length} sample file(s).`, 'success');
      return;
    }

    closeMoveModal();
    updateProgress({
      visible: true,
      text: 'Organizing selected files into Google Drive folders…',
      current: 0,
      total: assignments.length
    });

    const { moved, failed } = await moveFilesToTargets(assignments, {
      accessToken: state.accessToken,
      onProgress: ({ current, total, fileName }) => {
        updateProgress({
          visible: true,
          text: `Moving ${fileName}…`,
          current,
          total
        });
      }
    });

    for (const rec of moved) {
      const row = state.rows.find((r) => r.id === rec.fileId);
      if (row) {
        row.movedToPath = rec.displayPath;
        state.selectedIds.delete(row.id);
      }
    }

    if (moved.length > 0) {
      state.lastUndoBatch = moved;
      renderUndoBanner();
      showToast(`Moved ${moved.length} file(s) into categorized folders.`, 'success');
    }
    if (failed.length > 0) {
      showToast(`${failed.length} file(s) could not be moved: ${failed[0].error}`, 'error');
    }
  } catch (err) {
    showToast(err.message || 'Folder move cancelled or failed.', 'error');
  } finally {
    dom.btnConfirmMove.disabled = false;
    updateProgress({ visible: false });
    renderResultsView();
  }
}

function renderUndoBanner() {
  if (!state.lastUndoBatch || state.lastUndoBatch.length === 0) {
    dom.undoBanner.classList.add('hidden');
    return;
  }
  const isDemo = state.lastUndoBatch[0]?.isDemo;
  dom.undoMessage.textContent = `${
    isDemo ? '[Demo Dry-Run] ' : ''
  }Moved ${state.lastUndoBatch.length} file(s) out of Drive root.`;
  dom.undoBanner.classList.remove('hidden');
}

async function handleUndoLastMove() {
  const batch = state.lastUndoBatch;
  if (!batch || batch.length === 0) return;

  dom.btnUndoMove.disabled = true;
  try {
    if (batch[0]?.isDemo) {
      for (const rec of batch) {
        const row = state.rows.find((r) => r.id === rec.fileId);
        if (row) row.movedToPath = null;
      }
      state.lastUndoBatch = null;
      renderUndoBanner();
      renderResultsView();
      showToast('Restored simulated sample files back to Drive root.', 'success');
      return;
    }

    const { restored, failed } = await undoMoveBatch(batch, {
      accessToken: state.accessToken
    });

    for (const rec of restored) {
      const row = state.rows.find((r) => r.id === rec.fileId);
      if (row) row.movedToPath = null;
    }

    state.lastUndoBatch = failed.length > 0 ? failed : null;
    renderUndoBanner();
    renderResultsView();

    if (restored.length > 0) {
      showToast(`Restored ${restored.length} file(s) back to Google Drive root.`, 'success');
    }
    if (failed.length > 0) {
      showToast(`Failed to restore ${failed.length} file(s).`, 'error');
    }
  } finally {
    dom.btnUndoMove.disabled = false;
  }
}

function persistAppsScriptUrl(rawValue) {
  const val = String(rawValue || '').trim();
  state.appsScriptUrl = val;
  state.appsScriptSource = val ? 'Saved in browser Settings' : '';
  dom.inputAppsScriptUrl.value = val;
  dom.inputGateAppsScriptUrl.value = val;

  try {
    if (val) {
      localStorage.setItem(STORAGE_KEYS.appsScriptUrl, val);
    } else {
      localStorage.removeItem(STORAGE_KEYS.appsScriptUrl);
    }
  } catch {
    // Ignore storage errors
  }
  renderAppsScriptUrlHint();
}

function bindEvents() {
  dom.btnToggleGuide.addEventListener('click', () => {
    dom.aiFlagsGuide.classList.toggle('hidden');
  });
  dom.btnCloseGuide.addEventListener('click', () => {
    dom.aiFlagsGuide.classList.add('hidden');
  });

  dom.btnToggleSettings.addEventListener('click', () => {
    const isHidden = dom.settingsDrawer.classList.toggle('hidden');
    dom.btnToggleSettings.setAttribute('aria-expanded', String(!isHidden));
  });

  dom.btnSaveAppsScriptUrl.addEventListener('click', () => {
    persistAppsScriptUrl(dom.inputAppsScriptUrl.value);
    if (state.appsScriptUrl && !isValidAppsScriptWebAppUrl(state.appsScriptUrl)) {
      showToast('URL must match https://script.google.com/macros/s/.../exec (or /dev).', 'error');
      return;
    }
    showToast(state.appsScriptUrl ? 'Saved Apps Script Bridge URL.' : 'Cleared Bridge URL.', 'success');
  });

  dom.btnSaveGateAppsScriptUrl.addEventListener('click', () => {
    persistAppsScriptUrl(dom.inputGateAppsScriptUrl.value);
    if (!isValidAppsScriptWebAppUrl(state.appsScriptUrl)) {
      showToast('Enter a valid https://script.google.com/macros/s/.../exec (or /dev) URL.', 'error');
      return;
    }
    showToast('Saved Bridge URL — opening Google Sign-In…', 'success');
    openAppsScriptSignIn();
  });

  dom.chkAllowHeuristic.addEventListener('change', () => {
    state.allowHeuristic = dom.chkAllowHeuristic.checked;
    try {
      localStorage.setItem(STORAGE_KEYS.allowHeuristic, String(state.allowHeuristic));
    } catch {
      // Ignore storage errors
    }
    refreshAiStatus();
  });

  const addCategoryHandler = () => {
    const raw = dom.inputNewCategory.value.trim();
    if (!raw) return;
    state.categories = ensureCategoriesList([...state.categories, raw]);
    dom.inputNewCategory.value = '';
    persistCategories();
    renderTaxonomyEditor();
    renderResultsView();
  };

  dom.btnAddCategory.addEventListener('click', addCategoryHandler);
  dom.inputNewCategory.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCategoryHandler();
    }
  });

  dom.btnResetCategories.addEventListener('click', () => {
    state.categories = [...DEFAULT_CATEGORIES];
    persistCategories();
    renderTaxonomyEditor();
    renderResultsView();
    showToast('Reset category taxonomy to defaults.');
  });

  dom.btnGoogleGateSignIn.addEventListener('click', openAppsScriptSignIn);
  dom.btnGateDemo.addEventListener('click', handleDemoScan);
  dom.btnSignIn.addEventListener('click', openAppsScriptSignIn);
  dom.btnSignOut.addEventListener('click', handleSignOut);

  dom.btnScanDrive.addEventListener('click', handleDriveScan);
  dom.btnDemoScan.addEventListener('click', handleDemoScan);
  dom.btnCancelScan.addEventListener('click', () => {
    state.scanAbortController?.abort();
  });

  dom.inputSearch.addEventListener('input', () => {
    state.searchQuery = dom.inputSearch.value;
    renderResultsView();
  });

  dom.selectSort.addEventListener('change', () => {
    const [sortBy, sortDir] = dom.selectSort.value.split(':');
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    renderResultsView();
  });

  dom.chkSelectAll.addEventListener('change', () => {
    const visibleMovable = getVisibleRows().filter((r) => r.canMove && !r.movedToPath);
    if (dom.chkSelectAll.checked) {
      for (const r of visibleMovable) state.selectedIds.add(r.id);
    } else {
      for (const r of visibleMovable) state.selectedIds.delete(r.id);
    }
    renderResultsView();
  });

  dom.btnCopyMarkdown.addEventListener('click', async () => {
    const md = toMarkdownTable(getVisibleRows(), {
      includeSubfolder: state.includeSubfolderInMove
    });
    try {
      await navigator.clipboard.writeText(md);
      showToast('Copied Markdown table to clipboard.', 'success');
    } catch {
      showToast('Clipboard permission denied; use Download .md instead.', 'error');
    }
  });

  dom.btnDownloadMarkdown.addEventListener('click', () => {
    const dateSlug = new Date().toISOString().slice(0, 10);
    const md = `# Google Drive Root Categorization Report (${dateSlug})\n\n${toMarkdownTable(
      getVisibleRows(),
      { includeSubfolder: state.includeSubfolderInMove }
    )}\n`;
    downloadBlob(md, `drive-categorized-${dateSlug}.md`, 'text/markdown;charset=utf-8');
  });

  dom.btnDownloadCsv.addEventListener('click', () => {
    const dateSlug = new Date().toISOString().slice(0, 10);
    const csv = toCsv(getVisibleRows(), {
      includeSubfolder: state.includeSubfolderInMove
    });
    downloadBlob(csv, `drive-categorized-${dateSlug}.csv`, 'text/csv;charset=utf-8');
  });

  dom.btnOpenMoveModal.addEventListener('click', openMoveModal);
  dom.btnCloseMoveModal.addEventListener('click', closeMoveModal);
  dom.btnCancelMove.addEventListener('click', closeMoveModal);
  dom.moveModal.addEventListener('click', (e) => {
    if (e.target === dom.moveModal) closeMoveModal();
  });

  dom.chkIncludeSubfolder.addEventListener('change', () => {
    state.includeSubfolderInMove = dom.chkIncludeSubfolder.checked;
    renderMovePreviewRows();
  });

  dom.btnConfirmMove.addEventListener('click', handleConfirmMove);
  dom.btnUndoMove.addEventListener('click', handleUndoLastMove);
}

async function bootstrap() {
  cacheDom();
  setupCrossWindowAuthListeners();
  bindEvents();
  await loadInitialConfig();
  await refreshAiStatus();
  await initializeAuthFlowOnLaunch();
}

if (typeof document !== 'undefined') {
  bootstrap();
}
