/**
 * Per-loop and per-session cost ledger for sub-agent iterations.
 *
 * Tracks token usage and USD cost across all iterations of every sub-agent
 * loop in this session. Source of truth for the `/loop-cost` report and
 * for the token-budget gate in `scheduler.ts`.
 *
 * Prices are looked up by model name from a small hard-coded table; unknown
 * models default to $0 (the cost is unknown rather than zero — surfaced as
 * `costUsd: 0` in the result). For production accuracy, callers should
 * supply a price table via `setModelPrice()`.
 */

export interface TokenUsage {
  in: number;
  out: number;
}

const DEFAULT_PRICE_TABLE: Record<string, { in: number; out: number }> = {
  // USD per 1k tokens. Source: typical public pricing as of 2026-08.
  "claude-opus-4-1": { in: 0.015, out: 0.075 },
  "claude-sonnet-4-5": { in: 0.003, out: 0.015 },
  "claude-haiku-4-5": { in: 0.0008, out: 0.004 },
  "gpt-4o": { in: 0.0025, out: 0.01 },
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "o1": { in: 0.015, out: 0.06 },
  "o1-mini": { in: 0.003, out: 0.012 },
};

export class CostTracker {
  private modelPrices: Record<string, { in: number; out: number }> = { ...DEFAULT_PRICE_TABLE };
  /** loopId -> cumulative { in, out, costUsd, iterations } */
  private perLoop = new Map<string, { in: number; out: number; costUsd: number; iterations: number }>();
  /** sessionId -> cumulative { in, out, costUsd, iterations } */
  private perSession = new Map<string, { in: number; out: number; costUsd: number; iterations: number }>();

  setModelPrice(model: string, price: { in: number; out: number }): void {
    this.modelPrices[model] = price;
  }

  priceFor(model?: string): { in: number; out: number } {
    if (!model) return { in: 0, out: 0 };
    return this.modelPrices[model] ?? { in: 0, out: 0 };
  }

  /**
   * Compute the USD cost for a single iteration given its model and tokens.
   * Tokens are in "raw" units (not thousands); we scale by 1/1000 below.
   */
  computeCost(model: string | undefined, tokens: TokenUsage): number {
    const price = this.priceFor(model);
    return (tokens.in / 1000) * price.in + (tokens.out / 1000) * price.out;
  }

  record(loopId: string, sessionId: string, model: string | undefined, tokens: TokenUsage): number {
    const cost = this.computeCost(model, tokens);
    this.addTo(loopId, this.perLoop, tokens, cost);
    this.addTo(sessionId, this.perSession, tokens, cost);
    return cost;
  }

  private addTo(key: string, map: Map<string, { in: number; out: number; costUsd: number; iterations: number }>, tokens: TokenUsage, cost: number): void {
    const existing = map.get(key) ?? { in: 0, out: 0, costUsd: 0, iterations: 0 };
    map.set(key, {
      in: existing.in + tokens.in,
      out: existing.out + tokens.out,
      costUsd: existing.costUsd + cost,
      iterations: existing.iterations + 1,
    });
  }

  loopReport(loopId: string): { in: number; out: number; total: number; costUsd: number; iterations: number } {
    const r = this.perLoop.get(loopId) ?? { in: 0, out: 0, costUsd: 0, iterations: 0 };
    return { ...r, total: r.in + r.out };
  }

  sessionReport(sessionId: string): { in: number; out: number; total: number; costUsd: number; iterations: number } {
    const r = this.perSession.get(sessionId) ?? { in: 0, out: 0, costUsd: 0, iterations: 0 };
    return { ...r, total: r.in + r.out };
  }
}
