import { fmtAgo, fmtDay, fmtDuration, fmtRange, fmtTime, fmtTz, fmtYmd, fmtYmdRange } from "../shared/format";
import { ICONS, type IconName } from "../shared/icons";
import { errText, t, type Key, type Lang } from "../shared/i18n";
import { applyStroke, type Iv, type Mark } from "../shared/intervals";
import { addDays, MIN, parseYmd, ymdOf, zonedToUtc } from "../shared/time";
import type { GroupState, ProposalView } from "../server/meeting";

// The group page: shared calendar grid, my marks, suggestions, voting. State comes from /api/groups/:id.

const boot = JSON.parse(document.getElementById("boot")!.textContent!) as { state: GroupState; zones: string[] };
let S: GroupState = boot.state;
const L: Lang = S.me.lang;
const tr = (k: Key, v?: Record<string, string | number>) => t(L, k, v);

let mode: "all" | "me" = S.members.length > 1 && S.members.find((m) => m.id === S.me.id)?.responded ? "all" : "me";
let brush: "free" | "busy" | "clear" = S.mine.connections.some((c) => c.used) ? "busy" : "free";
let viewTz = S.me.tz;
let selected: { s: number; e: number } | null = null;
let anchor: { col: number; row: number } | null = null;
let painting = false;
let inflight = 0;

/* ---------- tiny DOM helper ---------- */

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
type Kid = Node | string | null | undefined | false | Kid[];
function h(tag: string, attrs: Attrs = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  const add = (k: Kid) => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else el.append(k instanceof Node ? k : document.createTextNode(k));
  };
  kids.forEach(add);
  return el;
}

function icon(n: IconName): HTMLElement {
  const s = document.createElement("span");
  s.className = "icon";
  s.innerHTML = ICONS[n]; // constant markup from our own bundle
  return s;
}

function toast(msg: string) {
  const el = h("div", { class: "toast" }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- server calls ---------- */

async function api(method: string, path: string, body?: unknown): Promise<boolean> {
  inflight++;
  try {
    const r = await fetch(`/api/groups/${S.group.id}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? "{}" : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as { changed?: boolean; state?: GroupState; gone?: boolean; error?: string };
    if (j.gone) { location.href = "/"; return false; }
    if (!r.ok) { toast(tr("g_error")); return false; }
    if (j.state) setState(j.state);
    return true;
  } catch {
    toast(tr("g_offline"));
    return false;
  } finally {
    inflight--;
  }
}

async function poll() {
  if (document.hidden || painting || inflight) return;
  try {
    const r = await fetch(`/api/groups/${S.group.id}?since=${S.rev}`);
    if (r.status === 404) { location.href = "/"; return; }
    const j = await r.json() as { changed: boolean; state?: GroupState };
    if (j.changed && j.state && !painting && !inflight) setState(j.state);
  } catch { /* offline: try again later */ }
}

function setState(next: GroupState) {
  S = next;
  render();
}

/* ---------- helpers ---------- */

const memberName = (id: string | null) => S.members.find((m) => m.id === id)?.name ?? "?";
const isOrg = () => S.me.isOrganizer;
const durMs = () => S.group.durationMin * MIN;
const overlapsAny = (list: Iv[], s: number, e: number) => list.some(([a, b]) => a < e && b > s);

function startOptions(ws: number, we: number): number[] {
  const last = we - durMs();
  const out = [ws];
  const step = 30 * MIN;
  // Later starts fall on round half hours of the shown zone (+5:45 zones are not aligned to UTC ones).
  const shift = (zonedToUtc(2026, 1, 1, 0, 0, viewTz) % step + step) % step;
  let x = Math.ceil((ws + 1 - shift) / step) * step + shift;
  while (x <= last && out.length < 48) { out.push(x); x += step; }
  return out;
}

function localTimesFor(s: number): Kid {
  const zones = [...new Set(S.members.map((m) => m.tz))].filter((z) => z !== viewTz);
  if (!zones.length) return null;
  return h("div", { class: "local-times" }, zones.map((z) => {
    const names = S.members.filter((m) => m.tz === z).map((m) => m.name).join(", ");
    return h("span", {}, `${names}: ${fmtDay(s, z, L)} ${fmtTime(s, z, L)}`);
  }));
}

/* ---------- sections ---------- */

function header(): HTMLElement {
  const g = S.group;
  return h("section", { class: "group-head" },
    h("div", { class: "row-between" },
      h("h1", {}, g.title),
      isOrg() ? h("a", { class: "button small", href: `/groups/${g.id}/edit` }, tr("g_edit")) : null),
    h("p", { class: "meta" },
      h("span", {}, icon("clock"), " ", fmtYmdRange(g.rangeStart, g.rangeEnd, L), " · ", fmtDuration(g.durationMin, L)),
      g.address ? h("span", {}, icon("pin"), " ", g.address, " ",
        h("a", { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.address)}`, target: "_blank", rel: "noopener" }, tr("g_maps"))) : null),
  );
}

