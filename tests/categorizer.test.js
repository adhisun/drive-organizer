import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  escapeCsvCell,
  filterAndSortResults,
  getMimeLabel,
  resolveTargetFolder,
  toCsv,
  toMarkdownTable
} from '../report-utils.js';

import {
  CategorizerEngine,
  DEFAULT_CATEGORIES,
  checkAiAvailability,
  heuristicCategorize,
  parseModelResponse,
  truncateContent
} from '../gemini-nano.js';

import {
  DRIVE_READONLY_SCOPE,
  DRIVE_WRITE_SCOPE,
  SAMPLE_DRIVE_FILES,
  buildAppsScriptBridgeUrl,
  escapeDriveQueryValue,
  extractFileContent,
  fetchDriveUserProfile,
  generateOAuthStateNonce,
  getExtractionStrategy,
  inspectTokenScopes,
  isValidAppsScriptWebAppUrl,
  listRootLooseFiles,
  moveFilesToTargets,
  parseOAuthHashFragment,
  undoMoveBatch
} from '../drive-api.js';

import { createAppServer, parseEnvContent } from '../server.js';

test('truncateContent enforces 1,000-word and 8,000-char context budget', () => {
  const words = Array.from({ length: 1350 }, (_, i) => `word${i}`).join(' ');
  const { snippet, truncated, wordCount } = truncateContent(words);

  assert.equal(truncated, true);
  assert.equal(wordCount, 1000);
  assert.equal(snippet.split(/\s+/).length, 1000);
  assert.ok(snippet.length <= 8000);

  const hugeSingleToken = 'a'.repeat(9500);
  const charCapped = truncateContent(hugeSingleToken);
  assert.equal(charCapped.truncated, true);
  assert.equal(charCapped.snippet.length, 8000);
});

test('CategorizerEngine supports Chrome 138+ LanguageModel API with per-file session cloning & cleanup', async () => {
  let clonedCount = 0;
  let destroyedClones = 0;
  let baseDestroyed = 0;
  const receivedPrompts = [];

  const mockGlobal = {
    LanguageModel: {
      async availability() {
        return 'available';
      },
      async params() {
        return { defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 };
      },
      async create(opts) {
        assert.equal(opts.temperature, 0.2);
        assert.equal(opts.topK, 3);
        assert.ok(Array.isArray(opts.initialPrompts));
        return {
          async clone() {
            clonedCount += 1;
            return {
              async prompt(text, options) {
                receivedPrompts.push({ text, hasSchema: Boolean(options?.responseConstraint) });
                return JSON.stringify({
                  category: 'Finance & Legal',
                  summary: 'Quarterly SaaS budget and procurement forecast.',
                  suggestedFolder: 'Q1 Budgets',
                  confidence: 0.93
                });
              },
              destroy() {
                destroyedClones += 1;
              }
            };
          },
          destroy() {
            baseDestroyed += 1;
          }
        };
      }
    }
  };

  const diag = await checkAiAvailability(mockGlobal);
  assert.equal(diag.status, 'ready');
  assert.equal(diag.flavor, 'LanguageModel');

  const engine = new CategorizerEngine({
    categories: DEFAULT_CATEGORIES,
    allowHeuristicFallback: false,
    globalScope: mockGlobal
  });

  const initInfo = await engine.init();
  assert.equal(initInfo.mode, 'gemini-nano');

  const res1 = await engine.categorizeFile(
    { name: 'Budget.xlsx', mimeType: 'text/csv' },
    { text: 'Vendor,Cost\nFigma,48000', mimeLabel: 'CSV' }
  );
  const res2 = await engine.categorizeFile(
    { name: 'NDA.pdf', mimeType: 'application/pdf' },
    { text: '', mimeLabel: 'PDF' }
  );

  engine.destroy();

  assert.equal(res1.category, 'Finance & Legal');
  assert.equal(res1.suggestedFolder, 'Q1 Budgets');
  assert.equal(res1.engine, 'gemini-nano');
  assert.equal(res2.engine, 'gemini-nano');
  assert.equal(clonedCount, 2);
  assert.equal(destroyedClones, 2);
  assert.equal(baseDestroyed, 1);
  assert.equal(receivedPrompts.length, 2);
  assert.equal(receivedPrompts[0].hasSchema, true);
});

