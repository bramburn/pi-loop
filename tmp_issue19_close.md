## Implemented in f4a189b

### Problem

When a user had pre-existing bindings (from a previous session) and opened the Governor, toggling a new loop to arm and clicking Continue showed only `"Arm: #2"` — no mention of `#1` which was already armed. Users were alarmed, unsure whether their existing bindings were being silently disarmed.

### Fix

`buildDiffSummary` now shows currently-armed loops alongside pending changes:

```
Continue → Apply changes?
Armed: #1  (unchanged)
Arm: #2
```

Loops being disarmed are **excluded** from the "unchanged" list, so there's no confusion about what's actually changing.

### Before vs After

| Scenario | Before | After |
|---|---|---|
| #1 bound, arm #2 | `Arm: #2` | `Armed: #1  (unchanged)\nArm: #2` |
| #1 bound, disarm #1 | `Disarm: #1` | `Disarm: #1` (no Armed section — nothing unchanged) |
| #1 bound, no changes | `No changes.` | `No changes.` (unchanged) |
| No bindings, arm #1 | `Arm: #1` | `Arm: #1` (no Armed section — nothing unchanged) |

**Tests added:**
1. Diff shows `Armed: #1 (unchanged)` alongside `Arm: #2` when #1 is pre-bound
2. Diff shows only `Arm: #1` when no pre-existing bindings
3. Disarmed loops are excluded from the "unchanged" list

All 442 tests pass.

Closes #19.