function confirmedCard(): HTMLElement | null {
  const p = S.proposals.find((x) => x.id === S.group.confirmedId);
  if (!p) return null;
  const gcal = new URLSearchParams({ action: "TEMPLATE", text: S.group.title, dates: `${icsDate(p.start)}/${icsDate(p.end)}` });
  if (S.group.address) gcal.set("location", S.group.address);
  return h("section", { class: "card confirmed" },
    h("p", { class: "eyebrow ok" }, icon("check"), " ", tr("g_confirmed")),
    h("h2", {}, fmtRange(p.start, p.end, viewTz, L)),
    localTimesFor(p.start),
    h("p", { class: "muted small" }, tr("g_mail_note")),
    h("div", { class: "row wrap" },
      h("a", { class: "button primary", href: `/groups/${S.group.id}/meeting.ics` }, tr("g_ics")),
      h("a", { class: "button", href: `https://calendar.google.com/calendar/render?${gcal}`, target: "_blank", rel: "noopener" }, tr("g_gcal")),
      isOrg() ? h("button", { class: "danger", onclick: () => { if (confirm(tr("g_cancel_confirm"))) void api("POST", "/cancel"); } }, tr("g_cancel")) : null),
  );
}

function icsDate(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function shareCard(compact = false): HTMLElement {
  const g = S.group;
  const webcal = g.feedUrl.replace(/^https?:/, "webcal:");
  return h("section", { class: "card share" },
    h("h3", {}, tr("g_share")),
    compact ? h("p", {}, tr("g_alone")) : h("p", { class: "muted small" }, tr("g_share_hint")),
    h("div", { class: "copy-row" },
      h("input", { readonly: true, value: g.inviteUrl, onfocus: (e) => (e.target as HTMLInputElement).select() }),
      h("button", { class: "small", "data-copy": g.inviteUrl, "data-copied": tr("g_copied") }, tr("g_copy"))),
    isOrg() && !compact ? h("form", { method: "post", action: `/groups/${g.id}/invite/reset`, "data-confirm": tr("g_reset_confirm") },
      h("button", { class: "link small" }, tr("g_reset_link"))) : null,
    compact ? null : [
      h("h3", {}, tr("g_feed")),
      h("p", { class: "muted small" }, tr("g_feed_hint")),
      h("div", { class: "copy-row" },
        h("a", { class: "button small primary", href: webcal }, tr("g_feed_open")),
        h("button", { class: "small", "data-copy": g.feedUrl, "data-copied": tr("g_copied") }, tr("g_copy"))),
    ],
  );
}

function suggestionsCard(): HTMLElement | null {
  if (S.group.confirmedId) return null;
  const sg = S.suggestions;
  const pending = sg.pending.map(memberName);
  return h("section", { class: "card" },
    h("h2", {}, sg.missing ? tr("g_sugg_partial") : tr("g_sugg")),
    pending.length ? h("p", { class: "muted small" }, tr("g_sugg_wait", { names: pending.join(", ") })) : null,
    sg.windows.length === 0 ? h("p", { class: "muted" }, tr("g_sugg_none")) :
      h("ul", { class: "windows" }, sg.windows.map((w) => {
        const opts = startOptions(w.start, w.end);
        const sel = h("select", { "aria-label": tr("g_start") }, opts.map((x) => h("option", { value: x }, fmtTime(x, viewTz, L)))) as HTMLSelectElement;
        return h("li", {},
          h("div", { class: "when" }, fmtRange(w.start, w.end, viewTz, L)),
          h("span", { class: `chip ${w.missingIds.length ? "warn" : "ok"}` },
            w.missingIds.length ? tr("g_sugg_without", { names: w.missingIds.map(memberName).join(", ") }) : tr("g_sugg_all")),
          h("div", { class: "row" }, opts.length > 1 ? h("label", { class: "inline-label" }, tr("g_start"), " ", sel) : null,
            h("button", { class: "small primary", onclick: () => void api("POST", "/proposals", { start: Number(opts.length > 1 ? sel.value : opts[0]) }) }, tr("g_propose"))));
      })),
  );
}

function proposalItem(p: ProposalView): HTMLElement {
  const yes = S.members.filter((m) => p.votes[m.id]?.yes).length;
  const mine = p.votes[S.me.id];
  const canWithdraw = p.createdBy === S.me.id || isOrg();
  const voteFor = (uid: string, v: "yes" | "no" | null) => void api("PUT", `/proposals/${p.id}/votes/${uid}`, { vote: v });
  return h("li", { class: "proposal" },
    h("div", { class: "row-between" },
      h("div", {},
        h("div", { class: "when" }, fmtRange(p.start, p.end, viewTz, L)),
        localTimesFor(p.start),
        h("div", { class: "muted small" }, tr("g_by", { name: memberName(p.createdBy) }), " · ", tr("g_votes", { yes, n: S.members.length }))),
      canWithdraw ? h("button", { class: "link small", onclick: () => void api("POST", `/proposals/${p.id}/withdraw`) }, tr("g_withdraw")) : null),
    h("div", { class: "voters" }, S.members.map((m) => {
      const v = p.votes[m.id];
      const conflict = !v && overlapsAny(m.unavailable, p.start, p.end) && m.responded;
      const cls = v ? (v.yes ? "yes" : "no") : conflict ? "conflict" : "none";
      return h("span", { class: `voter ${cls}`, title: v?.byOrganizer ? tr("g_on_behalf") : conflict ? tr("g_conflict") : null },
        v ? (v.yes ? "✓ " : "✗ ") : conflict ? "! " : "· ", m.name, v?.byOrganizer ? "*" : "");
    })),
    h("div", { class: "row wrap" },
      h("button", { class: `small ${mine?.yes ? "primary" : ""}`, onclick: () => voteFor(S.me.id, mine?.yes ? null : "yes") }, tr("g_vote_yes")),
      h("button", { class: `small ${mine && !mine.yes ? "danger" : ""}`, onclick: () => voteFor(S.me.id, mine && !mine.yes ? null : "no") }, tr("g_vote_no")),
      isOrg() && S.members.length > 1 ? h("details", { class: "on-behalf" },
        h("summary", {}, tr("g_set_for")),
        S.members.filter((m) => m.id !== S.me.id).map((m) => {
          const v = p.votes[m.id];
          const sel = h("select", { onchange: (e) => { const x = (e.target as HTMLSelectElement).value; voteFor(m.id, x === "" ? null : x as "yes" | "no"); } },
            h("option", { value: "", selected: !v }, "—"),
            h("option", { value: "yes", selected: !!v?.yes }, "✓ " + tr("g_vote_yes")),
            h("option", { value: "no", selected: !!v && !v.yes }, "✗ " + tr("g_vote_no")));
          return h("label", { class: "behalf-row" }, m.name, " ", sel);
        })) : null),
  );
}

function proposalsCard(): HTMLElement | null {
  if (S.group.confirmedId) return null;
  const open = S.proposals.filter((p) => p.status === "open");
  return h("section", { class: "card" },
    h("h2", {}, tr("g_props")),
    open.length ? h("ul", { class: "proposals" }, open.map(proposalItem)) : h("p", { class: "muted" }, tr("g_props_none")));
}

function membersCard(): HTMLElement {
  return h("section", { class: "card" },
    h("h3", {}, tr("g_members"), ` · ${S.members.length}`),
    h("ul", { class: "members" }, S.members.map((m) => {
      const status = m.hasCalendars ? tr("g_m_calendar") : m.responded ? tr("g_m_manual") : tr("g_m_pending");
      return h("li", {},
        h("div", {},
          h("span", { class: "name" }, m.name),
          m.id === S.me.id ? h("span", { class: "chip" }, tr("g_m_you")) : null,
          m.isOrganizer ? h("span", { class: "chip" }, tr("g_m_org")) : null),
        h("div", { class: "muted small" },
          h("span", { class: `dot ${m.responded ? "ok" : "wait"}` }), status,
          m.tz !== S.me.tz ? ` · ${fmtTz(m.tz, S.now)}, ${tr("g_m_local", { time: fmtTime(Date.now(), m.tz, L) })}` : ""),
        isOrg() && m.id !== S.me.id ? h("button", { class: "link small", onclick: () => { if (confirm(tr("g_m_remove_confirm", { name: m.name }))) void api("POST", `/members/${m.id}/remove`); } }, tr("g_m_remove")) : null);
    })),
    !isOrg() ? h("button", { class: "link small danger-text", onclick: () => { if (confirm(tr("g_leave_confirm"))) void api("POST", `/members/${S.me.id}/remove`); } }, tr("g_leave")) : null,
  );
}

function myCalendarsCard(): HTMLElement {
  const conns = S.mine.connections;
  const back = encodeURIComponent(`/groups/${S.group.id}`);
  if (!conns.length) {
    return h("section", { class: "card" }, h("h3", {}, tr("g_my_cals")),
      h("p", { class: "small" }, tr("g_no_cals"), " ", h("a", { href: `/calendars?back=${back}` }, tr("g_connect")), "."));
  }
  const toggle = (id: string, on: boolean) => {
    const used = new Set(conns.filter((c) => c.used).map((c) => c.id));
    if (on) used.add(id); else used.delete(id);
    void api("PUT", "/calendars", { ids: [...used] });
  };
  return h("section", { class: "card" },
    h("h3", {}, tr("g_my_cals")),
    h("ul", { class: "my-cals" }, conns.map((c) => h("li", {},
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: c.used, onchange: (e) => toggle(c.id, (e.target as HTMLInputElement).checked) }), c.label),
      h("span", { class: `muted small ${c.status === "error" ? "danger-text" : ""}` },
        c.status === "error" ? errText(L, c.error) : c.status === "new" || !c.syncedAt ? tr("g_syncing") : tr("g_synced", { ago: fmtAgo(c.syncedAt, Date.now(), L) }))))),
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => void api("POST", "/sync") }, tr("g_sync")),
      h("a", { class: "small", href: `/calendars?back=${back}` }, tr("g_connect"))),
  );
}

