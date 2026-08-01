const DEFAULT_SEED = 0x5eed;

function readPositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function propertyOptions(defaultNumRuns = 100, maxNumRuns = Number.MAX_SAFE_INTEGER) {
  const configuredRuns = readPositiveInteger("FC_NUM_RUNS", process.env.FC_NUM_RUNS);
  const configuredSeed = readPositiveInteger("FC_SEED", process.env.FC_SEED);
  const path = process.env.FC_PATH;
  if (path !== undefined && configuredSeed === undefined) {
    throw new Error("FC_PATH requires FC_SEED for deterministic replay");
  }

  return {
    numRuns: Math.min(configuredRuns ?? defaultNumRuns, maxNumRuns),
    ...(configuredRuns === undefined || configuredSeed !== undefined
      ? { seed: configuredSeed ?? DEFAULT_SEED }
      : {}),
    ...(path === undefined ? {} : { path }),
  };
}
