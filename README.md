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

v1 (2026-11): case-directive parsing; two expectation sources (tsc-generated and cached,
official `tests/baselines` subset via `--expectation-source official-baseline`);
case classification/filtering; three tsc baselines (5.9.3 / 6.0.3 / 7.1.0-beta,
each paired with its own corpus tag in `config/baselines.json`) whose base args
explicitly encode the official harness defaults; a per-case CLI adapter plus a
batch-adapter protocol (with reference implementation); and a
**reference adapter that runs real `tsc`** (`--adapter tsc-cli`, used to
self-check the harness). Metrics cover false positives, coverage, mismatched
anchors and per-class breakdowns. For the official TypeScript 7 repository
layout (`tsc/testdata/...`) the suite consumes the official `.errors.txt`
baselines directly, grades every case on the T0–T3 agreement ladder
(location → category → text → whole-baseline-bytes) and maintains a
`--ratchet` list that only goes up (per implementation × baseline). A GitHub Actions workflow runs unit tests
plus a self-compare smoke for every baseline on push/PR, and a manually
triggered workflow runs the TS7 official-baseline smoke.

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

# expectations from the official .errors.txt baselines (curated subset)
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --expectation-source official-baseline --cases config/official-baseline-cases.json --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# TS7 official baselines (Go repo layout, T0-T3 + ratchet)
export TSC_COMPA_CORPUS=/path/to/typescript-go/tsc/testdata/tests/cases
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TSC_COMPA_CORPUS" \
  --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet-impl tsc-7-1 \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc

# the same suite against another implementation (per-case CLI adapter)
MAAT_BIN=/path/to/maat \
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --adapter maat-batch
# 对照：同样的二进制用逐案 CLI 模式
MAAT_ZIG_BIN=/path/to/maat bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --adapter maat-zig
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
| `7.1.0-beta-official` | `typescript-7-1` | TS7 Go pin `aa814927` | `config/smoke-cases-ts71-official.json` |

Each baseline's `baseArgs` explicitly encode the **official harness defaults**
(see `docs/DESIGN.md` section 3.3): 5.9 -> target ES5 / module CommonJS /
moduleResolution Node10 / strict off; 6.0 -> target ES2025 / module ES2022 /
moduleResolution Bundler / strict on; 7.1 -> target ES2026 / same module settings /
strict on. These defaults apply to the **expectation side only** - the adapter
receives case directives plus any explicit `--base-arg` / `--adapter-arg`, so it
uses its own defaults. Cross-version comparisons must align options explicitly
when you want to isolate semantic differences:

```bash
# 5.9 expectations vs 6.0.3 adapter, with defaults pinned on both sides
bun src/run.ts --baseline 5.9.3 --corpus /path/to/v5.9.3/tests/cases --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --base-arg strict=false --base-arg target=es2015 --base-arg module=es2015 --base-arg moduleResolution=bundler
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
`TSC_COMPA_CLI_ARGS`), `maat-zig` (per-case CLI, fixed option set), `maat-batch`
(batch NDJSON mode of the same binary, `MAAT_BIN`/`MAAT_ZIG_BIN`).

`--mode fixed` ignores case directives and forces the adapter's fixed option
set, so its numbers are pipeline validation only. `--mode official` honors case
directives; a run is only a compatibility verdict (`verdictEligible`) when the
adapter also accepts external options.

## Third-party implementations

Any checker that ships a tsc-compatible CLI can be driven through the existing
`tsc-cli` adapter — no internal adapter is written for it. Acquisition (npm
prebuilt / cargo build / local binary), fixed CLI args, upstream pin and phase
metrics are registered in [`config/implementations.json`](config/implementations.json):

```bash
# fetch the implementation per its registry entry and print the binary path
BIN=$(bun scripts/install-impl.ts --name tsrs --dest .tools | tail -1)

# run the same smoke suite against it on the TS7 official baselines
TSC_COMPA_ADAPTER_ARGS="--singleThreaded" \
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /tmp/ts71-corpus/tsc/testdata/tests/cases \
  --adapter "tsc-cli:$BIN" --mode official \
  --expectation-source official-baseline \
  --ratchet-impl "$IMPL"
