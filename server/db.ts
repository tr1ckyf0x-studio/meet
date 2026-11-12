import { Database } from "bun:sqlite";
import type { Iv, Mark } from "../shared/intervals";

export type Lang = "ru" | "en";

export interface User { id: string; email: string; name: string; tz: string; lang: Lang; createdAt: number }

export interface Group {
  id: string;
  invite: string;
  title: string;
  address: string;
  durationMin: number;
  rangeStart: string; // YYYY-MM-DD in `tz`, inclusive
  rangeEnd: string; // YYYY-MM-DD in `tz`, inclusive
  tz: string;
  expiresOn: string; // YYYY-MM-DD in `tz`; the group is deleted when that day ends
  expiresAt: number;
  organizerId: string;
  confirmedId: string | null;
  seq: number; // iCalendar SEQUENCE of the meeting
  rev: number; // bumped on every change, for polling
  createdAt: number;
}

export interface Member {
  groupId: string;
  userId: string;
  joinedAt: number;
  feedToken: string;
  /** Connection ids that count in this group; null = all of the user's calendars. */
  calendars: string[] | null;
  marks: Mark[];
}

export interface MemberView extends Member { name: string; email: string; tz: string; lang: Lang }

export type ProposalStatus = "open" | "confirmed" | "withdrawn" | "cancelled";
export interface Proposal { id: string; groupId: string; start: number; end: number; createdBy: string | null; createdAt: number; status: ProposalStatus }
export interface Vote { proposalId: string; userId: string; yes: boolean; setBy: string | null; updatedAt: number }

export type ConnectionKind = "caldav" | "ics" | "google" | "microsoft";
export type ConnectionStatus = "new" | "ok" | "error";
export interface Connection {
  id: string;
  userId: string;
  kind: ConnectionKind;
  label: string;
  secret: Uint8Array;
  status: ConnectionStatus;
  error: string | null;
  syncedAt: number | null;
  createdAt: number;
}

export interface LoginToken { hash: string; email: string; invite: string | null; signup: boolean; next: string | null; lang: Lang | null; expiresAt: number }
export interface OAuthState { hash: string; userId: string; provider: string; verifier: string; expiresAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT 'UTC',
  lang TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite TEXT,
  signup INTEGER NOT NULL DEFAULT 0,
  next TEXT,
  lang TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  invite TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  tz TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  organizer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmed_id TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS groups_expires ON groups(expires_at);
CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  feed_token TEXT NOT NULL UNIQUE,
  calendars TEXT,
  marks TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS proposals_group ON proposals(group_id);
CREATE TABLE IF NOT EXISTS votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  yes INTEGER NOT NULL,
  set_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  secret BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  error TEXT,
  synced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id);