/* ---------- the grid ---------- */

interface Cell { s: number; e: number; col: number; row: number; out: boolean }
let cells: Cell[] = [];
let cellEls: HTMLElement[] = [];
let days: string[] = [];
const ROWS = 48;

function buildCells() {
  const { lo, hi } = S.group;
  days = [];
  for (let d = ymdOf(lo, viewTz); d <= ymdOf(hi - 1, viewTz); d = addDays(d, 1)) days.push(d);
  cells = [];
  days.forEach((d, col) => {
    const p = parseYmd(d)!;
    const next = parseYmd(addDays(d, 1))!;
    for (let row = 0; row < ROWS; row++) {
      const s = zonedToUtc(p.y, p.m, p.d, Math.floor(row / 2), (row % 2) * 30, viewTz);
      const e = row === ROWS - 1 ? zonedToUtc(next.y, next.m, next.d, 0, 0, viewTz) : zonedToUtc(p.y, p.m, p.d, Math.floor((row + 1) / 2), ((row + 1) % 2) * 30, viewTz);
      cells.push({ s, e, col, row, out: e <= s || s < lo || e > hi });
    }
  });
}

/** For each cell (sorted by time), whether the list (sorted, merged) overlaps it. */
function coverage(list: Iv[]): boolean[] {
  const out: boolean[] = new Array(cells.length).fill(false);
  const order = cells.map((c, i) => i).sort((a, b) => cells[a]!.s - cells[b]!.s);
  let j = 0;
  for (const i of order) {
    const c = cells[i]!;
    while (j < list.length && list[j]![1] <= c.s) j++;
    out[i] = j < list.length && list[j]![0] < c.e;
  }
  return out;
}

