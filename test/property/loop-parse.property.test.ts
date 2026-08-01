import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cronToNextFire, isValidCronExpression } from "../../src/loop-parse.js";
import { propertyOptions } from "./config.js";

describe("cron properties", () => {
  it("finds a later minute aligned with generated step schedules", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 59 }),
        fc.date({
          min: new Date(2025, 0, 1),
          max: new Date(2030, 0, 28, 23, 59, 59),
          noInvalidDate: true,
        }),
        (step, from) => {
          const originalTime = from.getTime();
          const next = cronToNextFire(`*/${step} * * * *`, from);

          expect(next).not.toBeNull();
          expect(from.getTime()).toBe(originalTime);
          expect(next?.getTime()).toBeGreaterThan(originalTime);
          expect(next?.getSeconds()).toBe(0);
          expect(next?.getMilliseconds()).toBe(0);
          expect((next?.getMinutes() ?? -1) % step).toBe(0);
          expect((next?.getTime() ?? 0) - originalTime).toBeLessThanOrEqual(step * 60_000);
        },
      ),
      propertyOptions(),
    );
  });

  it("matches generated exact calendar fields", () => {
    fc.assert(
      fc.property(
        fc.record({
          year: fc.integer({ min: 2025, max: 2030 }),
          day: fc.integer({ min: 1, max: 28 }),
          hour: fc.integer({ min: 0, max: 23 }),
          minute: fc.integer({ min: 1, max: 59 }),
        }),
        ({ year, day, hour, minute }) => {
          const from = new Date(year, 0, day, hour, minute - 1, 30, 0);
          const next = cronToNextFire(`${minute} ${hour} ${day} 1 *`, from);

          expect(next).toEqual(new Date(year, 0, day, hour, minute, 0, 0));
        },
      ),
      propertyOptions(),
    );
  });

  it("anchors generated day-of-month wildcard steps at day one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 27 }), (step) => {
        const year = 2026;
        const from = new Date(year, 0, 1, 0, 1, 0, 0);
        const next = cronToNextFire(`0 0 */${step} * *`, from);

        expect(next).toEqual(new Date(year, 0, step + 1, 0, 0, 0, 0));
      }),
      propertyOptions(20, 100),
    );
  });

  it("anchors generated month wildcard steps at January", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 11 }), (step) => {
        const year = 2026;
        const from = new Date(year, 0, 1, 0, 1, 0, 0);
        const next = cronToNextFire(`0 0 1 */${step} *`, from);

        expect(next).toEqual(new Date(year, step, 1, 0, 0, 0, 0));
      }),
      propertyOptions(10, 50),
    );
  });

  it("rejects generated out-of-range fields", () => {
    const invalidField = fc.oneof(
      fc.integer({ min: -100, max: -1 }).map((value) => `${value} * * * *`),
      fc.integer({ min: 60, max: 200 }).map((value) => `${value} * * * *`),
      fc.integer({ min: 24, max: 200 }).map((value) => `0 ${value} * * *`),
      fc.integer({ min: 32, max: 200 }).map((value) => `0 0 ${value} * *`),
      fc.integer({ min: 13, max: 200 }).map((value) => `0 0 1 ${value} *`),
      fc.integer({ min: 7, max: 200 }).map((value) => `0 0 * * ${value}`),
    );

    fc.assert(
      fc.property(invalidField, (expression) => {
        expect(isValidCronExpression(expression)).toBe(false);
      }),
      propertyOptions(),
    );
  });
});
