// Morning e-mails: on the day of an event, each assigned person on the project
// team gets one e-mail listing their events for that day, once the company's
// send time (Settings → Morning e-mails) has passed in its time zone.
// Every (day, event, person) is recorded in "notices" — the page shows that log —
// so nothing is sent twice; failures are retried with back-off.
const DEFAULTS = { enabled: true, tz: "America/Los_Angeles", hour: 7, minute: 0 };
const MAX_ATTEMPTS = 8;

export function notifySettings(store) {
  const d = store.get("settings", "notify")?.data || {};
  let tz = d.tz || DEFAULTS.tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULTS.tz; }
  const n = (v, lo, hi, dflt) => { v = Number(v); return Number.isInteger(v) && v >= lo && v <= hi ? v : dflt; };
  return { enabled: d.enabled !== false, tz, hour: n(d.hour, 0, 23, DEFAULTS.hour), minute: n(d.minute, 0, 59, DEFAULTS.minute), lang: d.lang };
}
export function tzNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
export const noticeId = (date, eventId, personId) => `${date}_${eventId}_${personId}`;

const T = {
  en: {
    one: (e, p) => `Today: ${e.title} — ${p}${e.startTime ? ` (${clock(e.startTime, "en")})` : ""}`,
    many: (n) => `Today's schedule: ${n} events`,
    hello: (n) => `Good morning ${n},`, intro: (d) => `Here's what you're scheduled for today, ${d}:`,
    allDay: "All day", where: "Where", notes: "Notes", with: "With", open: "Open in Fieldbook",
  },
  vi: {
    one: (e, p) => `Hôm nay: ${e.title} — ${p}${e.startTime ? ` (${clock(e.startTime, "vi")})` : ""}`,
    many: (n) => `Lịch hôm nay: ${n} sự kiện`,
    hello: (n) => `Chào buổi sáng ${n},`, intro: (d) => `Lịch của bạn hôm nay, ${d}:`,
    allDay: "Cả ngày", where: "Địa điểm", notes: "Ghi chú", with: "Cùng với", open: "Mở trong Fieldbook",
  },
};
function clock(hhmm, lang) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h)) return String(hhmm || "");
  if (lang === "vi") return `${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const longDay = (date, lang) => new Date(date + "T12:00:00Z").toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Who gets what today: [{ person, events:[{event, project, others[]}] }] — same rules as the page's preview. */
export function digestsFor(store, date) {
  const projects = new Map(store.list("projects").map((d) => [d.id, d.data]));
  const team = new Map(store.list("team").map((d) => [d.id, { id: d.id, ...d.data }]));
  const out = new Map();
  for (const { id, data: e } of store.list("events")) {
    if (e.date !== date || e.notify === false) continue;
    const p = projects.get(e.projectId);
    if (!p || p.archived) continue;
    const onTeam = new Set(p.teamIds || []);
    const assignees = (e.assigneeIds || []).filter((x) => onTeam.has(x) && team.has(x));
    for (const pid of assignees) {
      if (!out.has(pid)) out.set(pid, { person: team.get(pid), events: [] });
      out.get(pid).events.push({ event: { id, ...e }, project: { id: e.projectId, ...p }, others: assignees.filter((x) => x !== pid).map((x) => team.get(x).name || "") });
    }
  }
  for (const d of out.values()) d.events.sort((a, b) => String(a.event.startTime || "").localeCompare(String(b.event.startTime || "")) || String(a.event.title).localeCompare(String(b.event.title)));
  return [...out.values()];
}

export function compose(d, date, lang, publicUrl) {
  const t = T[lang] || T.en;
  const first = String(d.person.name || "").split(" ")[0];
  const subject = d.events.length === 1 ? t.one(d.events[0].event, d.events[0].project.name || "") : t.many(d.events.length);
  const when = (e) => (e.startTime ? clock(e.startTime, lang) + (e.endTime ? "–" + clock(e.endTime, lang) : "") : t.allDay);
  const text = [t.hello(first), "", t.intro(longDay(date, lang)), "",
    ...d.events.flatMap(({ event: e, project: p, others }) => [
      `• ${when(e)} — ${e.title} (${p.name || ""})`,
      ...(p.address ? [`  ${t.where}: ${p.address}`] : []),
      ...(e.notes ? [`  ${t.notes}: ${e.notes}`] : []),
      ...(others.length ? [`  ${t.with}: ${others.join(", ")}`] : []), "",
    ]), publicUrl ? `${t.open}: ${publicUrl}/` : "", "— Fieldbook"].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2933;max-width:560px">
    <p>${esc(t.hello(first))}</p><p>${esc(t.intro(longDay(date, lang)))}</p>
    ${d.events.map(({ event: e, project: p, others }) => `<div style="border:1px solid #d9dee4;border-radius:8px;padding:12px 14px;margin:10px 0">
      <div style="font-size:13px;color:#a8641c;font-weight:600">${esc(when(e))}</div>
      <div style="font-size:16px;font-weight:600;margin:2px 0">${esc(e.title)}</div>
      <div style="font-size:14px;color:#52606d">${esc(p.name || "")}</div>
      ${p.address ? `<div style="font-size:14px;margin-top:6px">${esc(t.where)}: ${esc(p.address)}</div>` : ""}
      ${e.notes ? `<div style="font-size:14px;margin-top:4px">${esc(t.notes)}: ${esc(e.notes)}</div>` : ""}
      ${others.length ? `<div style="font-size:14px;margin-top:4px">${esc(t.with)}: ${esc(others.join(", "))}</div>` : ""}
    </div>`).join("")}
    ${publicUrl ? `<p><a href="${esc(publicUrl)}/" style="color:#a8641c">${esc(t.open)}</a></p>` : ""}</div>`;
  return { subject, text, html };
}