function markAt(marks: Mark[], s: number, e: number): 0 | 1 | null {
  const mid = s + (e - s) / 2;
  for (const [a, b, st] of marks) if (a <= mid && mid < b) return st;
  return null;
}

function paintCells() {
  if (mode === "all") {
    const responded = S.members.filter((m) => m.responded);
    const covs = responded.map((m) => coverage(m.unavailable));
    cells.forEach((c, i) => {
      const el = cellEls[i]!;
      if (c.out) { el.className = "cell out"; return; }
      const free = covs.filter((cv) => !cv[i]).length;
      const n = responded.length;
      const lvl = n === 0 ? 0 : free === n ? 6 : Math.round((free / n) * 5);
      el.className = `cell lv${lvl}${selected && selected.s === c.s ? " sel" : ""}`;
    });
  } else {
    const me = S.members.find((m) => m.id === S.me.id)!;
    const cal = coverage(S.mine.calendarBusy);
    cells.forEach((c, i) => {
      const el = cellEls[i]!;
      if (c.out) { el.className = "cell out"; return; }
      const mk = markAt(S.mine.marks, c.s, c.e);
      let cls = mk === 1 ? "can" : mk === 0 ? "cant" : me.hasCalendars ? (cal[i] ? "calbusy" : "basefree") : "unset";
      if (mk !== null && cal[i]) cls += " calhint";
      if (anchor && anchor.col === c.col && anchor.row === c.row) cls += " anchor";
      el.className = `cell ${cls}`;
    });
  }
}

