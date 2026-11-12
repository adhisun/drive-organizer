import { getMimeLabel, sanitizeFolderSegment } from './report-utils.js';

/**
 * Default enterprise taxonomy (user-customizable in UI settings).
 */
export const DEFAULT_CATEGORIES = [
  'Engineering & Tech',
  'Product & Design',
  'Finance & Legal',
  'Operations & Admin',
  'Marketing & Sales',
  'HR & People',
  'Meeting Notes',
  'Archive / Media',
  'Uncategorized'
];

export const MAX_WORDS_PER_FILE = 1000;
export const MAX_CHARS_PER_FILE = 8000;
export const TARGET_TEMPERATURE = 0.2;

/**
 * Truncate file body text deterministically to fit within ~2,000 tokens
 * (~1,000 words and at most 8,000 characters) per spec governance.
 */
export function truncateContent(text, maxWords = MAX_WORDS_PER_FILE, maxChars = MAX_CHARS_PER_FILE) {
  if (!text) return { snippet: '', truncated: false, wordCount: 0 };

  const normalized = String(text)
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return { snippet: '', truncated: false, wordCount: 0 };

  const words = normalized.split(/\s+/);
  const totalWords = words.length;
  let truncated = false;
  let result = normalized;

  if (totalWords > maxWords) {
    result = words.slice(0, maxWords).join(' ');
    truncated = true;
  }

  if (result.length > maxChars) {
    result = result.slice(0, maxChars).trimEnd();
    truncated = true;
  }

  return {
    snippet: result,
    truncated,
    wordCount: result ? result.split(/\s+/).length : 0
  };
}

/**
 * JSON Schema passed via `responseConstraint` to Chrome's Prompt API.
 */
export function buildResponseSchema(categories = DEFAULT_CATEGORIES) {
  const validCategories = ensureCategoriesList(categories);
  return {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: validCategories
      },
      summary: {
        type: 'string'
      },
      suggestedFolder: {
        type: 'string'
      },
      confidence: {
        type: 'number'
      }
    },
    required: ['category', 'summary', 'suggestedFolder', 'confidence'],
    additionalProperties: false
  };
}

export function ensureCategoriesList(categories = DEFAULT_CATEGORIES) {
  const seen = new Set();
  const cleaned = [];
  for (const cat of categories) {
    const trimmed = sanitizeFolderSegment(cat, '');
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      cleaned.push(trimmed);
    }
  }
  if (!seen.has('uncategorized')) {
    cleaned.push('Uncategorized');
  }
  return cleaned;
}

/**
 * Resolve Chrome Built-in AI provider across modern (`self.LanguageModel`, Chrome 138+)
 * and legacy (`window.ai.languageModel`, Chrome 127-137) surfaces.
 */
export function resolveAiProvider(globalScope = globalThis) {
  if (globalScope?.LanguageModel && typeof globalScope.LanguageModel.create === 'function') {
    return {
      api: globalScope.LanguageModel,
      flavor: 'LanguageModel'
    };
  }
  if (
    globalScope?.ai?.languageModel &&
    typeof globalScope.ai.languageModel.create === 'function'
  ) {
    return {
      api: globalScope.ai.languageModel,
      flavor: 'window.ai.languageModel'
    };
  }
  return null;
}

function normalizeAvailabilityStatus(rawStatus) {
  const val = String(rawStatus || '').toLowerCase();
  if (val === 'available' || val === 'readily') return 'ready';
  if (val === 'downloadable' || val === 'after-download') return 'downloadable';
  if (val === 'downloading') return 'downloading';
  return 'unavailable';
}

/**
 * Check Chrome Built-in AI Gemini Nano availability and return normalized diagnostics.
 */
export async function checkAiAvailability(globalScope = globalThis) {
  const resolved = resolveAiProvider(globalScope);
  if (!resolved) {
    return {
      status: 'unavailable',
      rawStatus: 'missing-api',
      flavor: null,
      message:
        'Chrome Built-in AI API not detected. Open in Chrome 128+ and enable Prompt API & On-Device Model flags.'
    };
  }

  const { api, flavor } = resolved;
  try {
    let rawStatus = 'unavailable';
    if (typeof api.availability === 'function') {
      rawStatus = await api.availability();
    } else if (typeof api.capabilities === 'function') {
      const caps = await api.capabilities();
      rawStatus = caps?.available || 'unavailable';
    }

    const status = normalizeAvailabilityStatus(rawStatus);
    const messages = {
      ready: `Gemini Nano ready on-device (${flavor})`,
      downloadable: `Gemini Nano available to download on first scan (${flavor})`,
      downloading: `Downloading Gemini Nano model weights locally (${flavor})...`,
      unavailable:
        'Gemini Nano model is unavailable on this device/profile. Check chrome://flags and chrome://components.'
    };

    return {
      status,
      rawStatus,
      flavor,
      message: messages[status]
    };
  } catch (err) {
    return {
      status: 'unavailable',
      rawStatus: 'error',
      flavor,
      message: `Error checking Gemini Nano status: ${err?.message || String(err)}`
    };
  }
}

