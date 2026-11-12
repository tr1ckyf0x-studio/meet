import { clip, type Iv } from "../../shared/intervals";
import { addDays, DAY, MIN, startOfDay } from "../../shared/time";
import type { Sealer } from "../crypto";
import type { Connection, Store } from "../db";
import { caldavBusy, type CaldavSecret } from "./caldav";
import { FetchError, type GuardOptions } from "./fetchguard";
import { icsBusy, type IcsSecret } from "./icsurl";
import { providerBusy, refreshAccess, type OAuthApp, type OAuthSecret, type Provider } from "./oauth";

export const SYNC_STALE = 30 * MIN;
export const SYNC_ON_VIEW = 10 * MIN;

export interface SyncDeps {
  store: Store;
  sealer: Sealer;
  guard: GuardOptions;
  apps: Partial<Record<Provider, OAuthApp>>;
  now: () => number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/** The span worth fetching for a user: the ranges of their groups, from a week ago at most to 400 days ahead. */
export function syncWindow(store: Store, userId: string, now: number): [number, number] {
  const groups = store.groupsOfUser(userId);
  if (!groups.length) return [now - DAY, now + 60 * DAY];
  let lo = Infinity, hi = -Infinity;
  for (const g of groups) {
    lo = Math.min(lo, startOfDay(g.rangeStart, g.tz));
    hi = Math.max(hi, startOfDay(addDays(g.rangeEnd, 1), g.tz));
  }
  lo = Math.max(lo - DAY, now - 7 * DAY);
  hi = Math.min(Math.max(hi + DAY, lo + DAY), now + 400 * DAY);
  return [lo, hi];
}

export class Syncer {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: SyncDeps) {}

  /** Refreshes one connection. Concurrent calls for the same connection share one run. */
  sync(id: string): Promise<void> {
    const cur = this.running.get(id);
    if (cur) return cur;
    const p = this.run(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Starts a refresh, without waiting, of the connections older than `staleMs`. */
  kick(conns: Connection[], staleMs = SYNC_ON_VIEW): void {
    const now = this.d.now();
    for (const c of conns) if (!c.syncedAt || c.syncedAt < now - staleMs) void this.sync(c.id);
  }

  /** The periodic job. Two app instances may run it at once during a deploy; that only repeats work. */
  async tick(limit = 20): Promise<void> {
    for (const c of this.d.store.connectionsDue(this.d.now() - SYNC_STALE, limit)) await this.sync(c.id);
  }

  private async run(id: string): Promise<void> {
    const { store } = this.d;
    const c = store.getConnection(id);
    if (!c) return;
    const user = store.getUser(c.userId);
    if (!user) return;
    const now = this.d.now();
    const [lo, hi] = syncWindow(store, c.userId, now);
    try {
      const busy = await this.fetchBusy(c, lo, hi, user.tz);
      if (!store.getConnection(id)) return; // deleted meanwhile
      store.replaceBusy(id, clip(busy, lo, hi));
      store.updateConnection(id, { status: "ok", error: null, syncedAt: this.d.now() });
    } catch (e) {
      const code = e instanceof FetchError ? e.code : "failed";
      this.d.log?.(`sync ${id} (${c.kind}) failed: ${code}${e instanceof FetchError ? "" : ` ${String((e as Error)?.message ?? e).slice(0, 200)}`}`);
      if (store.getConnection(id)) store.updateConnection(id, { status: "error", error: code, syncedAt: this.d.now() });
    }
    store.bumpRevForUser(c.userId);
  }

  private async fetchBusy(c: Connection, lo: number, hi: number, tz: string): Promise<Iv[]> {
    const { sealer, guard } = this.d;
    switch (c.kind) {
      case "caldav": return caldavBusy(sealer.open<CaldavSecret>(c.secret), lo, hi, tz, guard);
      case "ics": return icsBusy(sealer.open<IcsSecret>(c.secret), lo, hi, tz, guard);
      case "google":
      case "microsoft": {
        const app = this.d.apps[c.kind];
        if (!app) throw new FetchError("provider_disabled");
        const secret = sealer.open<OAuthSecret>(c.secret);
        const t = await refreshAccess(c.kind, app, secret.refreshToken, this.d.fetch);
        if (t.refreshToken && t.refreshToken !== secret.refreshToken) {
          this.d.store.updateConnection(c.id, { secret: sealer.seal({ ...secret, refreshToken: t.refreshToken }) });
        }
        const ids = secret.calendars.filter((x) => x.selected).map((x) => x.id);
        return providerBusy(c.kind, t.accessToken, ids, lo, hi, this.d.fetch, tz);
      }
    }
  }
}
