import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createVendor } from "../server/vendor.js";
import { ROOT } from "../server/config.js";
import { openStore } from "../server/store.js";
import { runMorningEmails, digestsFor, noticeId } from "../server/notify.js";
import { createMailer } from "../server/mailer.js";
import { createWeather, placeCandidates, mapForecast } from "../server/weather.js";
import { createAi, parseJsonReply } from "../server/ai.js";
import { snapshot, prune } from "../server/backup.js";
import { quiet } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fieldbook-unit-"));

test("the website is self-contained: no Claude platform code, no outside scripts or fonts", () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(ROOT, "web"));
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(text, /window\.claude|\bclaude\.ai\b|artifact/i, f);
    assert.doesNotMatch(text, /fonts\.googleapis|cdnjs\.cloudflare|unpkg\.com|jsdelivr/, f);
  }
  const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  assert.doesNotMatch(html, /<script>|<style>/, "no inline code (the CSP forbids it)");
  for (const ref of html.match(/(?:src|href)="(static\/[^"]+)"/g).map((x) => x.split('"')[1])) assert.ok(fs.existsSync(path.join(ROOT, "web", ref)), ref);
  assert.doesNotMatch(html, /(?:src|href)="\//, "links are relative so the pages also work from github.io/<repo>/");
  execFileSync(process.execPath, ["--check", path.join(ROOT, "web", "static", "fieldbook.js")]);
});

test("PDF reader: downloaded once, then served from the saved copy", async () => {
  const dir = tmp();
  let calls = 0;
  const body = "/* pdf.js */ " + "x".repeat(60_000);
  const v = createVendor({ dataDir: dir }, quiet, async () => { calls++; return new Response(body); });
  const { PassThrough } = await import("node:stream");
  for (let i = 0; i < 2; i++) {
    const res = Object.assign(new PassThrough(), { writeHead(s) { res.status = s; } });
    const got = new Promise((r) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => r(t)); });
    await v.serve({}, res, "/vendor/pdfjs/pdf.min.js");
    assert.equal(res.status, 200);
    assert.equal((await got).length, body.length);
  }
  assert.equal(calls, 1);
  const res = { writeHead(s) { res.status = s; }, end() {} };
  await v.serve({}, res, "/vendor/pdfjs/evil.js");
  assert.equal(res.status, 404);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("weather: address parsing and forecast mapping", async () => {
  assert.deepEqual(placeCandidates("482 Maple St, Garden Grove, CA 92840"), { names: ["Garden Grove"], state: "California" });
  assert.deepEqual(placeCandidates("12 Lê Lợi, Phường Bến Nghé, TP. Hồ Chí Minh").names[0], "Hồ Chí Minh");
  const days = mapForecast({ daily: { time: ["2026-10-01"], weather_code: [95], temperature_2m_max: [31.26], temperature_2m_min: [18], apparent_temperature_max: [33], precipitation_probability_max: [40], precipitation_sum: [3.1], wind_gusts_10m_max: [52] } });
  assert.deepEqual(days[0], { date: "2026-10-01", icon: 15, phrase: "Thunderstorm", hi: 31.3, lo: 18, feel: 33, rain: 40, thunder: 60, rainMm: 3.1, gust: 52 });

  const dir = tmp();
  const store = openStore(dir);
  store.set("projects", "p1", { name: "Harlow", address: "482 Maple St, Garden Grove, CA 92840" });
  store.set("projects", "p2", { name: "Old", address: "1 A St, Irvine, CA", archived: true });
  store.set("weather", "gone", { address: "x" });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes("geocoding")
      ? { results: [{ name: "Garden Grove", latitude: 33.77, longitude: -117.94, country_code: "US", admin1: "California", timezone: "America/Los_Angeles" }] }
      : { timezone: "America/Los_Angeles", daily: { time: ["2026-10-01", "2026-10-02"], weather_code: [0, 61], temperature_2m_max: [30, 25], temperature_2m_min: [17, 15], apparent_temperature_max: [31, 25], precipitation_probability_max: [0, 70], precipitation_sum: [0, 4], wind_gusts_10m_max: [20, 30] } };
    return { ok: true, json: async () => body };
  };
  const w = createWeather(store, { fetchImpl, log: quiet });
  const r = await w.refresh();
  assert.equal(r.changed, 2);
  const doc = store.get("weather", "p1").data;
  assert.equal(doc.place, "Garden Grove, CA");
  assert.equal(doc.days.length, 2);
  assert.equal(doc.days[1].icon, 12);
  assert.equal(store.get("weather", "gone"), undefined);
  const n = calls.length;
  await w.refresh();
  assert.equal(calls.length, n, "fresh forecasts aren't fetched again");
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// A tiny SMTP server that records what it receives (plain, no TLS — tests only).
function smtpCatcher() {
  const mails = [];
  const server = net.createServer((sock) => {
    let data = false, buf = "", cur = { rcpt: [] };
    sock.write("220 test\r\n");
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === ".") { data = false; mails.push(cur); cur = { rcpt: [] }; sock.write("250 ok\r\n"); } else cur.body = (cur.body || "") + line + "\n"; continue; }
        if (/^EHLO/i.test(line)) sock.write("250 test\r\n");
        else if (/^MAIL/i.test(line)) sock.write("250 ok\r\n");
        else if (/^RCPT TO:<(.+)>/i.test(line)) { cur.rcpt.push(/<(.+)>/.exec(line)[1]); sock.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { data = true; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ mails, port: server.address().port, close: () => server.close() })));
}

