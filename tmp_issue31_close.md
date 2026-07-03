## Implemented in a18ea1d

### Problem

The Continue dialog (`ui.confirm("Apply changes?", diff)`) shows pending arm/disarm changes but gives no warning when a paused loop is pending arm. The warning only appeared as an immediate notification after toggling the row — it disappeared after the picker re-rendered.

### Fix

`buildDiffSummary` now checks each pending arm entry's status against the store and appends a warning to the diff:

```
Apply changes?
Arm: #2
Warning: #2 is PAUSED — won't fire until resumed.
```

For multiple paused loops:
```
Warning: #1, #2 are PAUSED — won't fire until resumed.
```

### Before vs After

**Before (Continue dialog):**
```
Apply changes?
Arm: #2
```
User has no idea #2 is paused.

**After (Continue dialog):**
```
Apply changes?
Arm: #2
Warning: #2 is PAUSED — won't fire until resumed.
```
User sees the warning right before confirming.

### Tests added
1. Single paused loop pending arm → warning with "is PAUSED"
2. Multiple paused loops pending arm → warning with "are PAUSED"

All 444 tests pass.

Closes #31.