export function buildSystemPrompt(categories) {
  const catList = categories.map((c) => `- "${c}"`).join('\n');
  return [
    'You are an internal enterprise file librarian classifying and summarizing Google Drive files strictly from provided metadata and text excerpts.',
    'Rules:',
    '1. Assign exactly ONE category from this allowed list:',
    catList,
    '2. Write a factual, specific 1-2 sentence summary (max 35 words) describing what the file is about. If only metadata is available, state clearly what the file appears to be based on its title and file type.',
    '3. Propose a concise 1-3 word subfolder name in `suggestedFolder` (for example "Q3 Budgets", "API Specs", "Vendor Contracts", "Screenshots"). Do not include slashes.',
    '4. Provide `confidence` as a number between 0.0 and 1.0.',
    '5. Respond ONLY with a valid JSON object matching: {"category": "...", "summary": "...", "suggestedFolder": "...", "confidence": 0.85}.'
  ].join('\n');
}

export function buildFilePrompt(file, extraction) {
  const mimeLabel = extraction?.mimeLabel || getMimeLabel(file.mimeType, file.name);
  const { snippet, truncated } = truncateContent(extraction?.text || '');
  const lines = [
    `File Name: ${file.name || 'Untitled'}`,
    `File Type: ${mimeLabel} (${file.mimeType || 'unknown'})`,
    `Extraction Mode: ${snippet ? 'Document Text Excerpt' : 'Metadata Only (binary/non-text file)'}`
  ];

  if (file.description) {
    lines.push(`Drive Description: ${String(file.description).slice(0, 300)}`);
  }

  if (snippet) {
    lines.push(
      `Content Excerpt${truncated ? ' (first ~1,000 words)' : ''}:\n"""\n${snippet}\n"""`
    );
  } else {
    lines.push(
      'No body text was downloaded for this binary/media file. Infer category and a brief descriptive summary from the file name, extension, and type.'
    );
  }

  return lines.join('\n');
}

/**
 * Parse and validate JSON output from Gemini Nano, recovering gracefully if the model
 * wraps JSON in markdown code fences or returns a slightly variant category casing.
 */
export function parseModelResponse(rawOutput, categories = DEFAULT_CATEGORIES) {
  const validCategories = ensureCategoriesList(categories);
  const text = String(rawOutput ?? '').trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fencedMatch = text.match(/\{[\s\S]*\}/);
    if (fencedMatch) {
      try {
        parsed = JSON.parse(fencedMatch[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model response was not valid JSON');
  }

  const rawCategory = String(parsed.category || '').trim();
  const matchedCategory =
    validCategories.find((c) => c.toLowerCase() === rawCategory.toLowerCase()) ||
    validCategories.find(
      (c) =>
        rawCategory &&
        (c.toLowerCase().includes(rawCategory.toLowerCase()) ||
          rawCategory.toLowerCase().includes(c.toLowerCase()))
    ) ||
    'Uncategorized';

  const summary =
    String(parsed.summary || '').replace(/\s+/g, ' ').trim() ||
    `Categorized under ${matchedCategory}.`;

  const suggestedFolder = sanitizeFolderSegment(parsed.suggestedFolder || 'General', 'General');

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) {
    confidence = 0.75;
  }
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));

  return {
    category: matchedCategory,
    summary: summary.slice(0, 320),
    suggestedFolder,
    confidence
  };
}

/**
 * Deterministic local keyword & MIME heuristic classifier.
 * Used ONLY in Demo Mode (without Chrome AI) or when the user opts into local heuristic fallback.
 */