function cellIndex(col: number, row: number) { return col * ROWS + row; }

function strokesFor(a: { col: number; row: number }, b: { col: number; row: number }) {
  const [c0, c1] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
  const [r0, r1] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
  const strokes: { start: number; end: number; state: typeof brush }[] = [];
  for (let col = c0; col <= c1; col++) {
    const s = cells[cellIndex(col, r0)]!.s, e = cells[cellIndex(col, r1)]!.e;
    if (e > s) strokes.push({ start: s, end: e, state: brush });
  }
  return strokes;
}

function applyStrokes(strokes: { start: number; end: number; state: typeof brush }[]) {
  let marks = S.mine.marks;
  for (const st of strokes) marks = applyStroke(marks, st.start, st.end, st.state === "clear" ? null : st.state === "free" ? 1 : 0);
  S = { ...S, mine: { ...S.mine, marks } };
  paintCells();
  void api("POST", "/marks", { strokes });
}

function highlight(a: { col: number; row: number }, b: { col: number; row: number }) {
  const [c0, c1] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
  const [r0, r1] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
  cells.forEach((c, i) => cellEls[i]!.classList.toggle("drag", c.col >= c0 && c.col <= c1 && c.row >= r0 && c.row <= r1));
}

function gridCard(): HTMLElement {
  buildCells();
  const tzs = [...new Set([S.me.tz, S.group.tz, ...S.members.map((m) => m.tz)])];
  const tzSel = h("select", { onchange: (e) => { viewTz = (e.target as HTMLSelectElement).value; selected = null; anchor = null; render(); } },
    tzs.map((z) => h("option", { value: z, selected: z === viewTz }, fmtTz(z, S.now)))) as HTMLSelectElement;

  const seg = (cur: string, items: [string, string][], on: (v: string) => void) =>
    h("div", { class: "seg" }, items.map(([v, label]) => h("button", { class: cur === v ? "on" : "", onclick: () => on(v) }, label)));

  const grid = h("div", { class: "grid", style: null });
  grid.style.gridTemplateColumns = `3.2em repeat(${days.length}, minmax(2.6em, 1fr))`;
  grid.append(h("div", { class: "corner" }));
  days.forEach((d) => {
    const p = parseYmd(d)!;
    const noon = zonedToUtc(p.y, p.m, p.d, 12, 0, viewTz);
    const parts = new Intl.DateTimeFormat(L === "ru" ? "ru-RU" : "en-GB", { timeZone: viewTz, weekday: "short", day: "numeric", month: "short" }).formatToParts(noon);
    const part = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
    grid.append(h("div", { class: "day-head" }, h("span", { class: "wd" }, part("weekday").replace(".", "")), h("b", {}, part("day")), h("span", {}, part("month").replace(".", ""))));
  });
  cellEls = [];
  const cellNodes: HTMLElement[][] = days.map(() => []);
  cells.forEach((c, i) => {
    const el = h("div", { class: "cell", "data-i": i });
    cellEls.push(el);
    cellNodes[c.col]!.push(el);
  });
  for (let row = 0; row < ROWS; row++) {
    grid.append(h("div", { class: `time ${row % 2 ? "half" : ""}` }, row % 2 ? "" : `${String(row / 2).padStart(2, "0")}:00`));
    for (let col = 0; col < days.length; col++) grid.append(cellNodes[col]![row]!);
  }

  // Interaction.
  const idxOf = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>(".cell");
    return el ? Number(el.dataset.i) : -1;
  };
  let dragFrom: { col: number; row: number } | null = null;
  let dragTo: { col: number; row: number } | null = null;
  grid.addEventListener("pointerdown", (e) => {
    const i = idxOf(e.target);
    if (i < 0 || cells[i]!.out) return;
    const c = cells[i]!;
    if (mode === "all") {
      selected = { s: c.s, e: c.e };
      paintCells();
      renderInfo();
      return;
    }
    if (e.pointerType !== "mouse") return; // touch: taps, handled on click
    e.preventDefault();
    painting = true;
    dragFrom = dragTo = { col: c.col, row: c.row };
    highlight(dragFrom, dragTo);
  });
  grid.addEventListener("pointermove", (e) => {
    if (!painting || !dragFrom) return;
    const i = idxOf(document.elementFromPoint(e.clientX, e.clientY));
    if (i < 0) return;
    dragTo = { col: cells[i]!.col, row: cells[i]!.row };
    highlight(dragFrom, dragTo);
  });
  const finish = () => {
    if (!painting || !dragFrom || !dragTo) return;
    painting = false;
    cellEls.forEach((el) => el.classList.remove("drag"));
    applyStrokes(strokesFor(dragFrom, dragTo));
    dragFrom = dragTo = null;
  };
  window.addEventListener("pointerup", finish);
  grid.addEventListener("click", (e) => {
    if (mode !== "me" || (e as PointerEvent).pointerType === "mouse") return;
    const i = idxOf(e.target);
    if (i < 0 || cells[i]!.out) return;
    const c = cells[i]!;
    if (!anchor) { anchor = { col: c.col, row: c.row }; paintCells(); return; }
    const a = anchor;
    anchor = null;
    applyStrokes(strokesFor(a, { col: c.col, row: c.row }));
  });

  const scroller = h("div", { class: "grid-scroll" }, grid);
  const touch = matchMedia("(pointer: coarse)").matches;
  const card = h("section", { class: "card grid-card" },
    h("div", { class: "row-between wrap" },
      h("h2", {}, tr("g_grid")),
      seg(mode, [["all", tr("g_mode_all")], ["me", tr("g_mode_me")]], (v) => { mode = v as typeof mode; selected = null; anchor = null; render(); })),
    h("div", { class: "row wrap toolbar" },
      h("label", { class: "inline-label" }, tr("g_tz"), " ", tzSel),
      mode === "me" ? seg(brush, [["free", tr("g_brush_can")], ["busy", tr("g_brush_cant")], ["clear", tr("g_brush_clear")]], (v) => { brush = v as typeof brush; anchor = null; render(); }) : null,
      mode === "me" && S.mine.marks.length ? h("button", { class: "link small", onclick: () => { if (confirm(tr("g_clear_confirm"))) void api("POST", "/marks/clear"); } }, tr("g_clear_all")) : null),
    h("p", { class: "muted small" }, mode === "all" ? tr("g_legend_all") : `${touch ? tr("g_paint_hint_touch") : tr("g_paint_hint")} ${tr("g_legend_me")}`),
    scroller,
    h("div", { id: "cell-info" }),
  );
  return card;
}