test("morning e-mails go out once, after the send time, only to the project team", async () => {
  const smtp = await smtpCatcher();
  const dir = tmp();
  const store = openStore(dir);
  const mailer = createMailer({ smtpUrl: `smtp://127.0.0.1:${smtp.port}?tls=off`, mailFrom: "fieldbook@example.com" }, quiet);
  store.set("settings", "notify", { enabled: true, tz: "Asia/Ho_Chi_Minh", hour: 7, minute: 0 });
  store.set("team", "t1", { name: "Linh Pham", email: "linh@example.com" });
  store.set("team", "t2", { name: "Minh Do", email: "minh@example.com" });
  store.set("team", "t3", { name: "Off Team", email: "off@example.com" });
  store.set("projects", "p1", { name: "Harlow", address: "482 Maple St", teamIds: ["t1", "t2"] });
  store.set("events", "e1", { projectId: "p1", date: "2026-10-02", title: "Roof inspection", startTime: "08:30", assigneeIds: ["t1", "t2", "t3"] });
  store.set("events", "e2", { projectId: "p1", date: "2026-10-02", title: "Quiet one", assigneeIds: ["t1"], notify: false });
  const config = { mailLang: "en", publicUrl: "https://fieldbook.example.com" };
  // 06:59 in Ho Chi Minh City → too early
  let r = await runMorningEmails(store, config, mailer, new Date("2026-10-01T23:59:00Z"), quiet);
  assert.equal(r.skipped, "before send time");
  // 07:05 → sends to Linh and Minh, not to the person who isn't on the team
  r = await runMorningEmails(store, config, mailer, new Date("2026-10-02T00:05:00Z"), quiet);
  assert.equal(r.sent, 2);
  assert.deepEqual(smtp.mails.map((m) => m.rcpt[0]).sort(), ["linh@example.com", "minh@example.com"]);
  assert.equal(store.get("notices", noticeId("2026-10-02", "e1", "t1")).data.status, "sent");
  // running again sends nothing new
  r = await runMorningEmails(store, config, mailer, new Date("2026-10-02T00:20:00Z"), quiet);
  assert.equal(r.sent, 0);
  assert.equal(digestsFor(store, "2026-10-02").length, 2);
  smtp.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("AI: streams text and reads JSON replies", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(opts.headers["x-api-key"], "sk-test");
    assert.equal(body.messages[0].content[0].type, "image");
    const events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: '{"vendor":' } },
      { type: "content_block_delta", delta: { type: "text_delta", text: '"Home Depot","total":12.5}' } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ];
    const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(text, { status: 200 });
  };
  try {
    const ai = createAi({ anthropicKey: "sk-test", model: "m", modelQuick: "q", modelComplex: "c" });
    const deltas = [];
    const out = await ai.complete({ input: "read", images: [{ mediaType: "image/png", data: "AAAA" }], json: true }, (d) => deltas.push(d));
    assert.equal(deltas.length, 2);
    assert.deepEqual(parseJsonReply(out.text), { vendor: "Home Depot", total: 12.5 });
    assert.deepEqual(parseJsonReply('Sure!\n```json\n[1,2]\n```'), [1, 2]);
  } finally { globalThis.fetch = realFetch; }
});

