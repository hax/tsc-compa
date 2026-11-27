const tupleFields = ['candidate', 'version', 'reference', 'suite'];

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const isCandidate = (value) => nonEmpty(value?.id) && nonEmpty(value?.name) && nonEmpty(value?.version);
const isOption = (value) => nonEmpty(value?.id) && nonEmpty(value?.label);
const isCombination = (value) => isCandidate(value?.candidate) && isOption(value?.reference) && isOption(value?.suite);

export function readCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.combinations) || !value.combinations.every(isCombination)) {
    throw new Error('Invalid report catalog');
  }
  return value.combinations;
}

// Only link to generated HTML documents under this project's reports directory.
export function reportHref(value, siteRoot) {
  if (typeof value !== 'string' || !/^(?:\.\/)?reports\/(?:[\w.-]+\/)*[\w.-]+\.html$/.test(value)) return null;
  if (value.replace(/^\.\//, '').split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return new URL(value, siteRoot).href;
}

export function runHref(value) {
  return typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/.test(value)
    ? value : null;
}

export function readReports(value, siteRoot) {
  const ids = new Set();
  if (value?.schemaVersion !== 1 || !Array.isArray(value.reports)) throw new Error('Invalid report index');
  return value.reports.map((report) => {
    if (!isCombination(report) || !nonEmpty(report.id) || ids.has(report.id) ||
        !nonEmpty(report.generatedAt) || !Number.isFinite(Date.parse(report.generatedAt)) ||
        !reportHref(report.reportPath, siteRoot) || !runHref(report.runUrl)) {
      throw new Error('Invalid entry in report index');
    }
    ids.add(report.id);
    return report;
  }).sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || a.id.localeCompare(b.id));
}

export function selectionOf({ candidate, reference, suite }) {
  return { candidate: candidate.id, version: candidate.version, reference: reference.id, suite: suite.id };
}

function keyOf(combination) {
  const selection = selectionOf(combination);
  return JSON.stringify(tupleFields.map((field) => selection[field]));
}

export function sameSelection(a, b) {
  return keyOf(a) === keyOf(b);
}

export function combineChoices(catalog, reports) {
  const result = new Map();
  for (const combination of [...catalog, ...reports]) {
    const key = keyOf(combination);
    if (!result.has(key)) result.set(key, combination);
  }
  return Array.from(result.values());
}

export function requestedSelection(url) {
  return Object.fromEntries(tupleFields.map((field) => [field, url.searchParams.get(field)]));
}

export function shareUrl(url, combination) {
  const share = new URL(url);
  share.search = '';
  share.hash = '';
  for (const [key, value] of Object.entries(selectionOf(combination))) share.searchParams.set(key, value);
  return share;
}

// IDs in the index may be version-specific. Group by display name only in the
// picker, but keep the exact ID and version in each option and in share links.
export function versionKey(candidate) {
  return JSON.stringify([candidate.id, candidate.version]);
}

export function resolveSelection(choices, request, preferred = {}) {
  if (!choices.length) return { combination: null, adjusted: false };
  let matches = choices;
  let adjusted = false;
  for (const field of tupleFields) {
    const requested = request[field];
    if (requested == null) continue;
    const narrower = matches.filter((row) => selectionOf(row)[field] === requested);
    if (narrower.length) matches = narrower;
    else adjusted = true;
  }
  const combination = matches.find((row) => tupleFields.every((field) =>
    preferred[field] == null || selectionOf(row)[field] === preferred[field])) ?? matches[0];
  return { combination, adjusted };
}
