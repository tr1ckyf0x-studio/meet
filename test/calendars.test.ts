import { afterAll, describe, expect, test } from "bun:test";
import { caldavBusy, discoverCalendars } from "../server/calendars/caldav";
import { FetchError, isPrivateAddress, parseUserUrl, safeFetch } from "../server/calendars/fetchguard";
import { icsBusy } from "../server/calendars/icsurl";

const local = { allowHosts: ["127.0.0.1"] };

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof FetchError ? e.code : String(e); }
}

describe("fetch guard", () => {
  test("private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.27.100", "169.254.169.254", "100.64.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:0a00:0001", "64:ff9b::7f00:1", "::"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  test("user URLs", () => {
    expect(parseUserUrl("webcal://p01-calendars.icloud.com/x.ics").toString()).toBe("https://p01-calendars.icloud.com/x.ics");
    expect(() => parseUserUrl("file:///etc/passwd")).toThrow();
    expect(() => parseUserUrl("https://user:pw@example.com/")).toThrow();
  });

  const target = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/to-localhost") return Response.redirect(`http://localhost:${target.port}/cal.ics`, 302);
      if (u.pathname === "/big") return new Response("x".repeat(2000));
      if (u.pathname === "/cal.ics") return new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261112T100000Z\r\nDTEND:20261112T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
      return new Response("nope", { status: 404 });
    },
  });
  afterAll(() => target.stop(true));
  const at = (p: string) => `http://127.0.0.1:${target.port}${p}`;

  test("refuses loopback, docker names and redirects into them", async () => {
    expect(await code(safeFetch(at("/cal.ics")))).toBe("private_address");
    expect(await code(safeFetch("http://komodo-core:9120/"))).toBe("private_address");
    expect(await code(safeFetch("http://router.local/"))).toBe("private_address");
    expect(await code(safeFetch(at("/to-localhost"), {}, local))).toBe("private_address");
  });

  test("caps the size", async () => {
    expect(await code(safeFetch(at("/big"), {}, { ...local, maxBytes: 1000 }))).toBe("too_large");
  });

  test("ICS link to busy time", async () => {
    const lo = Date.UTC(2026, 10, 1), hi = Date.UTC(2026, 11, 1);
    expect(await icsBusy({ url: at("/cal.ics") }, lo, hi, "UTC", local)).toEqual([[Date.UTC(2026, 10, 12, 10), Date.UTC(2026, 10, 12, 11)]]);
    expect(await code(icsBusy({ url: at("/missing.ics") }, lo, hi, "UTC", local))).toBe("not_found");
  });
});

describe("CalDAV", () => {
  // Two servers, like iCloud: the entry point names a principal, whose calendar home lives on another host.
  const seenAuth: string[] = [];
  const ms = (inner: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
  const ok = (href: string, prop: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const home = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      seenAuth.push(req.headers.get("authorization") ?? "");
      const u = new URL(req.url);
      const body = await req.text();
      if (req.method === "PROPFIND" && u.pathname === "/123/calendars/") {
        return ms(
          ok("/123/calendars/", "<d:resourcetype><d:collection/></d:resourcetype>") +
          ok("/123/calendars/home/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Дом</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`) +
          ok("/123/calendars/tasks/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>`),
        );
      }
      if (req.method === "REPORT" && u.pathname === "/123/calendars/home/" && body.includes("time-range")) {
        const ev = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/Belgrade:20261112T180000\r\nDTEND;TZID=Europe/Belgrade:20261112T193000\r\nSUMMARY:Secret &amp; private\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        return ms(ok("/123/calendars/home/x.ics", `<c:calendar-data>${ev}</c:calendar-data>`));
      }
      return new Response("", { status: 404 });
    },
  });
  const entry = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      seenAuth.push(req.headers.get("authorization") ?? "");
      if (req.headers.get("authorization") !== "Basic " + btoa("me@icloud.com:app-pass")) return new Response("", { status: 401 });
      const u = new URL(req.url);
      if (u.pathname === "/") return ms(ok("/", "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>"));
      if (u.pathname === "/123/principal/") return ms(ok("/123/principal/", `<c:calendar-home-set><d:href>http://127.0.0.1:${home.port}/123/calendars/</d:href></c:calendar-home-set>`));
      return new Response("", { status: 404 });
    },
  });
  afterAll(() => { home.stop(true); entry.stop(true); });

  test("discovers event calendars across hosts and reads busy time", async () => {
    const base = `http://127.0.0.1:${entry.port}/`;
    const cals = await discoverCalendars(base, "me@icloud.com", "app-pass", local);
    expect(cals).toEqual([{ href: `http://127.0.0.1:${home.port}/123/calendars/home/`, name: "Дом" }]);
    const busy = await caldavBusy({ url: base, username: "me@icloud.com", password: "app-pass", calendars: cals.map((c) => ({ ...c, selected: true })) },
      Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), "UTC", local);
    expect(busy).toEqual([[Date.UTC(2026, 10, 12, 17), Date.UTC(2026, 10, 12, 18, 30)]]);
  });

  test("a wrong password is reported as such", async () => {
    expect(await code(discoverCalendars(`http://127.0.0.1:${entry.port}/`, "me@icloud.com", "wrong", local))).toBe("auth");
  });
});
