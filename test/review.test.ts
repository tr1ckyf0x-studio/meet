// Regression tests for the findings of the pre-launch review (2026-11-12).
import { afterAll, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { safeNext } from "../server/app";
import { FetchError, safeFetch } from "../server/calendars/fetchguard";
import { busyFromIcs, CalendarTooComplex } from "../server/calendars/parse";
import { providerBusy } from "../server/calendars/oauth";
import { clientIp } from "../server/http";
import { buildEventIcs } from "../server/ics";
import { clock, createGroup, setup, signIn } from "./helpers";

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof FetchError ? e.code : String(e); }
}

describe("fetch guard", () => {
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      if (new URL(req.url).pathname === "/slow") { await Bun.sleep(2000); return new Response("late"); }
      return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    },
  });
  afterAll(() => srv.stop(true));
  const at = (p: string) => `http://127.0.0.1:${srv.port}${p}`;

  test("the operator's own zone and the home address are refused", async () => {
    expect(await code(safeFetch("https://gitlab.vfox.example.dev/", {}, { denySuffixes: ["example.dev"] }))).toBe("private_address");
    expect(await code(safeFetch(at("/"), {}, { allowHosts: ["127.0.0.1"], denyAddressesOf: ["127.0.0.1"] }))).toBe("private_address");
    expect(await code(safeFetch(at("/"), {}, { allowHosts: ["127.0.0.1"] }))).toBe("ok");
  });

  test("IP literals are checked even though no DNS lookup happens", async () => {
    expect(await code(safeFetch(at("/")))).toBe("private_address");
    expect(await code(safeFetch(`http://[::ffff:7f00:1]:${srv.port}/`))).toBe("private_address");
  });

  test("a slow server times out", async () => {
    expect(await code(safeFetch(at("/slow"), {}, { allowHosts: ["127.0.0.1"], timeoutMs: 300 }))).toBe("timeout");
  });
});

