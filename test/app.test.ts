import { describe, expect, test } from "bun:test";

import { clock, ORIGIN, setup, Browser, linkFrom, signIn, createGroup, setClock } from "./helpers";

describe("auth", () => {
  test("no account and no invitation: same answer, no email", async () => {
    const env = setup();
    const r = await new Browser(env.app).post("/login", { email: "stranger@example.com" });
    expect(r.status).toBe(200);
    expect(env.mailer.sent).toHaveLength(0);
  });

  test("sign-up code, magic link, single use, profile", async () => {
    const env = setup();
    const b = new Browser(env.app);
    await b.post("/login", { email: "Anna@Example.com", code: "letmein" });
    const token = linkFrom(env.mailer);
    expect((await b.get(`/auth?t=${token}`)).status).toBe(200); // GET only shows a button
    const r = await b.post("/auth", { t: token });
    expect(r.headers.get("location")).toStartWith("/welcome");
    expect((await new Browser(env.app).post("/auth", { t: token })).status).toBe(400);
    await b.post("/welcome", { name: "Аня", tz: "Asia/Tokyo", lang: "ru", next: "/" });
    expect(env.store.getUserByEmail("anna@example.com")).toMatchObject({ name: "Аня", tz: "Asia/Tokyo", lang: "ru" });
  });

  test("an expired link does not work", async () => {
    const env = setup();
    const b = new Browser(env.app);
    await b.post("/login", { email: "a@example.com", code: "letmein" });
    const token = linkFrom(env.mailer);
    setClock(clock() + 16 * 60_000);
    expect((await b.post("/auth", { t: token })).status).toBe(400);
    setClock(clock() - 16 * 60_000);
  });

  test("a wrong sign-up code sends nothing", async () => {
    const env = setup();
    await new Browser(env.app).post("/login", { email: "a@example.com", code: "nope" });
    expect(env.mailer.sent).toHaveLength(0);
  });

  test("cross-site posts are refused", async () => {
    const env = setup();
    const r = await env.app.request(`${ORIGIN}/login`, { method: "POST", headers: { origin: "https://evil.example", host: "meet.test", "content-type": "application/x-www-form-urlencoded" }, body: "email=a%40example.com&code=letmein" });
    expect(r.status).toBe(403);
    expect(env.mailer.sent).toHaveLength(0);
  });
});