/** Sends whatever is due right now. Safe to call as often as you like. */
export async function runMorningEmails(store, config, mailer, now = new Date(), log = console) {
  const s = notifySettings(store);
  if (!s.enabled) return { skipped: "disabled", sent: 0 };
  if (mailer.kind === "none") return { skipped: "no mail server", sent: 0 };
  const local = tzNow(s.tz, now);
  if (local.hour * 60 + local.minute < s.hour * 60 + s.minute) return { skipped: "before send time", sent: 0 };
  const date = local.date;
  const lang = s.lang === "vi" || s.lang === "en" ? s.lang : config.mailLang;
  let sent = 0, failed = 0;
  for (const d of digestsFor(store, date)) {
    if (!d.person.email) continue;
    const due = d.events.filter(({ event }) => {
      const n = store.get("notices", noticeId(date, event.id, d.person.id))?.data;
      if (!n) return true;
      if (n.status !== "failed") return false;
      const attempts = n.attempts || 1;
      return attempts < MAX_ATTEMPTS && now - Date.parse(n.at || 0) >= 60000 * 2 ** (attempts - 1);
    });
    if (!due.length) continue;
    const msg = compose({ ...d, events: due }, date, lang, config.publicUrl);
    let status = "sent", error = "";
    try { await mailer.send({ to: d.person.email, toName: d.person.name, ...msg }); sent++; }
    catch (e) { status = "failed"; error = String(e.message || e).slice(0, 300); failed++; log.error?.(`[mail] ${d.person.email}: ${error}`); }
    for (const { event } of due) {
      const id = noticeId(date, event.id, d.person.id);
      const prev = store.get("notices", id)?.data;
      store.set("notices", id, { eventId: event.id, personId: d.person.id, date, status, at: now.toISOString(), via: "email", attempts: (prev?.attempts || 0) + 1, ...(error ? { error } : {}) });
    }
  }
  return { date, sent, failed };
}

export function startNotifier(store, config, mailer, log = console) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runMorningEmails(store, config, mailer, new Date(), log); }
    catch (e) { log.error?.("[notify]", e.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 60_000); timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return () => clearInterval(timer);
}