describe("parsing budget", () => {
  const lo = Date.UTC(2026, 10, 1), hi = Date.UTC(2026, 11, 1);
  const cal = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`;

  test("sub-hourly series are ignored", () => {
    const ev = "BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261110T000000Z\r\nDTEND:20261110T000001Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT\r\n";
    expect(busyFromIcs(cal(ev), lo, hi, "UTC")).toEqual([]);
  });

  test("a feed that needs too much work is refused, not half-read", () => {
    let evs = "";
    for (let i = 0; i < 450; i++) evs += `BEGIN:VEVENT\r\nUID:h${i}\r\nDTSTART:20261031T000000Z\r\nDTEND:20261031T000100Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\n`;
    const t0 = performance.now();
    expect(() => busyFromIcs(cal(evs), lo, hi, "UTC")).toThrow(CalendarTooComplex);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test("old daily series stay cheap before the window", () => {
    const ev = "BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20000101T090000Z\r\nDTEND:20000101T093000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n";
    expect(busyFromIcs(cal(ev), lo, lo + 86_400_000, "UTC")).toEqual([[lo + 9 * 3600_000, lo + 9.5 * 3600_000]]);
  });
});

describe("requests", () => {
  const ctx = (h: Record<string, string>) => ({ req: { header: (k: string) => h[k.toLowerCase()] } }) as unknown as Context;

  test("CF-Connecting-IP counts only when the peer is Cloudflare", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "162.158.1.2", "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(ctx({ "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "203.0.113.9" }))).toBe("198.51.100.7");
  });

  test("next= stays on this site", () => {
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("/groups/abc?x=1#y")).toBe("/groups/abc?x=1#y");
  });
});

describe("calendar output", () => {
  test("a lone carriage return cannot start a new property", () => {
    const text = buildEventIcs({ uid: "u", seq: 0, start: 0, end: 3600_000, title: "x", location: "a\rATTACH:http://evil", status: "CONFIRMED", organizer: { name: "meet", email: "noreply@meet.test" } }, "PUBLISH", 0);
    expect(text).not.toMatch(/\r\nATTACH/);
    expect(text).toContain("LOCATION:a\\nATTACH:http://evil");
    expect(text).toContain("ORGANIZER;CN=meet:mailto:noreply@meet.test");
  });

  test("Outlook all-day events are days in the user's zone", async () => {
    const fake = (async () => Response.json({ value: [{ start: { dateTime: "2026-11-13T00:00:00.0000000" }, end: { dateTime: "2026-11-14T00:00:00.0000000" }, showAs: "oof", isAllDay: true }] })) as unknown as typeof fetch;
    const r = await providerBusy("microsoft", "t", ["c"], Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), fake, "Asia/Tokyo");
    expect(r).toEqual([[Date.UTC(2026, 10, 12, 15), Date.UTC(2026, 10, 13, 15)]]);
  });
});

describe("groups", () => {
  test("no name: others never see the email address", async () => {
    const env = setup();
    const anna = await signIn(env, "anna.secret@example.com", { code: "letmein" }, "");
    const gid = await createGroup(anna);
    const st = await (await anna.get(`/api/groups/${gid}`)).text();
    expect(st).not.toContain("anna.secret");
    expect((await anna.get(`/groups/${gid}`)).headers.get("location")).toStartWith("/welcome");
  });

  test("a calendar that failed or has not synced does not make its owner look free", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    const uid = env.store.getUserByEmail("anna@example.com")!.id;
    env.store.createConnection({ id: "c1", userId: uid, kind: "ics", label: "x", secret: new Uint8Array([1]), status: "error", error: "auth", syncedAt: clock(), createdAt: 0 });
    const st = (await (await anna.get(`/api/groups/${gid}`)).json()) as { state: { members: { responded: boolean; hasCalendars: boolean; calendarProblem: boolean }[] } };
    expect(st.state.members[0]).toMatchObject({ responded: false, hasCalendars: false, calendarProblem: true });
  });

  test("cancelling withdraws the other proposals, and is limited per day", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    const boris = await signIn(env, "boris@example.com", { invite: env.store.getGroup(gid)!.invite }, "Борис");
    const bid = env.store.getUserByEmail("boris@example.com")!.id;
    const round = async (h: number) => {
      await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 13, h) });
      await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 14, h) });
      const [p1] = env.store.proposals(gid).filter((p) => p.status === "open");
      await boris.api("PUT", `/api/groups/${gid}/proposals/${p1!.id}/votes/${bid}`, { vote: "yes" });
      expect(env.store.getGroup(gid)!.confirmedId).toBe(p1!.id);
      return anna.api("POST", `/api/groups/${gid}/cancel`);
    };
    expect((await round(10)).status).toBe(200);
    expect(env.store.proposals(gid).filter((p) => p.status === "open")).toEqual([]);
    expect(env.store.getGroup(gid)!.confirmedId).toBeNull();
    expect((await round(11)).status).toBe(200);
    expect((await round(12)).status).toBe(200);
    expect((await round(13)).status).toBe(429);
  });

  test("a set meeting: dates are locked, a new title is mailed as an update", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    await signIn(env, "boris@example.com", { invite: env.store.getGroup(gid)!.invite }, "Борис");
    const bid = env.store.getUserByEmail("boris@example.com")!.id;
    await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 13, 17) });
    const pid = env.store.proposals(gid)[0]!.id;
    await anna.api("PUT", `/api/groups/${gid}/proposals/${pid}/votes/${bid}`, { vote: "yes" });
    const form = { title: "Ужин", days: "0", hours: "2", minutes: "0", rangeStart: "2026-11-13", rangeEnd: "2026-11-15", address: "Белград", expiresOn: "2026-11-20" };
    expect((await anna.post(`/groups/${gid}/edit`, { ...form, hours: "3" })).status).toBe(409);
    const before = env.mailer.sent.length;
    expect((await anna.post(`/groups/${gid}/edit`, { ...form, title: "Ужин у Ани" })).status).toBe(303);
    await Bun.sleep(5);
    const update = env.mailer.sent.slice(before);
    expect(update).toHaveLength(2);
    expect(update[0]!.subject).toContain("Ужин у Ани");
    expect(update[0]!.attachments![0]!.content).toContain("SEQUENCE:2");
  });

  test("a new duration moves the end of open proposals", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 13, 17) });
    await anna.post(`/groups/${gid}/edit`, { title: "Ужин", days: "0", hours: "3", minutes: "0", rangeStart: "2026-11-13", rangeEnd: "2026-11-15", address: "", expiresOn: "2026-11-20" });
    expect(env.store.proposals(gid)[0]!.end).toBe(Date.UTC(2026, 10, 13, 20));
  });
});
