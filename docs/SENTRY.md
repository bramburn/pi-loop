# Sentry Integration Plan

> Status: **implementation complete on `feat/sentry-crash-analytics`** — this document is the design record and the PR description.

## 1. Why

`@bramburn/pi-loop` is published as an npm package consumed by users running the `pi` coding agent. Today, when a tool throws or a runtime hook misbehaves, the failure is silent: the user sees an error in the chat, but the maintainer has no visibility into the failure mode, frequency, or stack trace.

Crash analytics gives us:

- **Visibility** into real-world failure modes (uncaught exceptions, unhandled rejections, tool errors)
- **Log capture** for the existing `debug(...)` output without needing every user to enable verbose logging
- **Performance baseline** for tool execution paths via OpenTelemetry-style transactions
- **Breadcrumb trail** of `session_switch`, `loop_fire`, and tool entry for post-mortem debugging

## 2. Provider choice

| Option | Why considered | Why rejected |
|---|---|---|
| **Sentry** (chosen) | Industry standard, mature Node SDK, OSS sponsorship tier. `Sentry.logger` (v8.40+) for log capture. `beforeSend` for PII scrubbing. | — |
| Highlight.io | Modern, OSS-friendly, includes session replay | Smaller community, less pi-loop-shaped (session replay is web-centric) |
| GlitchTip | Self-hosted Sentry-API-compatible, fully free | We don't want to maintain a server; the OSS sponsorship tier solves this for free |
| Rollbar / Bugsnag | Established OSS plans | Smaller ecosystem, less Node.js-specific tooling |

**Sentry's Sentry for Open Source program** grants the project a free, full-featured plan with an error-volume cap that won't apply to a single-extension package. Application is at <https://sentry.io/for/open-source/>.

## 3. Scope

| Captured | Source | Rationale |
|---|---|---|
| **Uncaught exceptions** | `process.on("uncaughtException")` | Auto-flush + exit so we don't lose the crash |
| **Unhandled rejections** | `process.on("unhandledRejection")` | Catch silent async failures |
| **Tool errors** | `wrapToolExecute` wrapper around every `pi.registerTool` call | Catches errors that the tool framework would otherwise convert to a generic "tool failed" message |
| **Breadcrumbs** | `session_switch`, `loop_fire`, `tool:<name>` | Context for post-mortem debugging |
| **Structured logs** | `debug(...)` output piped to `Sentry.logger` | Captures the existing diagnostic output without sprinkling a new logger everywhere |
| **Performance traces** | `tracesSampleRate: 0.1` (10%) | Smoke-level coverage of the tool execution hot path |

**Out of scope for v1:** source-map upload via auth tokens, server-side PII rules (rely on Sentry's defaults), CI integration.

## 4. Architecture

```
src/telemetry/
├── sentry.ts          # initSentry, captureException, addBreadcrumb, log*, scrubPii, wrapToolExecute
└── index.ts           # Public re-exports

src/index.ts           # Calls initSentry() at module load; monkey-patches pi.registerTool
                       # to wrap every registered tool's execute() with wrapToolExecute
src/runtime/session-runtime.ts       # addBreadcrumb("session_switch", { reason })
src/runtime/notification-runtime.ts  # addBreadcrumb("loop_fire", { loopId, trigger })
```

The `pi.registerTool` wrap is a single point of interception — none of the 14 tool registrations in `src/tools/*.ts` need per-call try/catch boilerplate. The wrap re-throws so the tool framework still sees the original error.

## 5. PII scrubbing

A `beforeSend` hook (and `beforeBreadcrumb`, `beforeSendLog`) runs every event through `scrubPii`. The redactor:

- **Path strings**: `C:\Users\alice\file` → `[redacted]`, `/home/bob/secret` → `[redacted]`
- **Env references**: `process.env.API_KEY` → `[redacted]`
- **Sentry DSN literals**: `https://abc123@o123.ingest.us.sentry.io/1234567` → `[redacted]` (defense-in-depth)
- **Sensitive key values**: any string value under keys `prompt`, `message`, `text`, `body`, `content`, `description` → `[redacted]`
- **Stack frame fields**: `filename`, `abs_path` → `[redacted]`

The redactor preserves shape (so the event is still useful for debugging) without leaking content. Layered with Sentry's server-side scrubbing rules as a safety net.

## 6. Env var matrix

| Var | Default | Purpose |
|---|---|---|
| `SENTRY_DSN` | unset | Opt-in. Leave unset to disable telemetry entirely. |
| `SENTRY_ENVIRONMENT` | `development` | Environment tag. |
| `SENTRY_RELEASE` | `@bramburn/pi-loop@<pkg-version>` | Version tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Perf sample rate. |
| `SENTRY_DEBUG` | `false` | SDK debug logging. |
| `SENTRY_CAPTURE_LOGS` | `true` | Pipe `debug()` output into Sentry logs. |

Documented in `.env.example`. Never commit a real DSN.

## 7. Deployment story

- **No production deploy of this package** — it's installed by users via `npm install`.
- **No DSN baked into source.** Each user opts in with their own DSN (or borrows the OSS sponsorship DSN once approved).
- **CI workflows** (`ci.yml`, `release.yml`) don't need Sentry credentials — the SDK is mocked in tests.
- **No GitHub Actions secret** needs to be created for v1.

## 8. Test plan

`test/telemetry/sentry.test.ts` uses `vi.mock("@sentry/node")` to verify:

- `initSentry()` is a no-op when `SENTRY_DSN` is unset
- `initSentry()` calls `Sentry.init` with the DSN when set
- `captureException` / `addBreadcrumb` / `logInfo` / `logWarn` / `logError` / `logDebug` are no-ops when uninitialized
- All Sentry forwarding helpers delegate correctly when initialized
- `scrubPii` strips paths, env refs, DSNs, and sensitive key values
- `wrapToolExecute` adds a breadcrumb, captures errors, and re-throws
- `flushSentry` no-ops when uninitialized

22 tests, all passing.

## 9. Open follow-ups

- [ ] Apply for Sentry for Open Source at <https://sentry.io/for/open-source/>
- [ ] Once approved, publish the project DSN in `README.md` so users can opt in by copying it
- [ ] Consider adding a `SENTRY_RELEASE` injection via `release-please` so the release tag is automatic
- [ ] If a CI smoke test is ever added against a real Sentry project, that'll need a GitHub Actions secret
