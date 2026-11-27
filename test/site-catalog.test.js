import { describe, expect, test } from 'bun:test';
import {
  combineChoices, readCatalog, readReports, reportHref, requestedSelection,
  resolveSelection, runHref, sameSelection, selectionOf, shareUrl,
} from '../site/catalog.js';

const root = new URL('https://hax.github.io/tsc-compa/');
const bun = { id: 'bun', name: 'Bun', version: '1.4.5' };
const reference = { id: 'ts7-official', label: 'TypeScript 7.1.0-beta · 官方基线' };
const sample = { candidate: bun, reference, suite: { id: 'sample-120', label: '120 例诊断样本' } };
const full = { candidate: bun, reference, suite: { id: 'full', label: '全量' } };
const archived = { ...sample, candidate: { ...bun, version: '1.4.4' } };

function report(combination, id, date = '2026-11-27T12:00:00Z') {
  return {
    ...combination, id, generatedAt: date,
    reportPath: `reports/runs/${id}/report.html`,
    runUrl: 'https://github.com/hax/tsc-compa/actions/runs/123456',
  };
}

describe('public report catalog', () => {
  test('keeps unrun choices and retired combinations with reports', () => {
    const catalog = readCatalog({ schemaVersion: 1, combinations: [sample, full] });
    const reports = readReports({ schemaVersion: 1, reports: [report(sample, 'a'), report(archived, 'b')] }, root);
    expect(combineChoices(catalog, reports).map(selectionOf)).toEqual([sample, full, archived].map(selectionOf));
    expect(reports.filter((item) => sameSelection(full, item))).toEqual([]);
    expect(reports.filter((item) => sameSelection(archived, item)).map((item) => item.id)).toEqual(['b']);
  });

  test('orders history by actual instant and rejects duplicate IDs and malformed data', () => {
    const newer = report(sample, 'newer', '2026-11-27T12:00:00Z');
    const older = report(sample, 'older', '2026-11-27T13:00:00+02:00');
    expect(readReports({ schemaVersion: 1, reports: [older, newer] }, root)).toEqual([newer, older]);
    expect(() => readReports({ schemaVersion: 1, reports: [newer, newer] }, root)).toThrow();
    expect(() => readReports({ schemaVersion: 1, reports: [{ ...newer, generatedAt: 'bad' }] }, root)).toThrow();
    expect(() => readCatalog({ schemaVersion: 2, combinations: [] })).toThrow();
    expect(() => readCatalog({ schemaVersion: 1, combinations: [null] })).toThrow();
    expect(readReports({ schemaVersion: 1, reports: [] }, root)).toEqual([]);
  });

  test('round-trips the full selection under a project Pages path and prefers a published report by default', () => {
    const selection = { ...full, candidate: { ...bun, version: '1.5.0-beta+local/a' } };
    const url = shareUrl(new URL('?unused=1#old', root), selection);
    expect(url.pathname).toBe('/tsc-compa/');
    expect(url.searchParams.get('unused')).toBeNull();
    expect(url.hash).toBe('');
    expect(requestedSelection(url)).toEqual(selectionOf(selection));
    const choices = [sample, full, selection];
    expect(resolveSelection(choices, requestedSelection(url), selectionOf(sample))).toEqual({ combination: selection, adjusted: false });
    expect(resolveSelection(choices, {}, selectionOf(full))).toEqual({ combination: full, adjusted: false });
  });

  test('flags a removed selection without inventing a runnable combination', () => {
    expect(resolveSelection([sample], { ...selectionOf(sample), suite: 'deleted' })).toEqual({ combination: sample, adjusted: true });
    expect(resolveSelection([], selectionOf(sample))).toEqual({ combination: null, adjusted: false });
  });

  test('only accepts relative report documents under reports/ and HTTPS GitHub run links', () => {
    expect(reportHref('reports/runs/abc/report.html', root)).toBe('https://hax.github.io/tsc-compa/reports/runs/abc/report.html');
    expect(reportHref('./reports/abc.html', root)).toBe('https://hax.github.io/tsc-compa/reports/abc.html');
    for (const path of [null, 'javascript:alert(1)', 'https://hax.github.io/tsc-compa/reports/x.html', '//evil.test/x.html',
      '/reports/x.html', 'index.html', 'reports/../index.html', 'reports/%2e%2e/index.html', 'reports\\x.html',
      'reports/x.html?other', 'reports/x.html#other', 'reports/.//x.html', 'reports/x.js']) {
      expect(reportHref(path, root)).toBeNull();
    }
    const localReport = report(sample, 'a');
    expect(runHref(localReport.runUrl)).toBe(localReport.runUrl);
    for (const url of ['http://github.com/hax/tsc-compa/actions/runs/123', 'https://github.com.evil.example/hax/tsc-compa/actions/runs/123',
      'https://github.com@evil.test/hax/tsc-compa/actions/runs/123', 'https://github.com/hax/tsc-compa/actions/workflows/publish.yml',
      'https://github.com/hax/tsc-compa/actions/runs/abc']) {
      expect(runHref(url)).toBeNull();
    }
    expect(() => readReports({ schemaVersion: 1, reports: [{ ...localReport, reportPath: 'reports/../index.html' }] }, root)).toThrow();
  });
});
