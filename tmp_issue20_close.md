## Implemented in 23ea393

### Changes

**Visual indicator — `buildGovernorRows`**

Paused loops now get a `~` suffix after the checkbox so the paused state is visible at a glance:

```
[x]~ #3 [paused] Old nightly check (cron: 0 9 * * *)
[ ]~ #3 [paused] Old nightly check (cron: 0 9 * * *)   ← unbound + paused
[x]  #1 [active] Check the deploy (cron: */5 * * * *)   ← active, no marker
```

**Warning on arm — toggle handler in `openGovernor`**

When the user toggles a paused loop ON (arms it), a warning is emitted immediately:

> `Loop #3 is paused — it won't fire until resumed. Run /loop to view loops and resume it.`

The binding is still applied (the user may have intentionally armed it to have it ready when they resume it), but they now know it won't fire until they explicitly resume it.

**Tests added**
1. `~` suffix on paused rows in Governor
2. Warning notification on arming paused loop
3. No warning on arming active (non-paused) loop

All 439 tests pass.

### Visual outcome

**Before:**
```
[x] #3 [paused] Old nightly check
```
User has no indication why their loop isn't firing.

**After:**
```
[x]~ #3 [paused] Old nightly check
Warning: Loop #3 is paused — it won't fire until resumed.
```
User knows exactly why the loop isn't firing and what to do.

Closes #20.