test('CategorizerEngine supports legacy window.ai.languageModel and recovers fenced JSON', async () => {
  let createCalls = 0;
  let promptCalls = 0;

  const mockLegacyGlobal = {
    ai: {
      languageModel: {
        async capabilities() {
          return { available: 'after-download', defaultTopK: 3 };
        },
        async create(opts) {
          createCalls += 1;
          if (opts.temperature !== undefined) {
            throw new TypeError('Sampling parameters restricted on web origin');
          }
          return {
            async prompt(_text, options) {
              promptCalls += 1;
              if (options?.responseConstraint) {
                throw new Error('responseConstraint unsupported in legacy build');
              }
              return '```json\n{"category": "engineering & tech", "summary": "API gateway design doc.", "suggestedFolder": "Architecture/Specs", "confidence": 1.4}\n```';
            },
            destroy() {}
          };
        }
      }
    }
  };

  const diag = await checkAiAvailability(mockLegacyGlobal);
  assert.equal(diag.status, 'downloadable');
  assert.equal(diag.flavor, 'window.ai.languageModel');

  const engine = new CategorizerEngine({
    categories: DEFAULT_CATEGORIES,
    allowHeuristicFallback: false,
    globalScope: mockLegacyGlobal
  });

  await engine.init();
  const out = await engine.categorizeFile(
    { name: 'gateway.md', mimeType: 'text/markdown' },
    { text: '# API Gateway', mimeLabel: 'Markdown' }
  );

  assert.equal(createCalls, 2); // Retried without temperature/topK
  assert.equal(promptCalls, 2); // Retried without responseConstraint
  assert.equal(out.category, 'Engineering & Tech');
  assert.equal(out.suggestedFolder, 'Architecture - Specs'); // Sanitized slash
  assert.equal(out.confidence, 1);
});

test('parseModelResponse maps unknown categories safely to Uncategorized', () => {
  const parsed = parseModelResponse(
    JSON.stringify({
      category: 'Invented Random Bucket',
      summary: 'Some summary.',
      suggestedFolder: '../bad/path',
      confidence: 0.42
    }),
    DEFAULT_CATEGORIES
  );

  assert.equal(parsed.category, 'Uncategorized');
  assert.equal(parsed.suggestedFolder, '.. - bad - path');
  assert.equal(parsed.confidence, 0.42);
});

test('heuristicCategorize classifies diverse sample files accurately without Chrome AI', () => {
  const results = SAMPLE_DRIVE_FILES.map((file) =>
    heuristicCategorize(file, {
      text: file.demoSnippet,
      mimeLabel: getMimeLabel(file.mimeType, file.name)
    })
  );

  assert.equal(results[0].category, 'Engineering & Tech'); // RFC-042
  assert.equal(results[1].category, 'Finance & Legal'); // Budget
  assert.equal(results[2].category, 'Finance & Legal'); // Mutual NDA PDF (from metadata!)
  assert.equal(results[3].category, 'Product & Design'); // PRD
  assert.equal(results[4].category, 'Meeting Notes'); // Sync & Retro
  assert.equal(results[5].category, 'Marketing & Sales'); // GTM Deck
  assert.equal(results[6].category, 'HR & People'); // Onboarding
  assert.equal(results[7].category, 'Operations & Admin'); // Inventory Audit
});

