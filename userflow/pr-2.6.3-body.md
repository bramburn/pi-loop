## Summary

Three related fixes for sub-agent spawning in `src/runtime/sub-agent/spawn.ts`:

1. **PATHEXT-aware spawn resolution** — `child_process.spawn('pi', args)` does not consult PATHEXT on Windows, so the nvm4w npm-bin PowerShell shim (`C:\nvm4w\nodejs\pi.ps1`) fails with ENOENT even when `pi` is on PATH. New `resolveSpawnTarget(bin)` helper dispatches by extension: `.ps1` is wrapped in `powershell.exe -File`, `.cmd`/`.bat` use `shell: true`, `.exe` is direct; bare names are resolved via `where.exe` with PATHEXT-aware ranking. Cached per `bin`.

2. **uncaughtException guard** — `handle.wait()` only listened to the child's `'exit'` event. Node emits EITHER `'exit'` OR `'error'` (e.g. ENOENT, EACCES), never both — so a spawn failure escaped the watcher, became an uncaughtException on the parent (`Error: spawn pi ENOENT` at `process.processTicksAndRejections`), and killed the user's pi session. `SpawnHandle` now exposes `lastError` and the wait/settle promise is shared between `'error'` and `'exit'`; the watcher finalises the iteration as `failed` with the real error text in `result.json` instead of crashing the parent.

3. **Windows kill-tree** — with `shell: true` for `.cmd`/`.bat` or `powershell.exe` wrapping for `.ps1`, the actual pi is a grandchild of `child.pid`. `child.kill()` only terminated the immediate child, so the timer-fired two-stage kill (SIGTERM at T-30s, SIGKILL at T) could leave the real pi running. `handle.kill` now uses `taskkill /PID <pid> /T /F` on Windows.

## Test plan

- [x] `npm run test:all` — 1019 passed, 33 skipped (was 1010 on v2.6.2; +9 new cases)
- [x] `npm run typecheck` — clean
- [x] `npm run lint` — clean
- [x] `npm run build` — clean
- [x] `npm pack --dry-run` — 276 files, 555 kB unpacked; `wt/`, `node_modules/`, `test/`, `.github/` confirmed absent from tarball

## Reproduction (before this fix)

In a Windows session with pi-loop loaded, a sub-agent loop fire produces:

```
pi exiting due to uncaughtException:
Error: spawn pi ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:285:19)
    at onErrorNT (node:internal/child_process:483:16)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  errno: -4058,
  code: 'ENOENT',
  syscall: 'spawn pi',
  path: 'pi',
  spawnargs: [
    '--session-file', 'c:\\dev\\CloudCompare\\.pi\\loops\\sub-agent-results\\2\\iter-1\\session.jsonl',
    '--prompt', '@c:\\dev\\CloudCompare\\.pi\\loops\\sub-agent-results\\2\\iter-1\\prompt.txt',
    '--non-interactive',
    '--no-extensions',
    '--max-duration-ms', '600000'
  ]
}
```

After the fix, the same fire resolves to `C:\nvm4w\nodejs\pi.cmd` (or `.ps1` via `powershell.exe -File`) and the iteration finalises normally.

Refs: v2.6.2 release `a709f7c` (the first-pass PATHEXT fix landed as `af4d869` before this PR; this is the full hardening).
