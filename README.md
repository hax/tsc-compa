# tsc-compa

An implementation-agnostic compatibility test suite for TypeScript type checkers.

This repository is not tied to any single implementation: given a TSC-compatible
checker shipped as a binary (or driven through an adapter), it runs the official
TypeScript test corpus against multiple tsc baselines and reports:

- **false positives** — diagnostics the implementation reports where tsc does not;
- **coverage** — officially expected diagnostics the implementation actually reports;
- **skips** — unsupported constructs, classified and explained rather than silently ignored.

The goal is to be able to *prove* near-100% compatibility for a checker, and to
run the same suite against any TSC-compatible implementation.

## Status

Bootstrap. The suite skeleton, adapter protocol and metrics are being designed;
see [docs/DESIGN.md](docs/DESIGN.md). Work is tracked in the
[maat](https://github.com/hax/maat/issues/6) repository.

## Licensing of the test corpus

The TypeScript compiler test suite (`microsoft/TypeScript`, `tests/cases` and
baselines) is licensed under Apache-2.0 and is consumed at CI time. This
repository's own code and data are Apache-2.0 as well; see [LICENSE](LICENSE)
and [NOTICE](NOTICE).