CREATE TABLE IF NOT EXISTS busy (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS busy_conn ON busy(connection_id, start_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

const toUser = (r: Row): User => ({
  id: r.id as string, email: r.email as string, name: r.name as string, tz: r.tz as string,
  lang: r.lang === "ru" ? "ru" : "en", createdAt: r.created_at as number,
});

const toGroup = (r: Row): Group => ({
  id: r.id as string, invite: r.invite as string, title: r.title as string, address: r.address as string,
  durationMin: r.duration_min as number, rangeStart: r.range_start as string, rangeEnd: r.range_end as string,
  tz: r.tz as string, expiresOn: r.expires_on as string, expiresAt: r.expires_at as number,
  organizerId: r.organizer_id as string, confirmedId: (r.confirmed_id as string | null) ?? null,
  seq: r.seq as number, rev: r.rev as number, createdAt: r.created_at as number,
});

const toMember = (r: Row): Member => ({
  groupId: r.group_id as string, userId: r.user_id as string, joinedAt: r.joined_at as number,
  feedToken: r.feed_token as string,
  calendars: r.calendars == null ? null : (JSON.parse(r.calendars as string) as string[]),
  marks: JSON.parse(r.marks as string) as Mark[],
});

const toProposal = (r: Row): Proposal => ({
  id: r.id as string, groupId: r.group_id as string, start: r.start_at as number, end: r.end_at as number,
  createdBy: (r.created_by as string | null) ?? null, createdAt: r.created_at as number, status: r.status as ProposalStatus,
});

const toConnection = (r: Row): Connection => ({
  id: r.id as string, userId: r.user_id as string, kind: r.kind as ConnectionKind, label: r.label as string,
  secret: r.secret as Uint8Array, status: r.status as ConnectionStatus, error: (r.error as string | null) ?? null,
  syncedAt: (r.synced_at as number | null) ?? null, createdAt: r.created_at as number,
});

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  /* ---------- users and sessions ---------- */

  createUser(u: User): boolean {
    try {
      this.db.query("INSERT INTO users (id, email, name, tz, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(u.id, u.email, u.name, u.tz, u.lang, u.createdAt);
      return true;
    } catch (e) {
      if (String(e).includes("UNIQUE")) return false;
      throw e;
    }
  }

  getUser(id: string): User | null {
    const r = this.db.query("SELECT * FROM users WHERE id = ?").get(id) as Row | null;
    return r ? toUser(r) : null;
  }

  getUserByEmail(email: string): User | null {
    const r = this.db.query("SELECT * FROM users WHERE email = ?").get(email) as Row | null;
    return r ? toUser(r) : null;
  }

  updateUser(id: string, p: { name?: string; tz?: string; lang?: Lang }): void {
    const u = this.getUser(id);
    if (!u) return;
    this.db.query("UPDATE users SET name = ?, tz = ?, lang = ? WHERE id = ?").run(p.name ?? u.name, p.tz ?? u.tz, p.lang ?? u.lang, id);
    this.bumpRevForUser(id);
  }

  /** Deletes the account with everything it owns, including the groups it organizes. */
  deleteUser(id: string): void {
    this.tx(() => {
      this.bumpRevForUser(id);
      this.db.query("DELETE FROM users WHERE id = ?").run(id);
    });
  }

  createSession(hash: string, userId: string, expiresAt: number): void {
    this.db.query("INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash, userId, expiresAt);
  }

  sessionUser(hash: string, now: number): User | null {
    const r = this.db.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?")
      .get(hash, now) as Row | null;
    return r ? toUser(r) : null;
  }

  deleteSession(hash: string): void {
    this.db.query("DELETE FROM sessions WHERE hash = ?").run(hash);
  }

  createLoginToken(t: LoginToken): void {
    this.db.query("INSERT INTO login_tokens (hash, email, invite, signup, next, lang, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(t.hash, t.email, t.invite, t.signup ? 1 : 0, t.next, t.lang, t.expiresAt);
  }

  peekLoginToken(hash: string, now: number): LoginToken | null {
    const r = this.db.query("SELECT * FROM login_tokens WHERE hash = ? AND expires_at > ?").get(hash, now) as Row | null;
    if (!r) return null;
    return {
      hash: r.hash as string, email: r.email as string, invite: (r.invite as string | null) ?? null, signup: r.signup === 1,
      next: (r.next as string | null) ?? null, lang: r.lang === "ru" || r.lang === "en" ? r.lang : null, expiresAt: r.expires_at as number,
    };
  }

  /** Single use: returns the token and deletes it in one step. */
  takeLoginToken(hash: string, now: number): LoginToken | null {
    return this.tx(() => {
      const t = this.peekLoginToken(hash, now);
      this.db.query("DELETE FROM login_tokens WHERE hash = ?").run(hash);
      return t;
    });
  }

  /* ---------- groups and members ---------- */

  createGroup(g: Group, organizer: Member): void {
    this.tx(() => {
      this.db.query(`INSERT INTO groups (id, invite, title, address, duration_min, range_start, range_end, tz, expires_on,
        expires_at, organizer_id, confirmed_id, seq, rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(g.id, g.invite, g.title, g.address, g.durationMin, g.rangeStart, g.rangeEnd, g.tz, g.expiresOn, g.expiresAt,
          g.organizerId, g.confirmedId, g.seq, g.rev, g.createdAt);
      this.addMember(organizer);
    });
  }

  getGroup(id: string): Group | null {
    const r = this.db.query("SELECT * FROM groups WHERE id = ?").get(id) as Row | null;
    return r ? toGroup(r) : null;
  }

  getGroupByInvite(invite: string): Group | null {
    const r = this.db.query("SELECT * FROM groups WHERE invite = ?").get(invite) as Row | null;
    return r ? toGroup(r) : null;
  }

  updateGroup(id: string, p: Partial<Pick<Group, "title" | "address" | "durationMin" | "rangeStart" | "rangeEnd" | "expiresOn" | "expiresAt" | "invite">>): void {
    const g = this.getGroup(id);
    if (!g) return;
    const n = { ...g, ...p };
    this.db.query(`UPDATE groups SET title = ?, address = ?, duration_min = ?, range_start = ?, range_end = ?, expires_on = ?,
      expires_at = ?, invite = ?, rev = rev + 1 WHERE id = ?`)
      .run(n.title, n.address, n.durationMin, n.rangeStart, n.rangeEnd, n.expiresOn, n.expiresAt, n.invite, id);
  }

  deleteGroup(id: string): void {
    this.db.query("DELETE FROM groups WHERE id = ?").run(id);
  }

  /** Sets (or clears) the meeting and bumps its SEQUENCE. Returns the new sequence. */
  setConfirmed(groupId: string, proposalId: string | null): number {
    const r = this.db.query("UPDATE groups SET confirmed_id = ?, seq = seq + 1, rev = rev + 1 WHERE id = ? RETURNING seq")
      .get(proposalId, groupId) as { seq: number } | null;
    return r?.seq ?? 0;
  }

  bumpRev(groupId: string): void {
    this.db.query("UPDATE groups SET rev = rev + 1 WHERE id = ?").run(groupId);
  }

  bumpRevForUser(userId: string): void {
    this.db.query("UPDATE groups SET rev = rev + 1 WHERE id IN (SELECT group_id FROM members WHERE user_id = ?)").run(userId);
  }

  groupRev(groupId: string): number | null {
    const r = this.db.query("SELECT rev FROM groups WHERE id = ?").get(groupId) as { rev: number } | null;
    return r?.rev ?? null;
  }

  groupsOfUser(userId: string): (Group & { memberCount: number })[] {
    const rows = this.db.query(`SELECT g.*, (SELECT COUNT(*) FROM members m2 WHERE m2.group_id = g.id) AS member_count
      FROM groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.created_at DESC`).all(userId) as Row[];
    return rows.map((r) => ({ ...toGroup(r), memberCount: r.member_count as number }));
  }

  countOrganized(userId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM groups WHERE organizer_id = ?").get(userId) as { n: number }).n;
  }

  addMember(m: Member): void {
    this.db.query("INSERT INTO members (group_id, user_id, joined_at, feed_token, calendars, marks) VALUES (?, ?, ?, ?, ?, ?)")
      .run(m.groupId, m.userId, m.joinedAt, m.feedToken, m.calendars ? JSON.stringify(m.calendars) : null, JSON.stringify(m.marks));
    this.bumpRev(m.groupId);
  }

  getMember(groupId: string, userId: string): Member | null {
    const r = this.db.query("SELECT * FROM members WHERE group_id = ? AND user_id = ?").get(groupId, userId) as Row | null;
    return r ? toMember(r) : null;
  }

  members(groupId: string): MemberView[] {
    const rows = this.db.query(`SELECT m.*, u.name, u.email, u.tz, u.lang FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? ORDER BY m.joined_at`).all(groupId) as Row[];
    return rows.map((r) => ({ ...toMember(r), name: r.name as string, email: r.email as string, tz: r.tz as string, lang: r.lang === "ru" ? "ru" : "en" }));
  }

  countMembers(groupId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM members WHERE group_id = ?").get(groupId) as { n: number }).n;
  }

  removeMember(groupId: string, userId: string): void {
    this.tx(() => {
      this.db.query("DELETE FROM votes WHERE user_id = ? AND proposal_id IN (SELECT id FROM proposals WHERE group_id = ?)").run(userId, groupId);
      this.db.query("DELETE FROM members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
      this.bumpRev(groupId);
    });
  }

  setMarks(groupId: string, userId: string, marks: Mark[]): void {
    this.db.query("UPDATE members SET marks = ? WHERE group_id = ? AND user_id = ?").run(JSON.stringify(marks), groupId, userId);
    this.bumpRev(groupId);
  }

  setMemberCalendars(groupId: string, userId: string, ids: string[] | null): void {
    this.db.query("UPDATE members SET calendars = ? WHERE group_id = ? AND user_id = ?").run(ids ? JSON.stringify(ids) : null, groupId, userId);
    this.bumpRev(groupId);
  }

  memberByFeedToken(token: string): Member | null {
    const r = this.db.query("SELECT * FROM members WHERE feed_token = ?").get(token) as Row | null;
    return r ? toMember(r) : null;
  }

  /* ---------- proposals and votes ---------- */

  createProposal(p: Proposal): void {
    this.db.query("INSERT INTO proposals (id, group_id, start_at, end_at, created_by, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.groupId, p.start, p.end, p.createdBy, p.createdAt, p.status);
    this.bumpRev(p.groupId);
  }

  getProposal(id: string): Proposal | null {
    const r = this.db.query("SELECT * FROM proposals WHERE id = ?").get(id) as Row | null;
    return r ? toProposal(r) : null;
  }

  proposals(groupId: string): Proposal[] {
    return (this.db.query("SELECT * FROM proposals WHERE group_id = ? ORDER BY start_at, created_at").all(groupId) as Row[]).map(toProposal);
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    const r = this.db.query("UPDATE proposals SET status = ? WHERE id = ? RETURNING group_id").get(status, id) as { group_id: string } | null;
    if (r) this.bumpRev(r.group_id);
  }

  setVote(proposalId: string, userId: string, yes: boolean | null, setBy: string, now: number): void {
    if (yes === null) this.db.query("DELETE FROM votes WHERE proposal_id = ? AND user_id = ?").run(proposalId, userId);
    else this.db.query(`INSERT INTO votes (proposal_id, user_id, yes, set_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (proposal_id, user_id) DO UPDATE SET yes = excluded.yes, set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .run(proposalId, userId, yes ? 1 : 0, setBy, now);
    const p = this.getProposal(proposalId);
    if (p) this.bumpRev(p.groupId);
  }

  votes(groupId: string): Vote[] {
    const rows = this.db.query(`SELECT v.* FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.group_id = ?`).all(groupId) as Row[];
    return rows.map((r) => ({ proposalId: r.proposal_id as string, userId: r.user_id as string, yes: r.yes === 1, setBy: (r.set_by as string | null) ?? null, updatedAt: r.updated_at as number }));
  }

  /* ---------- calendar connections ---------- */

  createConnection(c: Connection): void {
    this.db.query("INSERT INTO connections (id, user_id, kind, label, secret, status, error, synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.userId, c.kind, c.label, c.secret, c.status, c.error, c.syncedAt, c.createdAt);
  }

  getConnection(id: string): Connection | null {
    const r = this.db.query("SELECT * FROM connections WHERE id = ?").get(id) as Row | null;
    return r ? toConnection(r) : null;
  }

  connectionsOfUser(userId: string): Connection[] {
    return (this.db.query("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toConnection);
  }

  updateConnection(id: string, p: Partial<Pick<Connection, "label" | "secret" | "status" | "error" | "syncedAt">>): void {
    const c = this.getConnection(id);
    if (!c) return;
    const n = { ...c, ...p };
    this.db.query("UPDATE connections SET label = ?, secret = ?, status = ?, error = ?, synced_at = ? WHERE id = ?")
      .run(n.label, n.secret, n.status, n.error, n.syncedAt, id);
  }

  deleteConnection(id: string): void {
    const c = this.getConnection(id);
    this.db.query("DELETE FROM connections WHERE id = ?").run(id);
    if (c) this.bumpRevForUser(c.userId);
  }

  /** Connections of users who are in at least one live group and were not synced since `before`. */
  connectionsDue(before: number, limit: number): Connection[] {
    return (this.db.query(`SELECT c.* FROM connections c WHERE (c.synced_at IS NULL OR c.synced_at < ?)
      AND EXISTS (SELECT 1 FROM members m WHERE m.user_id = c.user_id) ORDER BY COALESCE(c.synced_at, 0) LIMIT ?`)
      .all(before, limit) as Row[]).map(toConnection);
  }

  replaceBusy(connectionId: string, list: Iv[]): void {
    this.tx(() => {
      this.db.query("DELETE FROM busy WHERE connection_id = ?").run(connectionId);
      const ins = this.db.query("INSERT INTO busy (connection_id, start_at, end_at) VALUES (?, ?, ?)");
      for (const [s, e] of list) ins.run(connectionId, s, e);
    });
  }

  busy(connectionIds: string[], lo: number, hi: number): Iv[] {
    if (!connectionIds.length) return [];
    const marks = connectionIds.map(() => "?").join(",");
    return (this.db.query(`SELECT start_at, end_at FROM busy WHERE connection_id IN (${marks}) AND end_at > ? AND start_at < ? ORDER BY start_at`)
      .all(...connectionIds, lo, hi) as { start_at: number; end_at: number }[]).map((r) => [r.start_at, r.end_at] as Iv);
  }

  /* ---------- OAuth states ---------- */

  createOAuthState(s: OAuthState): void {
    this.db.query("INSERT INTO oauth_states (hash, user_id, provider, verifier, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(s.hash, s.userId, s.provider, s.verifier, s.expiresAt);
  }

  takeOAuthState(hash: string, now: number): OAuthState | null {
    return this.tx(() => {
      const r = this.db.query("SELECT * FROM oauth_states WHERE hash = ? AND expires_at > ?").get(hash, now) as Row | null;
      this.db.query("DELETE FROM oauth_states WHERE hash = ?").run(hash);
      return r ? { hash: r.hash as string, userId: r.user_id as string, provider: r.provider as string, verifier: r.verifier as string, expiresAt: r.expires_at as number } : null;
    });
  }

  /* ---------- housekeeping ---------- */

  /** Deletes expired groups (with everything in them), sessions, tokens and busy time already past. */
  sweep(now: number): { groups: number } {
    return this.tx(() => {
      const groups = this.db.query("DELETE FROM groups WHERE expires_at <= ?").run(now).changes;
      this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      this.db.query("DELETE FROM login_tokens WHERE expires_at <= ?").run(now);
      this.db.query("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
      this.db.query("DELETE FROM busy WHERE end_at < ?").run(now - 2 * 86_400_000);
      return { groups };
    });
  }
}
