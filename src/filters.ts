import type { CommitCategory, IndexMetadata } from './types.js';

export const MAX_FILES_PER_COMMIT = 20;

/**
 * Signal keywords that make a commit worth indexing.
 * Exact set from Python filters.py RELEVANT_KEYWORDS.
 */
export const RELEVANT_KEYWORDS = new Set([
  'fix', 'bug', 'refactor', 'security', 'arch', 'architecture',
  'perf', 'performance', 'breaking', 'migrate', 'migration',
  'deprecat', 'revert', 'feat', 'feature', 'design', 'restructure',
  'upgrade', 'downgrade', 'critical', 'hotfix', 'patch', 'chore',
]);

/**
 * Ordered pairs for category detection.
 * IMPORTANT: order matches Python tuple exactly — first match wins.
 *   ("fix", "bug", "security", "refactor", "perf", "performance",
 *    "arch", "feature", "feat", "migration", "revert")
 */
const CATEGORY_ORDER: [string, CommitCategory][] = [
  ['fix',         'fix'],
  ['bug',         'fix'],
  ['security',    'security'],
  ['refactor',    'refactor'],
  ['perf',        'perf'],
  ['performance', 'perf'],
  ['arch',        'arch'],
  ['feature',     'feat'],
  ['feat',        'feat'],
  ['migration',   'migration'],
  ['revert',      'fix'],
];

/**
 * True if commit message contains at least one signal keyword.
 * Exact port of Python is_relevant().
 */
export function isRelevant(message: string): boolean {
  const lowered = message.toLowerCase();
  for (const kw of RELEVANT_KEYWORDS) {
    if (lowered.includes(kw)) return true;
  }
  return false;
}

/**
 * First keyword match → category. Falls back to 'general'.
 * Exact port of Python build_metadata() category logic.
 */
export function categorize(message: string): CommitCategory {
  const lowered = message.toLowerCase();
  for (const [kw, cat] of CATEGORY_ORDER) {
    if (lowered.includes(kw)) return cat;
  }
  return 'general';
}

/**
 * Build the searchable document text stored in ChromaDB.
 * Exact format from Python _build_document():
 *
 *   {message}
 *   Author: {name} <{email}>
 *   Date: {YYYY-MM-DD}
 *   Stats: {stats_str}
 *   Files: {comma-separated or "none"}
 */
export function buildDocument(
  message: string,
  authorName: string,
  authorEmail: string,
  dateStr: string,
  statsStr: string,
  files: string[],
): string {
  const filesDisplay = files.length > 0 ? files.join(', ') : 'none';
  return [
    message.trim(),
    `Author: ${authorName} <${authorEmail}>`,
    `Date: ${dateStr}`,
    `Stats: ${statsStr}`,
    `Files: ${filesDisplay}`,
  ].join('\n');
}

/**
 * Build the 6-line LLM-readable summary for ContextStore (Layer 2).
 * Exact format from Python summarize_commit():
 *
 *   Commit: {hash}
 *   Author: {name} <{email}>
 *   Date: {YYYY-MM-DD HH:MM UTC}
 *   Message: {message}
 *   Stats: +{ins}/-{del} lines across {n} file(s)
 *   Files changed: {comma-separated or "none"}
 */
export function summarizeCommit(params: {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  message: string;
  insertions: number;
  deletions: number;
  fileCount: number;
  files: string[];
}): string {
  const dateStr = params.date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
  const filesDisplay = params.files.length > 0 ? params.files.join(', ') : 'none';
  const statsStr = `+${params.insertions}/-${params.deletions} lines across ${params.fileCount} file(s)`;
  return [
    `Commit: ${params.hash}`,
    `Author: ${params.authorName} <${params.authorEmail}>`,
    `Date: ${dateStr}`,
    `Message: ${params.message.trim()}`,
    `Stats: ${statsStr}`,
    `Files changed: ${filesDisplay}`,
  ].join('\n');
}

/**
 * Build structured metadata dict stored alongside the commit.
 * Exact port of Python build_metadata().
 * Returns IndexMetadata (superset of CommitMetadata).
 */
export function buildMetadata(params: {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  message: string;
  files: string[];
  repoName: string;
}): IndexMetadata {
  const dateIso = params.date.toISOString();
  const files = params.files.slice(0, MAX_FILES_PER_COMMIT);
  return {
    type:           'git_commit',
    repo:           params.repoName,
    commit_hash:    params.hash,
    short_hash:     params.hash.slice(0, 8),
    author_name:    params.authorName,
    author_email:   params.authorEmail,
    committed_date: dateIso,
    category:       categorize(params.message),
    files_changed:  files,
    files_str:      files.join('|'),
    date_str:       dateIso.slice(0, 10),
  };
}

/**
 * Build stats string from insertions/deletions.
 * Format: "+100/-50 lines" — used in buildDocument().
 */
export function buildStatsStr(insertions: number, deletions: number): string {
  return `+${insertions}/-${deletions} lines`;
}
