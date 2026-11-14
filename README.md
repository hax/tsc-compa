# tsc-compa

An implementation-agnostic compatibility test suite for TypeScript type checkers.

This repository is not tied to any single implementation: given a TSC-compatible
checker shipped as a binary (driven through an adapter), it runs the official
TypeScript test corpus against multiple tsc baselines and reports:

- **false positives** — diagnostics the implementation reports where tsc does not;
- **coverage** — officially expected diagnostics the implementation actually reports;
- **mis-anchors** — same file and code, different position (counted separately,
  never mixed into false positives / misses);
- **skips** — unsupported constructs, classified and explained rather than silently ignored.

The goal is to be able to *prove* near-100% compatibility for a checker, and to
run the same suite against any TSC-compatible implementation.

## Status

v1 (2026-11): case-directive parsing, tsc-generated expectations with caching,
case classification/filtering, three tsc baselines (5.9.3 / 6.0.3 / 7.1.0-beta,
each paired with its own corpus tag in `config/baselines.json`), a per-case CLI
adapter plus a batch-adapter protocol (with reference implementation), and a
**reference adapter that runs real `tsc`** (`--adapter tsc-cli`, used to
self-check the harness). Metrics cover false positives, coverage, mismatched
anchors and per-class breakdowns. A GitHub Actions workflow runs unit tests plus
a self-compare smoke for every baseline on push/PR.

Design: [docs/DESIGN.md](docs/DESIGN.md). Self-compare and cross-version numbers
(including the default-option drift between tsc versions):
[docs/RESULTS.md](docs/RESULTS.md). Work is tracked in the
[maat](https://github.com/hax/maat/issues/6) repository.

## Quick start

Requirements: [Bun](https://bun.com) ≥ 1.3; a corpus checkout of
`microsoft/TypeScript`; the `tsc` binaries (installed as npm aliases, see
`package.json`).

```bash
bun install

# corpus: point at a checkout's tests/cases (matching the baseline's corpus tag)
export TSC_COMPA_CORPUS=/path/to/typescript/tests/cases

# self-compare for a baseline: tsc generates expectations AND acts as the implementation
bun src/run.ts --baseline 6.0.3 \
  --corpus "$TSC_COMPA_CORPUS" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# the same suite against another implementation (per-case CLI adapter)
MAAT_ZIG_BIN=/path/to/maat-zig \
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --adapter maat-zig
```

Runs write `.cache/run/metrics.json` and `.cache/run/details.json` and print a
summary:

```
tsc-compa smoke — 用例 28：跑 28，完全通过 28，跳过 0
假阳性 0 用例 / 0 条；覆盖 48/48 = 100.0%；漏报 0；错锚 0 用例 / 0 条（不计入 fp/miss）
分类 suite:compiler：跑 15，假阳性 0 例 / 0 条，覆盖 100.0%，错锚 0 条
分类 suite:conformance：跑 13，假阳性 0 例 / 0 条，覆盖 100.0%，错锚 0 条
口径：adapter=tsc-cli:node_modules/typescript-6-0/bin/tsc mode=official baseline=6.0.3 tsc=6.0.3
```

## Baselines

`config/baselines.json` pairs an npm-aliased `tsc` version with a corpus tag, a
default manifest and the base CLI args (e.g. 5.9 does not accept
`--ignoreConfig`):

| baseline | tsc | corpus | default manifest |
| --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `v5.9.3` tag | `config/smoke-cases-5.9.json` |
| `6.0.3` | `typescript-6-0` | strada `b465fdbf` | `config/smoke-cases.json` |
| `7.1.0-beta` | `typescript-7-1` | strada `b465fdbf` | `config/smoke-cases.json` |

Default compiler options differ between tsc versions (notably: 6.0/7.1 default
`strict` to true and target ES2015, 5.9 defaults them to false / ES5). Cross-
version comparisons must align these explicitly:

```bash
# 5.9 expectations vs 6.0.3 adapter, with defaults pinned on both sides
bun src/run.ts --baseline 5.9.3 --corpus /path/to/v5.9.3/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --base-arg strict=false --base-arg target=es2015
```

See [docs/RESULTS.md](docs/RESULTS.md) for what changes between baselines and why
these pins matter.

## Case classification

Every case is tagged (orthogonally) by `src/classify.ts` — e.g. `suite:compiler`,
`files:multi`, `lang:js`, `lang:jsx`, `shape:parser`, `options:module`,
`options:lib`, `options:emit`, `env:skip`, plus runtime tags `expect:syntax` and
`expect:no-errors`. Metrics include a `byClass` breakdown; tags overlap, so those
numbers must not be summed.

Filter with `--exclude-class a,b` / `--only-class`. Excluded cases are recorded
as SKIP with reason `类排除:<tag>` instead of silently disappearing.

Regenerate smoke manifests (class-filtered, syntax-error cases removed via the
baseline's tsc):

```bash
bun scripts/select-smoke.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --out config/smoke-cases.json
```

## Other adapters

`tsc-cli` (reference implementation, see [docs/RESULTS.md](docs/RESULTS.md)),
`none` (reports nothing), `mock-batch` (reference batch protocol, see
`src/adapters/mock-batch.ts`), `cli:<bin>` (generic per-case CLI; extra args via
`TSC_COMPA_CLI_ARGS`), `maat-zig` (per-case CLI, fixed option set).

`--mode fixed` ignores case directives and forces the adapter's fixed option
set, so its numbers are pipeline validation only. `--mode official` honors case
directives; a run is only a compatibility verdict (`verdictEligible`) when the
adapter also accepts external options.

## Layout

| path | what |
| --- | --- |
| `src/case.ts` | case directive parsing, virtual files, option derivation |
| `src/classify.ts` | orthogonal case tags + filtering |
| `src/baselines.ts` | baseline config (tsc × corpus tag) |
| `src/discover.ts` | corpus scanning and manifests |
| `src/tsc.ts` | expected diagnostics from a pinned tsc CLI (cached) |
| `src/compare.ts` | matching (incl. mis-anchor pairing) and metrics |
| `src/run.ts` | smoke runner entry |
| `src/adapters/` | reference `tsc-cli` adapter, per-case CLI adapter, batch protocol client, mock batch implementation |
| `config/baselines.json` | baseline definitions (three tsc versions × two corpora) |
| `config/smoke-cases*.json` | reproducible smoke case lists per corpus |
| `config/anchor-cases.json` | cases with known cross-version anchor differences |
| `scripts/select-smoke.ts` | regenerate class-filtered smoke case lists |
| `.github/workflows/smoke.yml` | CI: unit tests + self-compare smoke matrix |
| `docs/RESULTS.md` | self-compare, default drift and cross-version numbers |
| `test/` | unit tests (`bun test ./test`) |

## Licensing of the test corpus

The TypeScript compiler test suite (`microsoft/TypeScript`, `tests/cases` and
baselines) is licensed under Apache-2.0 and is consumed at CI time. This
repository's own code and data are Apache-2.0 as well; see [LICENSE](LICENSE)
and [NOTICE](NOTICE).
