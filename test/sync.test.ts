import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Syncer } from "../server/calendars/sync";
import { authUrl } from "../server/calendars/oauth";
import { Sealer } from "../server/crypto";
import { Store } from "../server/db";

const NOW = Date.UTC(2026, 10, 12, 12);
const app = { clientId: "cid", clientSecret: "cs", redirectUri: "https://meet.example/oauth/google/callback" };

function setup(fakeFetch: typeof fetch) {
  const store = new Store(":memory:");
  const sealer = new Sealer(randomBytes(32));
  store.createUser({ id: "u", email: "u@example.com", name: "U", tz: "Europe/Belgrade", lang: "ru", createdAt: 0 });
  store.createGroup({
    id: "g", invite: "i", title: "T", address: "", durationMin: 60, rangeStart: "2026-11-12", rangeEnd: "2026-11-20", tz: "UTC",
    expiresOn: "2026-11-27", expiresAt: NOW + 30 * 86_400_000, organizerId: "u", confirmedId: null, seq: 0, rev: 1, createdAt: 0,
  }, { groupId: "g", userId: "u", joinedAt: 0, feedToken: "f", calendars: null, marks: [] });
  const syncer = new Syncer({ store, sealer, guard: {}, apps: { google: app, microsoft: app }, now: () => NOW, fetch: fakeFetch });
  return { store, sealer, syncer };
}

describe("sync", () => {
  test("Google: refresh, FreeBusy, intervals stored, status ok", async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("oauth2.googleapis.com/token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return Response.json({ access_token: "at", expires_in: 3600 });
      }
      if (u.includes("/freeBusy")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer at");
        const body = JSON.parse(String(init?.body));
        expect(body.items).toEqual([{ id: "primary" }]);
        return Response.json({ calendars: { primary: { busy: [{ start: "2026-11-13T10:00:00Z", end: "2026-11-13T11:00:00Z" }] } } });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { store, sealer, syncer } = setup(fake);
    store.createConnection({
      id: "c", userId: "u", kind: "google", label: "u@gmail.com", status: "new", error: null, syncedAt: null, createdAt: 0,
      secret: sealer.seal({ refreshToken: "rt", email: "u@gmail.com", calendars: [{ id: "primary", name: "U", selected: true }, { id: "other", name: "O", selected: false }] }),
    });
    await syncer.sync("c");
    expect(store.getConnection("c")).toMatchObject({ status: "ok", error: null, syncedAt: NOW });
    expect(store.busy(["c"], 0, Infinity)).toEqual([[Date.UTC(2026, 10, 13, 10), Date.UTC(2026, 10, 13, 11)]]);
    expect(calls.filter((c) => c.includes("freeBusy"))).toHaveLength(1);
  });

  test("Microsoft: rotated refresh token is kept, free and cancelled events ignored", async () => {
    const fake = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/token")) return Response.json({ access_token: "at", refresh_token: "rt2" });
      if (u.includes("/calendarView")) {
        return Response.json({ value: [
          { start: { dateTime: "2026-11-13T10:00:00.0000000" }, end: { dateTime: "2026-11-13T11:00:00.0000000" }, showAs: "busy" },
          { start: { dateTime: "2026-11-13T12:00:00.0000000" }, end: { dateTime: "2026-11-13T13:00:00.0000000" }, showAs: "free" },
          { start: { dateTime: "2026-11-13T14:00:00.0000000" }, end: { dateTime: "2026-11-13T15:00:00.0000000" }, showAs: "busy", isCancelled: true },
        ] });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { store, sealer, syncer } = setup(fake);
    store.createConnection({
      id: "m", userId: "u", kind: "microsoft", label: "x", status: "new", error: null, syncedAt: null, createdAt: 0,
      secret: sealer.seal({ refreshToken: "rt1", email: "x", calendars: [{ id: "AAA=", name: "Calendar", selected: true }] }),
    });
    await syncer.sync("m");
    expect(store.busy(["m"], 0, Infinity)).toEqual([[Date.UTC(2026, 10, 13, 10), Date.UTC(2026, 10, 13, 11)]]);
    expect(sealer.open<{ refreshToken: string }>(store.getConnection("m")!.secret).refreshToken).toBe("rt2");
  });

  test("a failure keeps the old busy time and records the reason", async () => {
    const fake = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    const { store, sealer, syncer } = setup(fake);
    store.createConnection({
      id: "c", userId: "u", kind: "google", label: "x", status: "ok", error: null, syncedAt: 1, createdAt: 0,
      secret: sealer.seal({ refreshToken: "rt", email: "x", calendars: [{ id: "primary", name: "U", selected: true }] }),
    });
    store.replaceBusy("c", [[NOW + 1000, NOW + 2000]]);
    await syncer.sync("c");
    expect(store.getConnection("c")).toMatchObject({ status: "error", error: "auth" });
    expect(store.busy(["c"], 0, Infinity)).toEqual([[NOW + 1000, NOW + 2000]]);
  });

  test("auth URLs ask for offline access and PKCE", () => {
    const g = new URL(authUrl("google", app, "st", "ch"));
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");
    expect(g.searchParams.get("scope")).toContain("calendar.freebusy");
    const m = new URL(authUrl("microsoft", app, "st", "ch"));
    expect(m.searchParams.get("scope")).toContain("Calendars.ReadBasic");
  });
});
