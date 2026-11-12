import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Sealer } from "../server/crypto";
import { Store, type Group } from "../server/db";

function seed() {
  const s = new Store(":memory:");
  s.createUser({ id: "u1", email: "a@example.com", name: "A", tz: "UTC", lang: "en", createdAt: 1 });
  s.createUser({ id: "u2", email: "b@example.com", name: "B", tz: "UTC", lang: "ru", createdAt: 1 });
  const g: Group = {
    id: "g1", invite: "inv", title: "T", address: "", durationMin: 60, rangeStart: "2026-11-12", rangeEnd: "2026-11-13",
    tz: "UTC", expiresOn: "2026-11-20", expiresAt: 1000, organizerId: "u1", confirmedId: null, seq: 0, rev: 1, createdAt: 1,
  };
  s.createGroup(g, { groupId: "g1", userId: "u1", joinedAt: 1, feedToken: "f1", calendars: null, marks: [] });
  s.addMember({ groupId: "g1", userId: "u2", joinedAt: 2, feedToken: "f2", calendars: null, marks: [[0, 10, 1]] });
  s.createProposal({ id: "p1", groupId: "g1", start: 0, end: 10, createdBy: "u2", createdAt: 3, status: "open" });
  s.setVote("p1", "u2", true, "u2", 4);
  return s;
}

describe("store", () => {
  test("emails are unique regardless of case", () => {
    const s = seed();
    expect(s.createUser({ id: "u3", email: "A@Example.com", name: "", tz: "UTC", lang: "en", createdAt: 1 })).toBe(false);
    expect(s.getUserByEmail("A@EXAMPLE.COM")?.id).toBe("u1");
  });

  test("an expired group goes with its members, proposals and votes", () => {
    const s = seed();
    expect(s.sweep(999).groups).toBe(0);
    expect(s.sweep(1000).groups).toBe(1);
    const count = (t: string) => (s.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count("groups"), count("members"), count("proposals"), count("votes")]).toEqual([0, 0, 0, 0]);
    expect(count("users")).toBe(2);
  });

  test("leaving a group removes the member's votes there", () => {
    const s = seed();
    s.removeMember("g1", "u2");
    expect(s.votes("g1")).toEqual([]);
  });

  test("deleting the organizer deletes the group", () => {
    const s = seed();
    s.deleteUser("u1");
    expect(s.getGroup("g1")).toBeNull();
    expect(s.getUser("u2")).not.toBeNull();
  });

  test("login tokens are single use", () => {
    const s = seed();
    s.createLoginToken({ hash: "h", email: "x@example.com", invite: null, signup: false, next: null, lang: null, expiresAt: 100 });
    expect(s.takeLoginToken("h", 50)?.email).toBe("x@example.com");
    expect(s.takeLoginToken("h", 50)).toBeNull();
  });

  test("rev grows with every change", () => {
    const s = seed();
    const r = s.groupRev("g1")!;
    s.setMarks("g1", "u1", [[0, 5, 0]]);
    expect(s.groupRev("g1")).toBe(r + 1);
  });
});

describe("sealer", () => {
  test("round trip, and a tampered blob is refused", () => {
    const k = new Sealer(randomBytes(32));
    const blob = k.seal({ password: "secret" });
    expect(k.open<{ password: string }>(blob).password).toBe("secret");
    blob[blob.length - 1]! ^= 1;
    expect(() => k.open(blob)).toThrow();
    expect(() => new Sealer(randomBytes(32)).open(k.seal(1))).toThrow();
  });
});
