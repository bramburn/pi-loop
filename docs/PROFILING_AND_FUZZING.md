# Profiling and fuzzing

pi-loop keeps performance measurements and generative tests separate from the ordinary unit-test contract. Local artifacts are written under `.artifacts/` and are not committed.

## Property tests and fuzz campaigns

The property suite uses [fast-check](https://fast-check.dev/) for generated inputs, shrinking, and deterministic replay.

```bash
npm run test:property
npm run test:fuzz
```

`test:property` uses a fixed default seed and bounded run counts, so it is stable enough for normal development. These tests also run as part of `npm test`. `test:fuzz` requests 10,000 randomized cases; filesystem properties cap their own runs to keep campaigns bounded.

Override the campaign size directly:

```bash
FC_NUM_RUNS=50000 npm run test:property
```

A failure reports a seed, path, and minimized counterexample. Replay that exact case with both values:

```bash
FC_SEED=24301 FC_PATH='0:0' npm run test:property
```

`FC_PATH` without `FC_SEED` is rejected because it is not a reproducible replay.

When a campaign fails:

1. Re-run the reported seed and path.
2. Decide whether the counterexample violates a public behavior or invariant.
3. Keep the generalized property.
4. Add the minimized example to the closest ordinary `test/*.test.ts` suite.
5. Make the production fix only after both tests are red.
6. Run the deterministic suite and a fresh randomized campaign.

Current properties cover cron field boundaries, reducer determinism and input immutability, workflow transitions and attempt limits, and file-backed task-store replay after every generated mutation.

## Benchmarks

Vitest benchmarks use fixed workloads, one worker, disabled file parallelism, and UTC:

```bash
npm run bench
npm run bench:baseline
npm run bench:compare
```

`bench:baseline` writes `.artifacts/benchmarks/baseline.json`. `bench:compare` compares a new run against that file. Create baselines and comparisons on the same machine, Node version, architecture, and power state with unrelated workloads stopped. Review mean, percentiles, sample count, and relative margin of error; do not gate on a single noisy percentage.

The shared workloads exercise:

- frequent, weekday, monthly, and leap-day cron searches;
- 1,000-event loop and task reducer streams;
- 1,000 workflow transitions;
- reads from loop and task stores near their normal bounds.

## CPU profiles

Generate a Chrome DevTools-compatible CPU profile and checksummed metadata:

```bash
npm run profile:core
PROFILE_ITERATIONS=25000 npm run profile:core
```

Outputs:

- `.artifacts/profiles/core.cpuprofile`
- `.artifacts/profiles/core.meta.json`

The metadata records Node version, architecture, platform, timezone, iteration count, per-workload duration, and checksums. Load `core.cpuprofile` in Chrome DevTools Performance or another V8 profile viewer. Compare profiles only when the metadata describes equivalent environments and checksums.

Benchmarks and CPU profiling import the same functions from `benchmarks/workloads.ts`. Change that shared file when adding a hot path so the statistical and call-stack evidence remain aligned.

## Validation matrix

Run the complete local gate after changing this infrastructure or fixing a generated counterexample:

```bash
npm run typecheck
npm run lint
npm test
npm run test:property
npm run test:fuzz
npm run bench:baseline
npm run bench:compare
npm run profile:core
npm run build
git diff --check
```

The strict development TypeScript config covers production source plus `test/property` and `benchmarks`. The larger historical test suite still runs through Vitest; its pre-existing standalone TypeScript debt is intentionally not hidden by weakening compiler options.
