// HTTP server: pages, sign-in, the document API the Fieldbook page uses, files,
// AI and live updates. Node's built-in http module only — no packages to install.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./config.js";
import { openStore } from "./store.js";
import { createAuth, passwordProblem, validEmail } from "./auth.js";
import { createRules, validName } from "./rules.js";
import { createAi, parseJsonReply, IMAGE_LIMITS } from "./ai.js";
import { createMailer } from "./mailer.js";
import { createVendor } from "./vendor.js";

const WEB = path.join(ROOT, "web");
const MAX_JSON = 8 * 1024 * 1024;

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const bad = (m, code = "bad_request") => new HttpError(400, m, code);
const forbidden = (m = "You don't have access to this.") => new HttpError(403, m, "permission_denied");

function parseCookies(h) {
  const out = {};
  for (const part of String(h || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}
// Over the limit, the rest of the body is read and thrown away so the browser
// still receives the 413 answer (cutting the connection looks like "offline").
// Only something far over the limit is cut off.
function readBody(req, limit, message = "That's too large.") {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit * 4) { req.destroy(); reject(new HttpError(413, message, "too_large")); return; }
      if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
    });
    req.on("end", () => (over ? reject(new HttpError(413, message, "too_large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}
async function readJson(req, limit = MAX_JSON, message) {
  const buf = await readBody(req, limit, message);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { throw bad("Invalid JSON"); }
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Small fixed-window limiter (per key).
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.until < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.until < now) { h = { n: 0, until: now + windowMs }; hits.set(key, h); }
    h.n++;
    return h.n <= max;
  };
}

// Everything the pages run comes from this server; the only outside content is the
// Google Maps embed on the Map page (needs Internet, falls back to a plain link).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data: https://www.google.com https://maps.google.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
// Uploaded files are shown inline only for types a browser can't run as a page.
const INLINE_OK = /^(image\/(jpeg|png|gif|webp|avif|bmp|heic|heif)|application\/pdf|text\/plain|text\/csv|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|webm|ogg))$/i;

export function createApp(config, { log = console } = {}) {
  const store = openStore(config.dataDir);
  const auth = createAuth(store, { sessionDays: config.sessionDays });
  const rules = createRules(store);
  const ai = createAi(config);
  const mailer = createMailer(config, log);
  const vendor = createVendor(config, log);
  const loginTry = limiter(10, 15 * 60_000);       // per address + e-mail
  const loginTryEmail = limiter(30, 15 * 60_000);  // per e-mail, whatever the address
  const signupTry = limiter(5, 60 * 60_000);
  const aiTry = limiter(config.aiPerUserPerHour, 60 * 60_000);
  const streams = new Set();

  const clientIp = (req) => (config.trustProxy && (req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())) || req.socket.remoteAddress || "?";
  const secureReq = (req) => config.cookieSecure || (config.trustProxy && req.headers["x-forwarded-proto"] === "https");

  function setSessionCookie(req, res, token) {
    const parts = [`fb_session=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? config.sessionDays * 86400 : 0}`];
    if (secureReq(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }
  // Signed in by cookie (pages served by this server) or by "Authorization: Bearer <token>"
  // (pages hosted elsewhere, e.g. GitHub Pages — browsers don't send cookies across sites).
  const bearer = (req) => { const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization || "")); return m ? m[1] : ""; };
  const sessionToken = (req) => bearer(req) || parseCookies(req.headers.cookie).fb_session || "";
  const currentUser = (req) => auth.sessionUser(sessionToken(req));
  // Hands out a new session: as a cookie, and also as a token when the page asked for one.
  function signIn(req, res, userId, wantToken) {
    const token = auth.startSession(userId);
    setSessionCookie(req, res, token);
    return send(res, 200, wantToken || bearer(req) ? { ok: true, token } : { ok: true });
  }

  /* Pages on another site (GitHub Pages) may call this server only from ALLOWED_ORIGINS. */
  const fileAncestors = ["'self'", ...config.allowedOrigins].join(" ");
  const allowedOrigin = (req) => { const o = req.headers.origin; return o && config.allowedOrigins.includes(o) ? o : ""; };

  /* Live updates for pages on another site: an EventSource can't send a token, so the page
     first trades its token for a ticket that is valid for a few minutes. */
  const tickets = new Map();
  const TICKET_MS = 5 * 60_000;
  setInterval(() => { const now = Date.now(); for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k); }, 60_000).unref();

  /* Files for pages on another site: <img> and PDF previews can't send a token either, so file
     links carry a key that proves who asked: "<user>.<expires>.<signature>", valid 12 hours. */
  let fileSecret = store.kvGet("fileKeySecret");
  if (!fileSecret) { fileSecret = crypto.randomBytes(32).toString("hex"); store.kvSet("fileKeySecret", fileSecret); }
  const FILE_KEY_MS = 12 * 3600e3;
  const sign = (s) => crypto.createHmac("sha256", fileSecret).update(s).digest("base64url");
  const fileKeyFor = (user) => { const body = `${user.id}.${Date.now() + FILE_KEY_MS}`; return `${body}.${sign(body)}`; };
  function userFromFileKey(k) {
    const m = /^(u_[A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(k || ""));
    if (!m || Number(m[2]) < Date.now()) return null;
    const want = Buffer.from(sign(`${m[1]}.${m[2]}`)), got = Buffer.from(m[3]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const u = auth.findById(m[1]);
    return u && !u.disabled ? u : null;
  }

  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf || typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": isBuf || typeof body === "string" ? headers["content-type"] || "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(payload);
  }
  function sendFile(res, file, extra = {}) {
    let data;
    try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: "Not found" }); }
    send(res, 200, data, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", ...extra });
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: "", isOwner: !!u.is_owner, canEdit: rules.isAdmin(u) });

  /* ---------------- live updates ---------------- */
  store.onChange((coll, id) => {
    const msg = `data: ${JSON.stringify({ coll })}\n\n`;
    for (const s of streams) {
      const self = coll === "accessRequests" || coll === "auditLog";
      const may = coll === "members" || (self ? (s.admin() || id === s.user.id) : s.member());
      if (may) s.res.write(msg);
    }
  });
  const beat = setInterval(() => {
    for (const s of streams) {
      if (!auth.sessionUser(s.token)) { s.res.end(); streams.delete(s); continue; }
      s.res.write(": ping\n\n");
    }
  }, 25_000);
  beat.unref();

  /* ---------------- routes ---------------- */
  async function api(req, res, url, user) {
    const p = url.pathname, m = req.method;
    let mm;

    // --- sign-in (no session needed) ---
    if (p === "/api/auth/state" && m === "GET") return send(res, 200, { needsSetup: auth.needsSetup(), allowSignup: config.allowSignup, signedIn: !!user });
    if (p === "/api/auth/setup" && m === "POST") {
      if (!auth.needsSetup()) throw new HttpError(409, "Fieldbook is already set up. Sign in instead.", "already_setup");
      const b = await readJson(req);
      const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim();
      if (!name) throw bad("Enter your name.");
      if (!validEmail(email)) throw bad("Enter a valid e-mail address.");
      const pw = passwordProblem(b.password); if (pw) throw bad(pw, "weak_password");
      // Checked again now that the body has arrived: only the very first account becomes the owner.
      if (!auth.needsSetup()) throw new HttpError(409, "Fieldbook is already set up. Sign in instead.", "already_setup");
      const u = auth.createUser({ email, name, password: b.password, owner: true });
      log.log?.(`[auth] owner account created: ${email}`);
      return signIn(req, res, u.id, b.token);
    }
    if (p === "/api/auth/login" && m === "POST") {
      const b = await readJson(req);
      const email = String(b.email || "").trim().toLowerCase();
      if (!loginTry(clientIp(req) + "|" + email) || !loginTryEmail(email)) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.", "rate_limited");
      const u = auth.verify(email, String(b.password || ""));
      if (!u) throw new HttpError(401, "Wrong e-mail or password.", "bad_login");
      return signIn(req, res, u.id, b.token);
    }
    if (p === "/api/auth/signup" && m === "POST") {
      if (!config.allowSignup) throw forbidden("New accounts are created by an Admin. Ask them to add you.");
      if (auth.needsSetup()) throw new HttpError(409, "Set up Fieldbook first.", "needs_setup");
      if (!signupTry(clientIp(req))) throw new HttpError(429, "Too many new accounts from this network. Try again later.", "rate_limited");
      const b = await readJson(req);
      const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim();
      if (!name) throw bad("Enter your name.");
      if (!validEmail(email)) throw bad("Enter a valid e-mail address.");
      const pw = passwordProblem(b.password); if (pw) throw bad(pw, "weak_password");
      if (auth.findByEmail(email)) throw new HttpError(409, "There's already an account with this e-mail. Sign in instead.", "exists");
      const u = auth.createUser({ email, name, password: b.password });
      return signIn(req, res, u.id, b.token);
    }
    if (p === "/api/auth/logout" && m === "POST") {
      auth.endSession(sessionToken(req));
      setSessionCookie(req, res, "");
      return send(res, 200, { ok: true });
    }

    if (!user) throw new HttpError(401, "Sign in first.", "unauthenticated");

    // --- who am I ---
    if (p === "/api/me" && m === "GET") return send(res, 200, { user: publicUser(user), role: rules.roleOf(user), ai: ai.enabled, mail: mailer.kind !== "none", allowSignup: config.allowSignup });
    if (p === "/api/profiles" && m === "POST") {
      const b = await readJson(req);
      const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string").slice(0, 500) : [];
      const member = rules.isMember(user);
      const out = {};
      for (const id of ids) {
        if (!member && id !== user.id) continue;
        const u = auth.findById(id);
        if (u) out[id] = { id: u.id, name: u.name, email: u.email, avatarUrl: "" };
      }
      return send(res, 200, { profiles: out });
    }

    // --- own account ---
    if (p === "/api/account/password" && m === "POST") {
      const b = await readJson(req);
      if (!auth.verify(user.email, String(b.current || ""))) throw new HttpError(400, "Your current password is wrong.", "bad_login");
      const pw = passwordProblem(b.password); if (pw) throw bad(pw, "weak_password");
      auth.setPassword(user.id, b.password);              // signs out every other device
      return signIn(req, res, user.id, false);
    }
    if (p === "/api/account/name" && m === "POST") {
      const b = await readJson(req);
      const name = String(b.name || "").trim();
      if (!name) throw bad("Enter your name.");
      auth.setName(user.id, name);
      return send(res, 200, { ok: true });
    }

    // --- sign-in accounts, for Admins (roles are managed inside Fieldbook → Users & access) ---
    if (p.startsWith("/api/accounts")) {
      if (!rules.isAdmin(user)) throw forbidden("Only Admins can manage accounts.");
      const members = new Map(store.list("members").map((d) => [d.id, d.data]));
      if (p === "/api/accounts" && m === "GET") {
        return send(res, 200, { accounts: auth.allUsers().map((u) => ({ ...u, is_owner: !!u.is_owner, disabled: !!u.disabled, role: u.is_owner ? "admin" : members.get(u.id)?.role || null, status: u.is_owner ? "active" : members.get(u.id)?.status || "no access" })) });
      }
      if (p === "/api/accounts" && m === "POST") {
        const b = await readJson(req);
        const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim();
        if (!name) throw bad("Enter a name.");
        if (!validEmail(email)) throw bad("Enter a valid e-mail address.");
        if (auth.findByEmail(email)) throw new HttpError(409, "There's already an account with this e-mail.", "exists");
        const temp = tempPassword();
        const u = auth.createUser({ email, name, password: temp });
        const role = ["admin", "pm", "accountant"].includes(b.role) ? b.role : null;
        if (role) store.set("members", u.id, { role, status: "active", createdAt: new Date().toISOString(), approvedBy: user.id, approvedAt: new Date().toISOString(), projectIds: [] });
        let mailed = false;
        if (b.sendEmail && mailer.kind !== "none") {
          try { await mailer.send(inviteMail({ to: email, name, by: user.name, password: temp, url: config.publicUrl })); mailed = true; } catch (e) { log.error?.("[mail] invite failed: " + e.message); }
        }
        return send(res, 200, { ok: true, id: u.id, password: temp, mailed });
      }
      if ((mm = /^\/api\/accounts\/([^/]+)\/(password|disable|enable)$/.exec(p)) && m === "POST") {
        const target = auth.findById(decodeURIComponent(mm[1]));
        if (!target) throw new HttpError(404, "No such account.", "not_found");
        if (target.is_owner && !user.is_owner) throw forbidden("Only the owner can change the owner's account.");
        if (mm[2] === "password") { const temp = tempPassword(); auth.setPassword(target.id, temp); return send(res, 200, { ok: true, password: temp }); }
        if (target.id === user.id) throw bad("You can't disable your own account.");
        if (target.is_owner) throw bad("The owner account can't be disabled.");
        auth.setDisabled(target.id, mm[2] === "disable");
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, "Not found", "not_found");
    }

    // --- documents ---
    if ((mm = /^\/api\/db\/([^/]+)(?:\/([^/]+))?$/.exec(p))) {
      const coll = decodeURIComponent(mm[1]), id = mm[2] !== undefined ? decodeURIComponent(mm[2]) : null;
      if (!validName(coll) || (id !== null && !validName(id))) throw bad("Invalid name");
      if (id === null && m === "GET") {
        const f = rules.readFilter(user, coll);
        return send(res, 200, { docs: store.list(coll).filter(f).map((d) => ({ id: d.id, data: d.data })) });
      }
      if (id === null && m === "POST") {
        const data = await readJson(req);
        if (!isPlainObject(data)) throw bad("A document must be an object.");
        const newId = store.newId();
        if (!rules.canWrite(user, coll, newId)) throw forbidden("Your role can view this but not change it.");
        store.set(coll, newId, data);
        return send(res, 200, { id: newId });
      }
      if (id !== null && m === "GET") {
        if (!rules.canRead(user, coll, id)) return send(res, 200, { exists: false });
        const d = store.get(coll, id);
        return send(res, 200, d ? { exists: true, data: d.data } : { exists: false });
      }
      if (id !== null && m === "PUT") {
        const selfDoc = (coll === "auditLog" || coll === "accessRequests") && !rules.isAdmin(user);
        let data = await readJson(req, selfDoc ? 512 * 1024 : MAX_JSON);
        if (!isPlainObject(data)) throw bad("A document must be an object.");
        if (!rules.canWrite(user, coll, id)) throw forbidden("Your role can view this but not change it.");
        if (selfDoc && coll === "auditLog") {
          // Merge instead of overwrite: people can add to their own trail but never remove from it
          // (this also keeps events written from two devices at once).
          const old = store.get("auditLog", id)?.data?.events || [];
          const key = (e) => JSON.stringify([e?.at, e?.action, e?.detail]);
          const seen = new Set(old.map(key));
          const added = (Array.isArray(data.events) ? data.events : []).filter((e) => isPlainObject(e) && !seen.has(key(e)));
          data = { events: old.concat(added).sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).slice(-300) };
        }
        store.set(coll, id, data);
        return send(res, 200, { ok: true });
      }
      if (id !== null && m === "DELETE") {
        if (!rules.canWrite(user, coll, id)) throw forbidden("Your role can view this but not change it.");
        if (coll === "auditLog" && !rules.isAdmin(user)) throw forbidden("Only Admins can remove an audit trail.");
        store.del(coll, id);
        return send(res, 200, { ok: true });
      }
    }

    // --- files ---
    if (p === "/api/assets" && m === "POST") {
      if (!rules.isMember(user)) throw forbidden();
      const type = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100) || "application/octet-stream";
      let name = ""; try { name = decodeURIComponent(String(req.headers["x-filename"] || "")).slice(0, 200); } catch {}
      const id = crypto.randomBytes(16).toString("hex");
      const file = store.assetPath(id), tmp = file + ".part";
      const limit = config.maxUploadMb * 1024 * 1024;
      let size = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        let over = false;
        const cleanup = () => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); };
        req.on("data", (c) => {
          size += c.length;
          if (size > limit * 2) { cleanup(); req.destroy(); reject(new HttpError(413, `Files can be up to ${config.maxUploadMb} MB.`, "too_large")); return; }
          if (size > limit && !over) { over = true; req.unpipe(out); cleanup(); req.resume(); }
        });
        req.on("end", () => { if (over) reject(new HttpError(413, `Files can be up to ${config.maxUploadMb} MB.`, "too_large")); });
        req.on("aborted", () => { cleanup(); reject(new HttpError(400, "Upload interrupted.", "aborted")); });
        req.on("error", (e) => { cleanup(); reject(e); });
        req.pipe(out);
        out.on("finish", () => { if (!over) resolve(); });
        out.on("error", (e) => { cleanup(); reject(e); });
      });
      if (!size) { fs.rmSync(tmp, { force: true }); throw bad("The file is empty."); }
      fs.renameSync(tmp, file);
      store.addAsset({ id, userId: user.id, contentType: type, size, name });
      return send(res, 200, { id, url: `/assets/${id}`, size, type });
    }
    if ((mm = /^\/api\/assets\/([a-f0-9]{32})$/.exec(p)) && m === "DELETE") {
      if (!rules.isMember(user)) throw forbidden();
      const a = store.getAsset(mm[1]);
      if (!a) return send(res, 200, { ok: true });
      const role = rules.roleOf(user);
      if (a.user_id !== user.id && role !== "admin" && role !== "accountant" && role !== "pm") throw forbidden();
      store.delAsset(mm[1]);
      return send(res, 200, { ok: true });
    }

    // --- AI ---
    if (p === "/api/sample/limits" && m === "GET") {
      if (!ai.enabled) throw new HttpError(503, "AI isn't set up on this server.", "not_granted");
      return send(res, 200, { images: IMAGE_LIMITS });
    }
    if (p === "/api/sample" && m === "POST") {
      if (!ai.enabled) throw new HttpError(503, "AI isn't set up on this server (AI settings in .env).", "not_granted");
      if (!rules.isMember(user)) throw forbidden();
      if (!aiTry(user.id)) throw new HttpError(429, "Too many AI requests this hour. Try again later.", "rate_limited");
      const b = await readJson(req, Math.ceil(IMAGE_LIMITS.maxCount * IMAGE_LIMITS.maxInputBytes * 1.4) + MAX_JSON, "Those images are too large. Use smaller photos (under 5 MB each).");
      const images = (Array.isArray(b.images) ? b.images : []).slice(0, IMAGE_LIMITS.maxCount);
      const imgBytes = images.reduce((n, i) => n + Math.floor(String(i?.data || "").length * 0.75), 0);
      if (imgBytes > IMAGE_LIMITS.maxCount * IMAGE_LIMITS.maxInputBytes) throw bad("Images are too large.", "image_rejected");
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      const stop = new AbortController();
      res.on("close", () => { if (!res.writableFinished) stop.abort(); });
      try {
        const out = await ai.complete({ input: b.input, images, json: !!b.json, modelTier: b.modelTier, maxTokens: b.maxTokens, signal: stop.signal }, (d) => res.write(JSON.stringify({ d }) + "\n"));
        const fin = { done: true, text: out.text, truncated: out.truncated };
        if (b.json) fin.json = parseJsonReply(out.text) ?? null;
        res.end(JSON.stringify(fin) + "\n");
      } catch (e) {
        if (stop.signal.aborted) return;
        log.error?.("[ai] " + e.message);
        res.end(JSON.stringify({ error: e.code === "rate_limited" ? "The AI service is busy. Try again in a minute." : "The AI request failed.", code: e.code || "upstream_error" }) + "\n");
      }
      return;
    }

    if (p === "/api/stream/ticket" && m === "POST") {
      const ticket = crypto.randomBytes(24).toString("base64url");
      tickets.set(ticket, { token: sessionToken(req), exp: Date.now() + TICKET_MS });
      return send(res, 200, { ticket, expiresIn: TICKET_MS / 1000 });
    }
    if (p === "/api/asset-key" && m === "GET") {
      if (!rules.isMember(user)) throw forbidden();
      return send(res, 200, { k: fileKeyFor(user), expiresIn: FILE_KEY_MS / 1000 });
    }

    // --- live updates ---
    if (p === "/api/stream" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 3000\n\n");
      const s = { res, user, token: req.streamToken || sessionToken(req), admin: () => rules.isAdmin(user), member: () => rules.isMember(user) };
      streams.add(s);
      req.on("close", () => streams.delete(s));
      return;
    }

    throw new HttpError(404, "Not found", "not_found");
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    if (secureReq(req)) res.setHeader("strict-transport-security", "max-age=15552000");
    const origin = allowedOrigin(req);
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    try {
      if (req.method === "OPTIONS") {
        if (!origin) return send(res, 403, "Origin not allowed. Add it to ALLOWED_ORIGINS.");
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PUT, DELETE",
          "access-control-allow-headers": "authorization, content-type, x-fieldbook, x-filename",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (p === "/healthz") return send(res, 200, { ok: true });
      if (p.startsWith("/api/")) {
        // Every change must come from Fieldbook's own pages (blocks cross-site form posts).
        if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-fieldbook"] !== "1") throw forbidden("Missing request header.");
        let user = currentUser(req);
        if (!user && p === "/api/stream" && url.searchParams.has("ticket")) {
          const t = tickets.get(url.searchParams.get("ticket"));
          if (t && t.exp > Date.now()) { user = auth.sessionUser(t.token); req.streamToken = t.token; }
        }
        return await api(req, res, url, user);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
      if (p === "/favicon.svg" || /^\/static\/[a-z0-9_-]+\.(js|css|svg|png|woff2)$/.test(p)) return sendFile(res, path.join(WEB, p.slice(1)));
      if (p.startsWith("/vendor/")) return vendor.serve(req, res, p);
      if (/^\/(login|setup|signup|account|index)\.html$/.test(p)) return send(res, 301, "", { location: p === "/index.html" ? "/" : p.slice(0, -5) + url.search });
      if (p === "/login" || p === "/setup" || p === "/signup") {
        if (currentUser(req) && p !== "/setup") return send(res, 302, "", { location: "/" });
        return sendFile(res, path.join(WEB, "login.html"), { "content-security-policy": CSP, "x-frame-options": "DENY" });
      }
      const user = currentUser(req);
      if (p === "/account") {
        if (!user) return send(res, 302, "", { location: "/login?next=%2Faccount" });
        return sendFile(res, path.join(WEB, "account.html"), { "content-security-policy": CSP, "x-frame-options": "DENY" });
      }
      let mm;
      if ((mm = /^\/assets\/([a-f0-9]{32})$/.exec(p))) {
        const viewer = user || userFromFileKey(url.searchParams.get("k"));
        if (!viewer) return send(res, 401, "Sign in first.");
        if (!rules.isMember(viewer)) return send(res, 403, "No access.");
        const a = store.getAsset(mm[1]);
        if (!a) return send(res, 404, "Not found");
        const inline = INLINE_OK.test(a.content_type);
        const fname = (a.name || "file").replace(/[^\w.\- ]+/g, "_");
        res.writeHead(200, {
          "content-type": inline ? a.content_type : "application/octet-stream",
          "content-length": a.size,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(a.name || "file")}`,
          "cache-control": "private, max-age=31536000, immutable",
          // The GitHub Pages website (another origin listed in ALLOWED_ORIGINS) shows files
          // in a frame, so frame-ancestors names it; X-Frame-Options can't list origins.
          "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors ${fileAncestors}${a.content_type === "application/pdf" ? "" : "; sandbox"}`,
          ...(config.allowedOrigins.length ? {} : { "x-frame-options": "SAMEORIGIN" }),
        });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(store.assetPath(a.id)).on("error", () => res.destroy()).pipe(res);
      }
      if (p === "/" || p === "/index.html") {
        if (auth.needsSetup()) return send(res, 302, "", { location: "/setup" });
        if (!user) return send(res, 302, "", { location: "/login" });
        return sendFile(res, path.join(WEB, "index.html"), { "content-security-policy": CSP, "x-frame-options": "SAMEORIGIN" });
      }
      return send(res, 404, "Not found");
    } catch (e) {
      if (!(e instanceof HttpError)) log.error?.(`[http] ${req.method} ${p}:`, e);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: e instanceof HttpError ? e.message : "Something went wrong on the server.", code: e.code || "server_error" });
    }
  }

  const server = http.createServer(handle);
  server.requestTimeout = 0;      // uploads and AI answers can take a while; the stream stays open
  server.headersTimeout = 60_000;
  server.timeout = 5 * 60_000;    // …but a connection silent for 5 minutes is closed
  return {
    server, store, auth, rules, ai, mailer,
    close: () => new Promise((r) => { clearInterval(beat); for (const s of streams) s.res.end(); server.close(() => { store.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.randomBytes(14);
  let s = ""; for (const x of b) s += abc[x % abc.length];
  return s.slice(0, 4) + "-" + s.slice(4, 9) + "-" + s.slice(9, 14);
}
function inviteMail({ to, name, by, password, url }) {
  const link = url ? `${url}/login` : "(ask your Admin for the address)";
  const text = `Hi ${name.split(" ")[0]},\n\n${by} created a Fieldbook account for you.\n\nSign in: ${link}\nE-mail: ${to}\nTemporary password: ${password}\n\nPlease change the password after you sign in (your name → Password & sign out).\n\n— Fieldbook`;
  return { to, toName: name, subject: "Your Fieldbook account", text };
}
