# tsc-compa

An implementation-agnostic compatibility test suite for TypeScript type checkers.

This repository is not tied to any single implementation: given a TSC-compatible
checker shipped as a binary (or driven through an adapter), it runs the official
TypeScript test corpus against tsc baselines and reports:

- **false positives** — diagnostics the implementation reports where tsc does not;
- **coverage** — officially expected diagnostics the implementation actually reports;
- **skips** — unsupported constructs, classified and explained rather than silently ignored.

The goal is to be able to *prove* near-100% compatibility for a checker, and to
run the same suite against any TSC-compatible implementation.

## Status

v0 skeleton is in place (2026-11): case-directive parsing, tsc-generated
expectations with caching, a per-case CLI adapter and a batch-adapter protocol
(with reference implementation), and a smoke runner that emits fp/coverage/skip
metrics. Design and open questions: [docs/DESIGN.md](docs/DESIGN.md). Work is
tracked in the [maat](https://github.com/hax/maat/issues/6) repository.

## Quick start

Requirements: [Bun](https://bun.com) ≥ 1.3, one `tsc` binary to generate
expectations, and (optionally) the implementation under test.

```bash
# 1) corpus: a checkout of microsoft/TypeScript; point at its tests/cases
export TSC_COMPA_CORPUS=/path/to/typescript/tests/cases

# 2) expectation generator: any recent tsc (7.1.0-beta here)
export TSC_BIN=/path/to/typescript-7.1.0-beta/bin/tsc

# 3) implementation under test: per-case CLI adapter (maat-zig example)
export MAAT_ZIG_BIN=/path/to/maat-zig

# smoke run: fixed options (pipeline validation only, not a compatibility verdict)
bun src/run.ts --adapter maat-zig --mode fixed --cases config/smoke-cases.json

# the target mode: honor the official case directives
bun src/run.ts --adapter maat-zig --mode official

# unit tests
bun test
```

Runs write `.cache/run/metrics.json` and `.cache/run/details.json`, and print a
summary:

```
tsc-compa smoke — 用例 30：跑 28，完全通过 21，跳过 2
假阳性 2 用例 / 2 条；覆盖 28/41 = 68.3%；漏报 13；错锚 0
top fp：TS2339×2
top miss：TS2300×5 TS2564×3 TS2769×2 TS2322×1 TS2552×1 TS2565×1
skip：tsc 语法解析失败×2
口径：adapter=maat-zig mode=fixed tsc=7.1.0-beta（本次运行不能作为兼容性结论）
```

`--mode fixed` ignores case directives and forces the adapter's fixed option
set, so its numbers are for pipeline validation only. `--mode official` honors
case directives; a run is only a compatibility verdict (`verdictEligible`) when
the adapter also accepts external options.

Other adapters: `none` (reports nothing), `mock-batch` (reference batch
protocol, see `src/adapters/mock-batch.ts`), `cli:<bin>` (generic per-case CLI;
extra args via `TSC_COMPA_CLI_ARGS`).

Regenerate the smoke manifest from a corpus checkout:

```bash
bun scripts/select-smoke.ts --corpus "$TSC_COMPA_CORPUS"
```

## Layout

| path | what |
| --- | --- |
| `src/case.ts` | case directive parsing, virtual files, option derivation |
| `src/discover.ts` | corpus scanning and manifests |
| `src/tsc.ts` | expected diagnostics from a pinned tsc CLI (cached) |
| `src/compare.ts` | matching and metrics |
| `src/run.ts` | smoke runner entry |
| `src/adapters/` | per-case CLI adapter, batch protocol client, mock batch implementation |
| `config/smoke-cases.json` | reproducible smoke case list |
| `scripts/select-smoke.ts` | regenerate the smoke case list |
| `test/` | unit tests (`bun test`) |

## Licensing of the test corpus

The TypeScript compiler test suite (`microsoft/TypeScript`, `tests/cases` and
baselines) is licensed under Apache-2.0 and is consumed at CI time. This
repository's own code and data are Apache-2.0 as well; see [LICENSE](LICENSE)
and [NOTICE](NOTICE).