test("backups: snapshot and keep the newest", () => {
  const dir = tmp();
  const store = openStore(dir);
  store.set("projects", "p1", { name: "A" });
  const f = snapshot(store);
  assert.ok(fs.statSync(f).size > 0);
  const bdir = path.dirname(f);
  for (const s of ["20260101-000000", "20260102-000000", "20260103-000000"]) fs.writeFileSync(path.join(bdir, `fieldbook-${s}.db`), "x");
  prune(bdir, 2);
  assert.equal(fs.readdirSync(bdir).length, 2);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("AI: a local OpenAI-compatible server (e.g. Ollama) works too", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), auth: opts.headers.authorization };
    const chunks = ['{"vendor":"Ace', ' Hardware","total":9}'].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    return new Response(chunks.join("") + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const ai = createAi({ aiProvider: "openai", aiBaseUrl: "http://192.168.1.20:11434/v1/", model: "qwen2.5vl:7b" }, fetchImpl);
  assert.equal(ai.enabled, true);
  const out = await ai.complete({ input: "read", images: [{ mediaType: "image/jpeg", data: "AAAA" }], json: true });
  assert.equal(seen.url, "http://192.168.1.20:11434/v1/chat/completions");
  assert.equal(seen.body.model, "qwen2.5vl:7b");
  assert.equal(seen.body.messages[0].role, "system");
  assert.equal(seen.body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(seen.auth, undefined);
  assert.deepEqual(parseJsonReply(out.text), { vendor: "Ace Hardware", total: 9 });
  assert.equal(createAi({}).enabled, false);
});

test("GitHub Pages build: server address, page security policy, sub-folder links", async () => {
  const { buildPages } = await import("../scripts/build-pages.mjs");
  const out = path.join(tmp(), "site");
  assert.throws(() => buildPages({ api: "http://192.168.1.10:8080", out }), /https/);
  buildPages({ api: "https://fieldbook-api.example.com/", out });
  assert.match(fs.readFileSync(path.join(out, "static", "config.js"), "utf8"), /window\.FIELDBOOK_API = "https:\/\/fieldbook-api\.example\.com";/);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src 'self' data: blob: https:\/\/fieldbook-api\.example\.com/);
  assert.doesNotMatch(html, /fieldbook:csp/);
  for (const f of ["login.html", "setup.html", "signup.html", "account.html", ".nojekyll"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  // without a bundled PDF reader the NAS's copy is used (and allowed)
  assert.match(fs.readFileSync(path.join(out, "static", "fieldbook.js"), "utf8"), /const PDFJS_BASE = "https:\/\/fieldbook-api\.example\.com\/vendor\/pdfjs\/";/);
  assert.match(html, /script-src 'self' https:\/\/fieldbook-api\.example\.com;/);
  // the source pages are untouched
  assert.match(fs.readFileSync(path.join(ROOT, "web", "static", "config.js"), "utf8"), /FIELDBOOK_API = "";/);
});