describe("groups", () => {
  test("invite, privacy, voting, confirmation emails, feed", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    const g = env.store.getGroup(gid)!;

    // A stranger sees neither the page nor the API.
    const eve = await signIn(env, "eve@example.com", { code: "letmein" }, "Eve");
    expect((await eve.get(`/groups/${gid}`)).status).toBe(404);
    expect((await eve.get(`/api/groups/${gid}`)).status).toBe(404);

    // The invite page shows no member names; logging in through it joins.
    const page = await (await new Browser(env.app).get(`/g/${g.invite}`)).text();
    expect(page).toContain("Ужин");
    const boris = await signIn(env, "boris@example.com", { invite: g.invite }, "Борис");
    expect(env.store.members(gid).map((m) => m.name)).toEqual(["Аня", "Борис"]);

    // Anna marks when she can; Boris sees her busy time but nothing else of hers.
    const lo = Date.UTC(2026, 10, 12, 23); // 13 Nov 00:00 Belgrade
    await anna.api("POST", `/api/groups/${gid}/marks`, { strokes: [{ start: lo + 18 * 3600_000, end: lo + 22 * 3600_000, state: "free" }] });
    const st = await (await boris.get(`/api/groups/${gid}`)).json() as { state: { members: { name: string; unavailable: number[][] }[]; mine: { marks: unknown[] } } };
    const annaView = st.state.members.find((m) => m.name === "Аня")!;
    expect(annaView.unavailable[0]![1]).toBe(lo + 18 * 3600_000);
    expect(JSON.stringify(st)).not.toContain("anna@example.com");
    expect(st.state.mine.marks).toEqual([]);

    // Anna proposes 18:00; Boris agrees; the meeting is set and both get an .ics.
    const start = lo + 18 * 3600_000;
    const pr = await anna.api("POST", `/api/groups/${gid}/proposals`, { start });
    expect(pr.status).toBe(200);
    const pid = env.store.proposals(gid)[0]!.id;
    expect(env.store.getGroup(gid)!.confirmedId).toBeNull();
    await boris.api("PUT", `/api/groups/${gid}/proposals/${pid}/votes/${env.store.getUserByEmail("boris@example.com")!.id}`, { vote: "yes" });
    expect(env.store.getGroup(gid)!.confirmedId).toBe(pid);
    await Bun.sleep(5);
    const mails = env.mailer.sent.filter((m) => m.subject.includes("Ужин"));
    expect(mails.map((m) => m.to).sort()).toEqual(["anna@example.com", "boris@example.com"]);
    expect(mails[0]!.attachments![0]!.content).toContain("METHOD:PUBLISH");
    expect(mails[0]!.attachments![0]!.content).toContain("DTSTART:20261113T170000Z");
    expect(mails[0]!.text).toContain("18:00");

    // Each member's feed shows the meeting.
    const token = env.store.getMember(gid, env.store.getUserByEmail("boris@example.com")!.id)!.feedToken;
    const feed = await (await new Browser(env.app).get(`/feed/${token}.ics`)).text();
    expect(feed).toContain("STATUS:CONFIRMED");
    expect(feed).toContain(`UID:${gid}@meet.test`);

    // Only the organizer cancels; everyone gets a CANCEL with a higher sequence.
    expect((await boris.api("POST", `/api/groups/${gid}/cancel`)).status).toBe(403);
    expect((await anna.api("POST", `/api/groups/${gid}/cancel`)).status).toBe(200);
    await Bun.sleep(5);
    const cancel = env.mailer.sent.at(-1)!.attachments![0]!.content;
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("SEQUENCE:2");
  });

  test("the organizer votes for someone; removing a silent member confirms", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    const g = env.store.getGroup(gid)!;
    await signIn(env, "boris@example.com", { invite: g.invite }, "Борис");
    const carl = await signIn(env, "carl@example.com", { invite: g.invite }, "Carl");
    const bid = env.store.getUserByEmail("boris@example.com")!.id, cid = env.store.getUserByEmail("carl@example.com")!.id;
    await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 13, 17) });
    const pid = env.store.proposals(gid)[0]!.id;
    // Carl may not vote for Boris; Anna (organizer) may.
    expect((await carl.api("PUT", `/api/groups/${gid}/proposals/${pid}/votes/${bid}`, { vote: "yes" })).status).toBe(403);
    expect((await anna.api("PUT", `/api/groups/${gid}/proposals/${pid}/votes/${bid}`, { vote: "yes" })).status).toBe(200);
    expect(env.store.votes(gid).find((v) => v.userId === bid)).toMatchObject({ yes: true });
    expect(env.store.getGroup(gid)!.confirmedId).toBeNull();
    await anna.api("POST", `/api/groups/${gid}/members/${cid}/remove`);
    expect(env.store.getGroup(gid)!.confirmedId).toBe(pid);
  });

  test("a lone organizer's proposal does not confirm itself", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    await anna.api("POST", `/api/groups/${gid}/proposals`, { start: Date.UTC(2026, 10, 13, 17) });
    expect(env.store.getGroup(gid)!.confirmedId).toBeNull();
  });

  test("bad group input is refused with a message", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const r = await anna.post("/groups", { title: "x", days: "0", hours: "0", minutes: "5", rangeStart: "2026-11-13", rangeEnd: "2026-11-15", expiresOn: "2026-11-20", tz: "UTC" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("15");
  });

  test("an expired group disappears", async () => {
    const env = setup();
    const anna = await signIn(env, "anna@example.com", { code: "letmein" }, "Аня");
    const gid = await createGroup(anna);
    setClock(Date.UTC(2026, 10, 21, 0));
    expect((await anna.get(`/api/groups/${gid}`)).status).toBe(404);
    env.store.sweep(clock());
    expect(env.store.getGroup(gid)).toBeNull();
    setClock(Date.UTC(2026, 10, 12, 10));
  });
});