export function heuristicCategorize(file, extraction, categories = DEFAULT_CATEGORIES) {
  const validCategories = ensureCategoriesList(categories);
  const mimeLabel = extraction?.mimeLabel || getMimeLabel(file?.mimeType, file?.name);
  const { snippet } = truncateContent(extraction?.text || '', 250, 1500);
  const corpus = `${file?.name || ''} ${file?.description || ''} ${snippet}`.toLowerCase();

  const rules = [
    {
      target: 'Finance & Legal',
      folder: 'Financials & Contracts',
      keywords: [
        'budget', 'invoice', 'receipt', 'expense', 'tax', 'nda', 'contract', 'agreement',
        'msa', 'sow', 'revenue', 'forecast', 'p&l', 'payroll', 'audit', 'procurement', 'legal', 'po#'
      ]
    },
    {
      target: 'Engineering & Tech',
      folder: 'Architecture & Code',
      keywords: [
        'architecture', 'api', 'rfc', 'postmortem', 'incident', 'schema', 'database', 'deploy',
        'kubernetes', 'docker', 'script', 'config', 'bug', 'latency', 'repo', 'sdk', 'security', 'json', 'sql'
      ]
    },
    {
      target: 'Product & Design',
      folder: 'Specs & Research',
      keywords: [
        'prd', 'roadmap', 'wireframe', 'figma', 'ux', 'ui', 'user research', 'feature',
        'discovery', 'prototype', 'persona', 'backlog', 'release notes', 'product'
      ]
    },
    {
      target: 'Meeting Notes',
      folder: 'Syncs & Retros',
      keywords: [
        'meeting', 'minutes', 'sync', 'standup', '1:1', '1-on-1', 'retro', 'retrospective',
        'agenda', 'action items', 'notes', 'kickoff', 'all-hands'
      ]
    },
    {
      target: 'Marketing & Sales',
      folder: 'Campaigns & GTM',
      keywords: [
        'campaign', 'pitch', 'gtm', 'go-to-market', 'customer', 'churn', 'pipeline', 'lead',
        'case study', 'press', 'social', 'brand', 'webinar', 'deck', 'sales'
      ]
    },
    {
      target: 'HR & People',
      folder: 'People & Onboarding',
      keywords: [
        'onboarding', 'hiring', 'interview', 'candidate', 'resume', 'benefits', 'pto',
        'performance review', 'okr', 'handbook', 'headcount', 'compensation', 'org chart'
      ]
    },
    {
      target: 'Operations & Admin',
      folder: 'Ops & Runbooks',
      keywords: [
        'sop', 'runbook', 'inventory', 'vendor', 'logistics', 'schedule', 'tracker',
        'checklist', 'policy', 'facilities', 'itops', 'workflow', 'operations'
      ]
    }
  ];

  let bestRule = null;
  let bestHits = 0;

  for (const rule of rules) {
    if (!validCategories.some((c) => c.toLowerCase() === rule.target.toLowerCase())) {
      continue;
    }
    const hits = rule.keywords.reduce((acc, kw) => (corpus.includes(kw) ? acc + 1 : acc), 0);
    if (hits > bestHits) {
      bestHits = hits;
      bestRule = rule;
    }
  }

  let category = 'Uncategorized';
  let suggestedFolder = 'General';
  let confidence = 0.55;

  if (bestRule && bestHits > 0) {
    category =
      validCategories.find((c) => c.toLowerCase() === bestRule.target.toLowerCase()) ||
      'Uncategorized';
    suggestedFolder = bestRule.folder;
    confidence = Math.min(0.9, 0.62 + bestHits * 0.08);
  } else if (
    ['Image', 'Video', 'Audio', 'Archive'].includes(mimeLabel) &&
    validCategories.some((c) => c.toLowerCase() === 'archive / media')
  ) {
    category = validCategories.find((c) => c.toLowerCase() === 'archive / media');
    suggestedFolder = mimeLabel === 'Archive' ? 'Archives' : 'Media Assets';
    confidence = 0.72;
  } else if (validCategories[0] && validCategories[0] !== 'Uncategorized' && snippet.length > 80) {
    category = 'Uncategorized';
    suggestedFolder = 'Needs Review';
    confidence = 0.5;
  }

  let summary;
  if (snippet) {
    const firstSentence = snippet
      .split(/(?<=[.!?])\s+|\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 18);
    const preview = (firstSentence || snippet).slice(0, 180).trim();
    summary = `${mimeLabel} covering: ${preview}${preview.length >= 180 ? '...' : ''}`;
  } else {
    summary = `${mimeLabel} file ("${file?.name || 'Untitled'}") classified from filename and MIME metadata.`;
  }

  return {
    category,
    summary,
    suggestedFolder,
    confidence: Math.round(confidence * 100) / 100,
    engine: 'heuristic'
  };
}

/**
 * Manages a Chrome Built-in AI (Gemini Nano) base session and creates isolated
 * per-file cloned sessions so batches never exhaust or cross-contaminate context.
 */
export class CategorizerEngine {
  constructor({
    categories = DEFAULT_CATEGORIES,
    allowHeuristicFallback = true,
    onDownloadProgress = null,
    globalScope = globalThis
  } = {}) {
    this.categories = ensureCategoriesList(categories);
    this.allowHeuristicFallback = allowHeuristicFallback;
    this.onDownloadProgress = onDownloadProgress;
    this.globalScope = globalScope;
    this.baseSession = null;
    this.providerFlavor = null;
    this.supportsResponseConstraint = true;
  }