function renderInfo() {
  const box = document.getElementById("cell-info");
  if (!box) return;
  box.replaceChildren();
  if (!selected || mode !== "all") return;
  const { s, e } = selected;
  const responded = S.members.filter((m) => m.responded);
  const busy = responded.filter((m) => overlapsAny(m.unavailable, s, e));
  const free = responded.length - busy.length;
  const canPropose = !S.group.confirmedId && s + durMs() <= S.group.hi + 86_400_000;
  box.append(h("div", { class: "cell-info" },
    h("b", {}, fmtRange(s, e, viewTz, L)),
    h("span", {}, busy.length === 0 ? tr("g_cell_all_free") : tr("g_cell_free", { n: free, total: responded.length })),
    busy.length ? h("span", { class: "muted" }, tr("g_cell_busy", { names: busy.map((m) => m.name).join(", ") })) : null,
    canPropose ? h("button", { class: "small primary", onclick: () => void api("POST", "/proposals", { start: s }) }, tr("g_propose_at", { time: fmtTime(s, viewTz, L) })) : null,
  ));
}

/* ---------- page ---------- */

function render() {
  const app = document.getElementById("app")!;
  const oldScroll = app.querySelector<HTMLElement>(".grid-scroll");
  const scroll = oldScroll ? { x: oldScroll.scrollLeft, y: oldScroll.scrollTop } : null;
  const alone = S.members.length === 1;
  const main = h("div", { class: "main-col" },
    confirmedCard(),
    alone ? shareCard(true) : null,
    suggestionsCard(),
    proposalsCard(),
    gridCard(),
  );
  const side = h("aside", { class: "side-col" }, membersCard(), myCalendarsCard(), shareCard(false),
    h("p", { class: "muted small" }, tr("g_expires", { date: fmtYmd(S.group.expiresOn, L) })),
    h("p", { class: "muted small" }, tr("g_tz_note", { tz: fmtTz(viewTz, S.now) })));
  app.replaceChildren(header(), h("div", { class: "layout" }, main, side));
  paintCells();
  renderInfo();
  const sc = app.querySelector<HTMLElement>(".grid-scroll")!;
  if (scroll) { sc.scrollLeft = scroll.x; sc.scrollTop = scroll.y; }
  else {
    // First view: start around 08:00.
    const row = sc.querySelector<HTMLElement>(`.cell[data-i="${16}"]`);
    if (row) sc.scrollTop = Math.max(0, row.offsetTop - 40);
  }
}

render();
setInterval(() => void poll(), 15_000);
setInterval(() => { if (S.mine.connections.some((c) => c.status === "new")) void poll(); }, 4_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
