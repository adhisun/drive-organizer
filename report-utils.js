/**
 * Pure reporting, sanitization, filtering, and target-folder resolution utilities.
 * Shared between browser ES modules and Node.js unit tests.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Friendly human-readable label for common Google Drive & standard MIME types.
 */
export function getMimeLabel(mimeType = '', fileName = '') {
  const mime = String(mimeType).toLowerCase();
  const ext = (String(fileName).split('.').pop() || '').toLowerCase();

  if (mime === 'application/vnd.google-apps.document') return 'Google Doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
  if (mime === 'application/vnd.google-apps.presentation') return 'Google Slides';
  if (mime === 'application/vnd.google-apps.form') return 'Google Form';
  if (mime === 'application/vnd.google-apps.drawing') return 'Google Drawing';
  if (mime === 'application/vnd.google-apps.shortcut') return 'Shortcut';
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (mime.includes('wordprocessingml') || ext === 'docx' || ext === 'doc') return 'Word Doc';
  if (mime.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xls') return 'Excel Sheet';
  if (mime.includes('presentationml') || ext === 'pptx' || ext === 'ppt') return 'PowerPoint';
  if (mime === 'text/csv' || ext === 'csv') return 'CSV';
  if (mime === 'text/markdown' || ext === 'md') return 'Markdown';
  if (mime === 'application/json' || ext === 'json') return 'JSON';
  if (mime.startsWith('text/')) return 'Text';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'Archive';
  return ext && ext !== fileName.toLowerCase() ? ext.toUpperCase() : 'File';
}

/**
 * Sanitize a single Google Drive folder name segment.
 */
export function sanitizeFolderSegment(rawSegment, fallback = 'Uncategorized') {
  const cleaned = String(rawSegment ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return fallback;
  }
  return cleaned.slice(0, 80);
}

/**
 * Resolve folder segments (relative to Drive root) and display path for a categorized file.
 * Supports:
 * 1. Per-row custom override (`item.customTargetPath`, e.g. "Finance & Legal/Tax 2026")
 * 2. Top-level category folder (`/Finance & Legal/`)
 * 3. Optional nested subfolder (`/Finance & Legal/Q3 Budgets/`)
 */
export function resolveTargetFolder(item, { includeSubfolder = false } = {}) {
  if (item?.customTargetPath && String(item.customTargetPath).trim()) {
    const customParts = String(item.customTargetPath)
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .slice(0, 3)
      .map((part) => sanitizeFolderSegment(part, 'Misc'));

    if (customParts.length > 0) {
      return {
        segments: customParts,
        displayPath: `/${customParts.join('/')}/`
      };
    }
  }

  const categorySeg = sanitizeFolderSegment(item?.category, 'Uncategorized');
  const segments = [categorySeg];

  if (includeSubfolder && item?.suggestedFolder) {
    const subSeg = sanitizeFolderSegment(item.suggestedFolder, '');
    if (subSeg && subSeg.toLowerCase() !== categorySeg.toLowerCase()) {
      segments.push(subSeg);
    }
  }

  return {
    segments,
    displayPath: `/${segments.join('/')}/`
  };
}

/**
 * Escape a single cell per RFC-4180 and neutralize spreadsheet formula injection
 * (`=`, `+`, `-`, `@`, tab, CR) when opened in Excel or Google Sheets.
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);

  if (str.length > 0 && FORMULA_TRIGGERS.has(str[0])) {
    // Allow negative numbers like "-0.5", neutralize everything else starting with formula chars
    if (!(str[0] === '-' && /^-\d+(\.\d+)?$/.test(str))) {
      str = `'${str}`;
    }
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export categorized Drive file rows to RFC-4180 CSV.
 */
export function toCsv(rows = [], { includeSubfolder = false } = {}) {
  const headers = [
    'File ID',
    'File Name',
    'Type',
    'Category',
    'Suggested Folder Path',
    'Summary',
    'Confidence',
    'Extraction Source',
    'AI Engine',
    'Modified Date',
    'Drive URL'
  ];

  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    const { displayPath } = resolveTargetFolder(row, { includeSubfolder });
    const confidencePct =
      typeof row.confidence === 'number' ? `${Math.round(row.confidence * 100)}%` : '';
    const cells = [
      row.id || '',
      row.name || '',
      row.mimeLabel || getMimeLabel(row.mimeType, row.name),
      row.category || 'Uncategorized',
      row.movedToPath || displayPath,
      row.summary || '',
      confidencePct,
      row.extractionSource || '',
      row.engine || '',
      formatShortDate(row.modifiedTime || row.createdTime),
      row.webViewLink || ''
    ];
    lines.push(cells.map(escapeCsvCell).join(','));
  }

  return lines.join('\r\n');
}

function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Export categorized Drive file rows to a GitHub-Flavored Markdown table report.
 */
export function toMarkdownTable(rows = [], { includeSubfolder = false } = {}) {
  const header = [
    '| File Name | Type | Category | Target Folder | Summary | Source | Modified |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  ];

  const body = rows.map((row) => {
    const safeName = escapeMarkdownCell(row.name || 'Untitled').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const nameCell = row.webViewLink ? `[${safeName}](${row.webViewLink})` : safeName;
    const { displayPath } = resolveTargetFolder(row, { includeSubfolder });
    const folderCell = `\`${escapeMarkdownCell(row.movedToPath || displayPath)}\``;
    const sourceBadge = `${escapeMarkdownCell(row.extractionSource || 'text')} (${escapeMarkdownCell(row.engine || 'nano')})`;

    return `| ${nameCell} | ${escapeMarkdownCell(row.mimeLabel || getMimeLabel(row.mimeType, row.name))} | **${escapeMarkdownCell(row.category || 'Uncategorized')}** | ${folderCell} | ${escapeMarkdownCell(row.summary || '')} | ${sourceBadge} | ${escapeMarkdownCell(formatShortDate(row.modifiedTime || row.createdTime))} |`;
  });

  return [...header, ...body].join('\n');
}

/**
 * Format ISO timestamp into YYYY-MM-DD cleanly.
 */
export function formatShortDate(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

/**
 * Filter and sort categorized file rows deterministically.
 */
export function filterAndSortResults(
  rows = [],
  { category = 'ALL', query = '', sortBy = 'modifiedTime', sortDir = 'desc' } = {}
) {
  const normalizedQuery = String(query || '').trim().toLowerCase();

  const filtered = rows.filter((row) => {
    if (category && category !== 'ALL' && row.category !== category) {
      return false;
    }
    if (!normalizedQuery) return true;

    const haystack = [
      row.name,
      row.category,
      row.summary,
      row.suggestedFolder,
      row.mimeLabel
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });

  const multiplier = sortDir === 'asc' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    if (sortBy === 'confidence') {
      return ((a.confidence ?? 0) - (b.confidence ?? 0)) * multiplier;
    }
    if (sortBy === 'modifiedTime') {
      const timeA = Date.parse(a.modifiedTime || a.createdTime || '') || 0;
      const timeB = Date.parse(b.modifiedTime || b.createdTime || '') || 0;
      return (timeA - timeB) * multiplier;
    }
    const valA = String(a[sortBy] ?? '').toLowerCase();
    const valB = String(b[sortBy] ?? '').toLowerCase();
    return valA.localeCompare(valB) * multiplier;
  });
}
