import { expect, test } from 'bun:test';
import { readReports } from '../site/catalog.js';
import { compatibilityCounts, displayDate, formatCompatibilityCounts, latestFullReport } from '../site/candidate-overview.js';
import snapshot from '../site/candidate-overview.json';
import implementations from '../config/implementations.json';
import { publicCatalog } from '../scripts/public-evaluation.ts';
import { activePolicies } from '../scripts/public-evaluation-policy.ts';

const root = new URL('https://example.com/tsc-compa/');

test('overview covers exactly the current public full tuples, without the internal candidates', () => {
  const full = publicCatalog().combinations.filter(({ suite }) => suite.id === 'full');
  const tuples = snapshot.families.flatMap(({ id, versions }) =>
    versions.map(({ version }) => [id, version, snapshot.reference.id]));
  expect(snapshot.families.map(({ id }) => id)).toEqual(['typescript', 'bun', 'tsrs', 'ts-rust', 'tsz']);
  expect(tuples).toEqual(full.map(({ candidate, reference }) => [candidate.id, candidate.version, reference.id]));
  expect(snapshot.internal.repo).toBe('kazhiramatsu/tsc-rs');
  expect(snapshot.internal.smoke.sha).toBe(implementations.implementations['tsc-rs'].acquisition.cargo.git.ref);
  expect(snapshot.internal.release.tag).toBe('v0.1.0');
  const tsRust = snapshot.families.find(({ id }) => id === 'ts-rust').versions[0];
  const tsz = snapshot.families.find(({ id }) => id === 'tsz');
  expect(tsRust.npm.package).toBe(activePolicies['ts-rust'].source.package);
  expect(tsRust.npm.gitHead).toBe(activePolicies['ts-rust'].source.sourceCommit);
  expect(tsz.versions[0].release.commit).toBe(activePolicies.tsz.source.commit);
  expect(tsz.internalSmoke).toBe(implementations.implementations.tsz.acquisition.cargo.git.ref);
});

test('snapshot distinguishes tag, commit and publication dates and keeps exact UTC timestamps', () => {
  const [official, bun, tsrs, tsRust, tsz] = snapshot.families;
  expect(bun.versions.map(({ release }) => release.taggerDate)).toEqual([null, null]);
  expect(official.versions[0].release).toBeUndefined();
  expect(tsrs.versions[0].release).toBeUndefined();
  expect(tsrs.versions[0].npm.gitHead).toBeUndefined();
  expect(tsrs.versions[0].npm.slsaCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(new Set(Object.values(tsRust.versions[0].release).filter((value) => value.endsWith('Z'))).size).toBe(3);
  expect(tsz.versions[0].release.taggerDate).not.toBe(tsz.versions[0].release.publishedAt);
  expect(displayDate(official.versions[0].npm.publishedAt)).toBe('2026-10-21');
  expect(displayDate(tsRust.versions[0].release.taggerDate)).toBe('2026-10-22');
  for (const match of JSON.stringify(snapshot).matchAll(/"(?:asOf|publishedAt|taggerDate|commitDate|committedAt)":"([^"]+)"/g)) {
    expect(match[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
    expect(Date.parse(match[1])).toBeLessThanOrEqual(Date.parse(snapshot.asOf));
  }
});

test('the newest exact full tuple wins, and counts come from that report', () => {
  const expected = publicCatalog().combinations.find(({ candidate, suite }) => candidate.id === 'bun' && suite.id === 'full');
  function report(id, generatedAt, fields = {}, pass = 3) {
    return { ...expected, id, generatedAt, reportPath: `reports/${id}.html`,
      runUrl: 'https://github.com/hax/tsc-compa/actions/runs/1234',
      summary: { compatibility: { pass, fail: 4, unknown: 1 }, skipped: 27 }, ...fields };
  }
  const index = readReports({ schemaVersion: 1, reports: [
    report('older', '2026-11-27T09:00:00Z'),
    report('newer', '2026-11-27T10:00:00Z', {}, 60),
    report('sample', '2026-11-27T11:00:00Z', { suite: { id: 'fixed-120', label: '120' } }),
    report('other-reference', '2026-11-27T12:00:00Z', { reference: { id: 'other', label: 'Other' } }),
    report('other-version', '2026-11-27T13:00:00Z', { candidate: { ...expected.candidate, version: '1.99.0' } }),
    report('other-candidate', '2026-11-27T14:00:00Z', { candidate: { ...expected.candidate, id: 'other' } }),
  ] }, root);
  const selected = latestFullReport(index, 'bun', expected.candidate.version, snapshot.reference.id);
  expect(selected.reportPath).toBe('reports/newer.html');
  expect(compatibilityCounts(selected)).toEqual({ pass: 60, fail: 4, skipped: 27, unknown: 1 });
  expect(latestFullReport(index, 'bun', '1.4.999', snapshot.reference.id)).toBeUndefined();
  expect(compatibilityCounts({})).toBeNull();
  expect(compatibilityCounts({ summary: { skipped: 0, compatibility: { pass: -1, fail: 0, unknown: 0 } } })).toBeNull();
  expect(compatibilityCounts({ summary: { skipped: 0, compatibility: { pass: 0, fail: 0, unknown: 0 } } }))
    .toEqual({ pass: 0, fail: 0, skipped: 0, unknown: 0 });
});


test('overview shows crash and timeout as a subset of failures and preserves historical counts', () => {
  const summary = { compatibility: { pass: 8, fail: 4, unknown: 1 }, skipped: 2 };
  expect(formatCompatibilityCounts(compatibilityCounts({ summary })))
    .toBe('兼容通过 8 / 不兼容 4 / 跳过 2 / 无法确认 1');
  const current = { ...summary, executionFailures: { crash: 1, timeout: 2 } };
  expect(formatCompatibilityCounts(compatibilityCounts({ summary: current })))
    .toBe('兼容通过 8 / 不兼容 4（含崩溃 1、超时 2） / 跳过 2 / 无法确认 1');
  expect(compatibilityCounts({ summary: { ...summary, executionFailures: { crash: 2, timeout: 3 } } })).toBeNull();
});
