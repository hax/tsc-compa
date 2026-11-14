# Design (work in progress)

Open items being worked out:

1. **Adapter protocol** — how an implementation is driven: a batch mode that
   consumes many cases in one process and emits a JSON stream of diagnostics
   (avoiding per-case process startup), or an API adapter when the
   implementation is itself JS/TS.
2. **Case semantics** — honor the official case directives (`@strict`,
   `@target`, `@lib`, …) instead of re-pinning every case to one option set.
3. **Expectation source** — generate expected diagnostics by running a pinned
   tsc version in-process, and/or consume the official baselines; decide per
   tsc baseline (5.9.x / 6.0.3 / 7.1.0-beta).
4. **Metrics** — false-positive count, coverage/hit count, skip classification,
   per-tsc-version breakdown, and comparison granularity (code / position / message).
5. **Binary distribution** — binaries are built by the private maat repository,
   published as release assets here, and run by this suite's workflows.