  async init({ signal } = {}) {
    const resolved = resolveAiProvider(this.globalScope);
    if (!resolved) {
      if (this.allowHeuristicFallback) {
        return { mode: 'heuristic', flavor: null };
      }
      throw new Error(
        'Chrome Built-in AI (Gemini Nano) is not available in this browser. Enable Chrome AI flags or allow heuristic fallback in Settings.'
      );
    }

    const { api, flavor } = resolved;
    this.providerFlavor = flavor;

    const systemPrompt = buildSystemPrompt(this.categories);
    const monitor = (m) => {
      if (m && typeof m.addEventListener === 'function' && this.onDownloadProgress) {
        m.addEventListener('downloadprogress', (event) => {
          const pct =
            typeof event.loaded === 'number'
              ? Math.round(
                  (event.total && event.total > 0 ? event.loaded / event.total : event.loaded) * 100
                )
              : 0;
          this.onDownloadProgress(Math.max(0, Math.min(100, pct)));
        });
      }
    };

    // Determine valid topK if numerical temperature is supported
    let defaultTopK = 3;
    try {
      if (typeof api.params === 'function') {
        const params = await api.params();
        if (params?.defaultTopK) defaultTopK = params.defaultTopK;
      } else if (typeof api.capabilities === 'function') {
        const caps = await api.capabilities();
        if (caps?.defaultTopK) defaultTopK = caps.defaultTopK;
      }
    } catch {
      // Ignore params lookup errors on restricted origins
    }

    try {
      // Modern LanguageModel uses initialPrompts: [{ role: 'system', content }], while legacy also accepts systemPrompt.
      const createOptsWithTemp =
        flavor === 'LanguageModel'
          ? {
              initialPrompts: [{ role: 'system', content: systemPrompt }],
              temperature: TARGET_TEMPERATURE,
              topK: defaultTopK,
              monitor,
              signal
            }
          : {
              systemPrompt,
              temperature: TARGET_TEMPERATURE,
              topK: defaultTopK,
              monitor,
              signal
            };

      try {
        this.baseSession = await api.create(createOptsWithTemp);
      } catch (samplingErr) {
        if (signal?.aborted) throw samplingErr;
        // Standard web pages in Chrome may disallow raw numerical temperature/topK; retry cleanly without them.
        const fallbackCreateOpts =
          flavor === 'LanguageModel'
            ? {
                initialPrompts: [{ role: 'system', content: systemPrompt }],
                monitor,
                signal
              }
            : {
                systemPrompt,
                monitor,
                signal
              };
        this.baseSession = await api.create(fallbackCreateOpts);
      }

      return { mode: 'gemini-nano', flavor };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (this.allowHeuristicFallback) {
        this.baseSession = null;
        return { mode: 'heuristic', flavor: null, fallbackReason: err?.message || String(err) };
      }
      throw err;
    }
  }

  async categorizeFile(file, extraction, { signal } = {}) {
    if (signal?.aborted) {
      throw new DOMException('Categorization aborted', 'AbortError');
    }

    if (!this.baseSession) {
      return heuristicCategorize(file, extraction, this.categories);
    }

    const promptText = buildFilePrompt(file, extraction);
    const schema = buildResponseSchema(this.categories);
    let fileSession = null;
    let ownsSession = false;

    try {
      if (typeof this.baseSession.clone === 'function') {
        fileSession = await this.baseSession.clone({ signal });
        ownsSession = true;
      } else {
        fileSession = this.baseSession;
      }

      let rawOutput;
      if (this.supportsResponseConstraint) {
        try {
          rawOutput = await fileSession.prompt(promptText, {
            responseConstraint: schema,
            omitResponseConstraintInput: true,
            signal
          });
        } catch (constraintErr) {
          if (signal?.aborted) throw constraintErr;
          this.supportsResponseConstraint = false;
          rawOutput = await fileSession.prompt(promptText, { signal });
        }
      } else {
        rawOutput = await fileSession.prompt(promptText, { signal });
      }

      const structured = parseModelResponse(rawOutput, this.categories);
      return {
        ...structured,
        engine: 'gemini-nano'
      };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw err;
      }
      if (this.allowHeuristicFallback) {
        return heuristicCategorize(file, extraction, this.categories);
      }
      throw err;
    } finally {
      if (ownsSession && fileSession && typeof fileSession.destroy === 'function') {
        try {
          fileSession.destroy();
        } catch {
          // Ignore session cleanup errors
        }
      }
    }
  }

  destroy() {
    if (this.baseSession && typeof this.baseSession.destroy === 'function') {
      try {
        this.baseSession.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.baseSession = null;
  }
}