test('drive-api routes Workspace exports, partial Range text fetches, and metadata-only binaries', async () => {
  const calls = [];
  const mockFetch = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    return {
      ok: true,
      async text() {
        return 'Sample exported content';
      }
    };
  };

  // 1. Google Doc -> files.export
  const docRes = await extractFileContent(
    { id: 'doc1', name: 'Spec', mimeType: 'application/vnd.google-apps.document' },
    { accessToken: 'tok', fetchImpl: mockFetch }
  );
  assert.equal(docRes.extractionSource, 'workspace-export');
  assert.ok(calls[0].url.includes('/files/doc1/export?mimeType=text%2Fplain'));

  // 2. CSV -> alt=media with Range header
  const csvRes = await extractFileContent(
    { id: 'csv1', name: 'data.csv', mimeType: 'text/csv' },
    { accessToken: 'tok', fetchImpl: mockFetch }
  );
  assert.equal(csvRes.extractionSource, 'partial-text');
  assert.equal(calls[1].headers.Range, 'bytes=0-65535');

  // 3. PDF -> zero network calls, metadata-only
  const beforeCalls = calls.length;
  const pdfStrategy = getExtractionStrategy({ name: 'report.pdf', mimeType: 'application/pdf' });
  assert.equal(pdfStrategy.mode, 'metadata');

  const pdfRes = await extractFileContent(
    { id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' },
    { accessToken: 'tok', fetchImpl: mockFetch }
  );
  assert.equal(pdfRes.extractionSource, 'metadata');
  assert.equal(calls.length, beforeCalls);
});

test('listRootLooseFiles paginates and maps capabilities.canMoveItemWithinDrive', async () => {
  let pageCount = 0;
  const mockFetch = async (url) => {
    pageCount += 1;
    if (pageCount === 1) {
      assert.ok(!url.includes('pageToken='));
      return {
        ok: true,
        async json() {
          return {
            nextPageToken: 'next-2',
            files: [
              { id: 'f1', name: 'One.txt', mimeType: 'text/plain', capabilities: { canMoveItemWithinDrive: true } },
              { id: 'f2', name: 'Shared.pdf', mimeType: 'application/pdf', capabilities: { canMoveItemWithinDrive: false } }
            ]
          };
        }
      };
    }
    assert.ok(url.includes('pageToken=next-2'));
    return {
      ok: true,
      async json() {
        return {
          files: [{ id: 'f3', name: 'Three.md', mimeType: 'text/markdown' }]
        };
      }
    };
  };

  const files = await listRootLooseFiles({
    accessToken: 'tok',
    maxFiles: 3,
    fetchImpl: mockFetch
  });

  assert.equal(files.length, 3);
  assert.equal(files[0].canMove, true);
  assert.equal(files[1].canMove, false);
  assert.equal(files[2].canMove, true);
});

test('moveFilesToTargets reuses cached folders, escapes queries, and supports undoMoveBatch', async () => {
  assert.equal(escapeDriveQueryValue("Legal's \\ Archive"), "Legal\\'s \\\\ Archive");

  const apiLog = [];
  let createdCounter = 0;

  const mockFetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    apiLog.push({ method, url, body: options.body ? JSON.parse(options.body) : null });

    if (method === 'GET' && url.includes('/files?')) {
      // Simulate folder does not exist yet
      return { ok: true, async json() { return { files: [] }; } };
    }
    if (method === 'POST') {
      createdCounter += 1;
      return { ok: true, async json() { return { id: `folder-${createdCounter}` }; } };
    }
    if (method === 'PATCH') {
      return { ok: true, async json() { return { id: 'updated' }; } };
    }
    throw new Error(`Unexpected call: ${method} ${url}`);
  };

  // Move two files into the same '/Finance & Legal/' folder -> should only POST folder creation ONCE
  const { moved, failed } = await moveFilesToTargets(
    [
      { fileId: 'file-a', fileName: 'A.csv', segments: ['Finance & Legal'], displayPath: '/Finance & Legal/' },
      { fileId: 'file-b', fileName: 'B.pdf', segments: ['Finance & Legal'], displayPath: '/Finance & Legal/' }
    ],
    { accessToken: 'write-tok', fetchImpl: mockFetch }
  );

  assert.equal(failed.length, 0);
  assert.equal(moved.length, 2);
  assert.equal(createdCounter, 1); // Cached on second file!
  assert.equal(moved[0].toFolderId, 'folder-1');

  const patchCalls = apiLog.filter((entry) => entry.method === 'PATCH');
  assert.equal(patchCalls.length, 2);
  assert.ok(patchCalls[0].url.includes('addParents=folder-1'));
  assert.ok(patchCalls[0].url.includes('removeParents=root'));

  // Now Undo the batch -> restores addParents=root & removeParents=folder-1
  const undoResult = await undoMoveBatch(moved, {
    accessToken: 'write-tok',
    fetchImpl: mockFetch
  });
  assert.equal(undoResult.restored.length, 2);
  const lastPatch = apiLog[apiLog.length - 1];
  assert.ok(lastPatch.url.includes('addParents=root'));
  assert.ok(lastPatch.url.includes('removeParents=folder-1'));
});