```

`.github/workflows/third-party.yml` does the same on CI (manual dispatch,
implementation × baseline). Current results: `tsrs` 28/28, 0 false positives,
100% coverage on both the TS7 official baselines and the strada 7.1 baseline
(see [docs/RESULTS.md](docs/RESULTS.md)).

## Layout

| path | what |
| --- | --- |
| `src/case.ts` | case directive parsing, virtual files, option derivation |
| `src/classify.ts` | orthogonal case tags + filtering |
| `src/baselines.ts` | baseline config (tsc × corpus tag) |
| `src/discover.ts` | corpus scanning and manifests |
| `src/tsc.ts` | expected diagnostics from a pinned tsc CLI (cached) |
| `src/officialBaseline.ts` | expectation source reading official `.errors.txt` baselines (strada flat layout + TS7 Go layout incl. flattened suites; missing baseline = no errors) |
| `src/compare.ts` | matching (incl. mis-anchor pairing), T0-T3 agreement ladder and metrics |
| `src/ratchet.ts` | `--ratchet` / `--ratchet-impl` lists: only go up, regression fails the run (per implementation × baseline) |
| `src/run.ts` | smoke runner entry |
| `src/adapters/` | reference `tsc-cli` adapter, per-case CLI adapter, batch protocol client, mock batch implementation |
| `config/baselines.json` | baseline definitions (three tsc versions × two corpora) |
| `config/implementations.json` | third-party implementation registry (acquisition, CLI args, pins) |
| `config/smoke-cases*.json` | reproducible smoke case lists per corpus |
| `config/anchor-cases.json` | cases with known cross-version anchor differences |
| `config/official-baseline-cases.json` | sample case list consumable from official baselines |
| `config/smoke-cases-ts71-official.json` | TS7 official-baseline smoke list (18 error cases + 10 clean) |
| `config/official-baseline-cases-ts71.json` | 120 error-bearing TS7 cases (extended local sample) |
| `config/ratchet/` | per-implementation T0–T3 ratchet lists (`<impl>-<baseline>.tsv`); `config/ratchet-ts71-official.tsv` is the legacy shared list |
| `scripts/select-smoke.ts` | regenerate class-filtered smoke case lists |
| `scripts/select-official-baseline-cases.ts` | scan a corpus for cases consumable from official baselines |
| `scripts/install-impl.ts` | fetch a third-party implementation per its registry entry |
| `.github/workflows/smoke.yml` | CI: unit tests + self-compare smoke matrix |
| `.github/workflows/ts7-official.yml` | manual CI: TS7 official-baseline smoke (T0–T3 + ratchet) |
| `.github/workflows/third-party.yml` | manual CI: third-party implementation × baseline smoke |
| `docs/RESULTS.md` | self-compare, default drift and cross-version numbers |
| `src/perf.ts` | optional performance appendix: fixed sample × official tsc reference ratio |
| `test/` | unit tests (`bun test ./test`) |

## Optional performance appendix

`--perf-ratio` adds a performance *appendix* to a normal compatibility run. It does
not change pass/fail: the implementation's per-case wall time is recorded for free
during the usual run, and a fixed stratified sample (default 300 cases) is run once
through the official tsc with `--extendedDiagnostics` to produce a same-run ratio.

```bash
bun src/run.ts --baseline 7.1.0-beta-official --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json --adapter maat:<bin> --perf-ratio
```

The reference tsc runs on a fixed stratified sample (suite × lines bucket × expected-errors,
default 300 cases, `--perf-sample`), each case once per side, with half of the sample
reference-first and half implementation-first. The headline ratio is the accumulated
Check phase when both sides report `--extendedDiagnostics`; otherwise wall-adjusted by an
empty-program baseline (guarded to null when the reference's fixed cost dominates). Numbers
are written to `metrics.json` under `perf`; see `docs/DESIGN.md §11` for the caveats.

## Licensing of the test corpus

The TypeScript compiler test suite (`microsoft/TypeScript`, `tests/cases` and
baselines) is licensed under Apache-2.0 and is consumed at CI time. This
repository's own code and data are Apache-2.0 as well; see [LICENSE](LICENSE)
and [NOTICE](NOTICE).
