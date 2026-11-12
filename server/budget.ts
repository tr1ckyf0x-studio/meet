/** A rolling 24-hour allowance (e.g. emails per day), kept in memory: a restart only resets it. */
export class DailyBudget {
  private spent: { at: number; n: number }[] = [];
  constructor(private readonly limit: number, private readonly now: () => number = Date.now) {}

  /** Takes n units if they fit in the last 24 hours' allowance. */
  take(n = 1): boolean {
    const t = this.now();
    this.spent = this.spent.filter((x) => x.at > t - 86_400_000);
    const used = this.spent.reduce((a, x) => a + x.n, 0);
    if (used + n > this.limit) return false;
    this.spent.push({ at: t, n });
    return true;
  }
}