test('report-utils resolves folder paths, neutralizes CSV formula injection, and formats Markdown', () => {
  const sampleRow = {
    id: '123',
    name: '=cmd|\' /C calc\'!A0 [Draft].csv',
    mimeType: 'text/csv',
    category: 'Finance & Legal',
    suggestedFolder: 'Q1 Audits',
    summary: '+SUM(A1:A5) summary with | pipe, "quotes", and\nnewline',
    confidence: 0.88,
    extractionSource: 'partial-text',
    engine: 'gemini-nano',
    modifiedTime: '2026-11-10T10:00:00Z',
    webViewLink: 'https://drive.google.com/file/d/123/view'
  };

  // Top-level vs nested vs custom override
  assert.deepEqual(resolveTargetFolder(sampleRow, { includeSubfolder: false }), {
    segments: ['Finance & Legal'],
    displayPath: '/Finance & Legal/'
  });
  assert.deepEqual(resolveTargetFolder(sampleRow, { includeSubfolder: true }), {
    segments: ['Finance & Legal', 'Q1 Audits'],
    displayPath: '/Finance & Legal/Q1 Audits/'
  });
  assert.deepEqual(
    resolveTargetFolder(
      { ...sampleRow, customTargetPath: '/Legal Archive/2026 Signed/' },
      { includeSubfolder: false }
    ),
    {
      segments: ['Legal Archive', '2026 Signed'],
      displayPath: '/Legal Archive/2026 Signed/'
    }
  );

  // CSV formula-injection guard & negative number preservation
  assert.equal(escapeCsvCell('=HYPERLINK("evil")'), `"'=HYPERLINK(""evil"")"`);
  assert.equal(escapeCsvCell('=SUM(A1,B1)'), `"'=SUM(A1,B1)"`);
  assert.equal(escapeCsvCell('-12.5'), '-12.5');

  const csv = toCsv([sampleRow], { includeSubfolder: true });
  assert.ok(csv.includes(`,'=cmd|' /C calc'!A0 [Draft].csv,`));
  assert.ok(!csv.includes(`'/Finance & Legal/Q1 Audits/`)); // Normal slash path not prefixed
  assert.ok(csv.includes('/Finance & Legal/Q1 Audits/'));
  assert.ok(csv.includes(`'+SUM(A1:A5)`));

  // Markdown table escaping
  const md = toMarkdownTable([sampleRow], { includeSubfolder: false });
  assert.ok(md.includes('\\[Draft\\]'));
  assert.ok(md.includes('pipe, "quotes", and newline'));
  assert.ok(md.includes('\\| pipe'));

  // Filtering and sorting
  const sorted = filterAndSortResults(
    [
      { name: 'Zeta', category: 'HR & People', confidence: 0.6, modifiedTime: '2026-11-01T00:00:00Z' },
      { name: 'Alpha', category: 'HR & People', confidence: 0.9, modifiedTime: '2026-11-05T00:00:00Z' },
      { name: 'Beta', category: 'Meeting Notes', confidence: 0.95, modifiedTime: '2026-11-09T00:00:00Z' }
    ],
    { category: 'HR & People', query: 'alp', sortBy: 'confidence', sortDir: 'desc' }
  );
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].name, 'Alpha');
});

