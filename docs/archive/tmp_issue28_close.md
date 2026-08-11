## Implemented in 26d8f47

### Problem

The Continue dialog (`ui.confirm("Apply changes?", diff)`) only showed loop IDs in pending arm/disarm lines:
```
Arm: #5, #9
Disarm: #7
```
Users with many loops couldn't tell which loop was which just from the ID.

### Fix

`buildDiffSummary` now shows the loop prompt alongside each pending change:
```
Continue → Apply changes?
Armed: #1  (unchanged)
Arm:
  #5 Check the deploy
  #9 Monitor errors
Disarm:
  #7 Nightly reminder
Warning: #2 is PAUSED — won't fire until resumed.
```

Each pending change is on its own indented line with the full prompt, so users can tell exactly what they are arming/disarming.

### Visual outcome

**Before:**
```
Arm: #5, #9
Disarm: #7
```

**After:**
```
Arm:
  #5 Check the deploy
  #9 Monitor errors
Disarm:
  #7 Nightly reminder
```

All 444 tests pass.

Closes #28.