test('server.js serves /api/config, static ES modules with COOP header, and blocks dotfiles', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-nano-test-'));
  const envFile = path.join(tmpDir, '.env');
  await fs.writeFile(
    envFile,
    'APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/AKfycbTestDeployment123/exec"\nPORT=5173\n'
  );

  const parsedEnv = parseEnvContent(await fs.readFile(envFile, 'utf8'));
  assert.equal(
    parsedEnv.APPS_SCRIPT_WEBAPP_URL,
    'https://script.google.com/macros/s/AKfycbTestDeployment123/exec'
  );

  const server = createAppServer({
    rootDir: path.resolve('.'),
    envPath: envFile
  });

  function invokeServer(url, method = 'GET', bodyPayload = '') {
    return new Promise((resolve) => {
      const headers = {};
      let statusCode = 200;
      const chunks = [];

      const req = { url, method, body: bodyPayload, headers: { host: 'localhost:5173' } };
      const res = {
        writeHead(code, hdrs = {}) {
          statusCode = code;
          for (const [k, v] of Object.entries(hdrs)) {
            headers[k.toLowerCase()] = v;
          }
        },
        end(payload) {
          if (payload) {
            chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolve({ status: statusCode, headers, body: rawBody });
        }
      };

      server.emit('request', req, res);
    });
  }

  try {
    // 1. /api/config exposes Apps Script URL + COOP header
    const cfgRes = await invokeServer('/api/config');
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
    const cfgBody = JSON.parse(cfgRes.body);
    assert.equal(
      cfgBody.appsScriptUrl,
      'https://script.google.com/macros/s/AKfycbTestDeployment123/exec'
    );

    // 1b. /api/auth-session stores and clears session in memory
    const postAuthRes = await invokeServer(
      '/api/auth-session',
      'POST',
      JSON.stringify({
        accessToken: 'ya29.relay',
        expiresAt: Date.now() + 60000,
        scope: DRIVE_READONLY_SCOPE,
        userProfile: { emailAddress: 'asundaram@logitech.com' }
      })
    );
    assert.equal(postAuthRes.status, 200);

    const getAuthRes = await invokeServer('/api/auth-session', 'GET');
    assert.equal(JSON.parse(getAuthRes.body).session.accessToken, 'ya29.relay');

    await invokeServer('/api/auth-session', 'DELETE');
    const clearedAuthRes = await invokeServer('/api/auth-session', 'GET');
    assert.equal(JSON.parse(clearedAuthRes.body).session, null);

    // 2. / serves index.html
    const htmlRes = await invokeServer('/');
    assert.equal(htmlRes.status, 200);
    assert.ok((htmlRes.headers['content-type'] || '').includes('text/html'));
    assert.ok(htmlRes.body.includes('Drive Nano Categorizer'));

    // 3. /app.js serves ES module with text/javascript
    const jsRes = await invokeServer('/app.js');
    assert.equal(jsRes.status, 200);
    assert.ok((jsRes.headers['content-type'] || '').includes('text/javascript'));

    // 4. /.env and traversal are strictly forbidden (403)
    const dotEnvRes = await invokeServer('/.env');
    assert.equal(dotEnvRes.status, 403);

    const methodRes = await invokeServer('/api/config', 'POST');
    assert.equal(methodRes.status, 405);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('index.html and app.js DOM ID contract is 100% consistent and app.js imports cleanly', async () => {
  await assert.doesNotReject(() => import('../app.js'));

  const html = await fs.readFile(path.resolve('index.html'), 'utf8');
  const appJs = await fs.readFile(path.resolve('app.js'), 'utf8');

  const idListMatch = appJs.match(/const ids = \[([\s\S]*?)\];/);
  assert.ok(idListMatch, 'Expected cacheDom() ID list in app.js');

  const expectedIds = [...idListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(expectedIds.length >= 35);

  for (const id of expectedIds) {
    assert.ok(
      html.includes(`id="${id}"`),
      `Missing element id="${id}" in index.html required by app.js`
    );
  }
});

test('Zero-GCP Apps Script Bridge URL builder, hash parser, tokeninfo scope check, and GAS governance rules pass', async () => {
  const nonce = generateOAuthStateNonce();
  assert.ok(nonce.length >= 16);

  // 1. Validate consumer & Google Workspace domain Apps Script URLs (/exec and /dev)
  assert.equal(
    isValidAppsScriptWebAppUrl('https://script.google.com/macros/s/AKfycb123_abc-456/exec'),
    true
  );
  assert.equal(
    isValidAppsScriptWebAppUrl('https://script.google.com/a/macros/logitech.com/s/AKfycb123/dev'),
    true
  );
  assert.equal(isValidAppsScriptWebAppUrl('https://evil.example.com/macros/s/123/exec'), false);

  // 2. Build popup & same-tab bridge URLs
  const bridgeUrl = new URL(
    buildAppsScriptBridgeUrl({
      appsScriptUrl: 'https://script.google.com/a/macros/logitech.com/s/AKfycb123/exec',
      returnTo: 'http://localhost:5173/',
      state: nonce,
      popup: true
    })
  );
  assert.equal(bridgeUrl.origin, 'https://script.google.com');
  assert.equal(bridgeUrl.searchParams.get('return_to'), 'http://localhost:5173/');
  assert.equal(bridgeUrl.searchParams.get('state'), nonce);
  assert.equal(bridgeUrl.searchParams.get('popup'), '1');

  // 3. Parse valid token callback & email from Bridge.html
  const parsedSuccess = parseOAuthHashFragment(
    `#access_token=ya29.gas&expires_in=3300&scope=${encodeURIComponent(
      `${DRIVE_READONLY_SCOPE} ${DRIVE_WRITE_SCOPE}`
    )}&email=${encodeURIComponent('employee@logitech.com')}&state=${nonce}&auth_source=gas`,
    nonce
  );
  assert.equal(parsedSuccess.ok, true);
  assert.equal(parsedSuccess.accessToken, 'ya29.gas');
  assert.equal(parsedSuccess.email, 'employee@logitech.com');
  assert.equal(parsedSuccess.hasWriteAccess, true);

  // 4. Reject CSRF state mismatch, but allow first-auth recovery when enabled
  const csrfMismatch = parseOAuthHashFragment(
    '#access_token=ya29.evil&state=wrong-nonce',
    nonce
  );
  assert.equal(csrfMismatch.ok, false);
  assert.equal(csrfMismatch.error, 'state_mismatch');

  const firstAuthRecovered = parseOAuthHashFragment(
    '#access_token=ya29.first&state=gas_first_auth&email=asundaram%40logitech.com',
    nonce,
    { allowFirstAuthRecovery: true }
  );
  assert.equal(firstAuthRecovered.ok, true);
  assert.equal(firstAuthRecovered.accessToken, 'ya29.first');

  // 5. Verify inspectTokenScopes & fetchDriveUserProfile
  const scopeInfo = await inspectTokenScopes({
    accessToken: 'ya29.gas',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { scope: DRIVE_READONLY_SCOPE, expires_in: '3200', email: 'asundaram@logitech.com' };
      }
    })
  });
  assert.equal(scopeInfo.hasWriteAccess, false);
  assert.equal(scopeInfo.isInvalid, false);
  assert.equal(scopeInfo.email, 'asundaram@logitech.com');

  const profile = await fetchDriveUserProfile({
    accessToken: 'ya29.gas',
    fetchImpl: async (url) => {
      assert.ok(url.includes('/drive/v3/about?fields=user'));
      return {
        ok: true,
        async json() {
          return {
            user: {
              displayName: 'Alex Sundaram',
              emailAddress: 'alex@example.com',
              photoLink: 'https://lh3.googleusercontent.com/a/avatar'
            }
          };
        }
      };
    }
  });
  assert.equal(profile.emailAddress, 'alex@example.com');

  // 6. Verify apps-script/ governance compliance (V8, Drive v3 Advanced Service, USER_ACCESSING, drive.readonly)
  const manifest = JSON.parse(
    await fs.readFile(path.resolve('apps-script/appsscript.json'), 'utf8')
  );
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.webapp.executeAs, 'USER_ACCESSING');
  assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId, 'drive');
  assert.ok(manifest.oauthScopes.includes(DRIVE_READONLY_SCOPE));
  assert.ok(!manifest.oauthScopes.includes(DRIVE_WRITE_SCOPE));

  const codeGs = await fs.readFile(path.resolve('apps-script/Code.gs'), 'utf8');
  const bridgeHtml = await fs.readFile(path.resolve('apps-script/Bridge.html'), 'utf8');
  assert.ok(!codeGs.includes('UrlFetchApp'));
  assert.ok(!bridgeHtml.includes('<?!='));
});
