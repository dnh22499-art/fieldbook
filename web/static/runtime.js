/* Fieldbook web runtime — the browser side of the Fieldbook server.
   The app asks for services with `await window.fieldbook.use(name)`:
     db        → /api/db/…      (real-time database on the NAS; changes arrive over /api/stream)
     assets    → /api/assets    (photos, receipts and documents stored on the NAS)
     sample    → /api/sample    (the AI service set up on the server, if any)
     downloads → a normal browser download
     user      → the signed-in Fieldbook account (/api/me)
   Works the same whether the pages come from the NAS itself or from GitHub Pages
   (see static/client.js for how requests are signed in). */
(function () {
  "use strict";
  const C = window.FieldbookClient;

  function toLogin() {
    const next = location.pathname + location.search + location.hash;
    location.replace("login?next=" + encodeURIComponent(next));
  }
  function fail(message, code, status) { const e = new Error(message || "Request failed"); e.code = code || "error"; e.status = status; return e; }
  async function call(method, path, body, headers) {
    let res;
    try {
      res = await C.request(path, {
        method,
        headers: Object.assign(body !== undefined && !(body instanceof Blob) ? { "content-type": "application/json" } : {}, headers || {}),
        body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      });
    } catch (e) { throw fail("Can't reach the Fieldbook server. Check the connection and try again.", "offline"); }
    if (res.status === 401) { toLogin(); throw fail("Signed out", "unauthenticated", 401); }
    const type = res.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await res.json().catch(() => ({})) : null;
    if (!res.ok) throw fail((data && data.error) || res.statusText, (data && data.code) || (res.status === 403 ? "permission_denied" : "error"), res.status);
    return data;
  }

  /* ---------------- files from another address ----------------
     Stored documents keep file links as "/assets/<id>". When the pages are not on the
     NAS, those links are shown as the NAS's address plus a short-lived file key
     (images and PDF previews can't send a sign-in token), and turned back into
     "/assets/<id>" before anything is saved. */
  let fileKey = "";
  const LOCAL = /^\/assets\/([a-f0-9]{32})$/;
  const REMOTE = C.sameOrigin ? null : new RegExp("^" + C.API.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/assets/([a-f0-9]{32})(?:\\?k=[^\"#]*)?$");
  function mapStrings(v, fn) {
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
    if (v && typeof v === "object" && !(v instanceof Blob)) { const o = {}; for (const k of Object.keys(v)) o[k] = mapStrings(v[k], fn); return o; }
    return v;
  }
  const toView = (data) => (C.sameOrigin ? data : mapStrings(data, (s) => { const m = LOCAL.exec(s); return m ? `${C.API}/assets/${m[1]}?k=${encodeURIComponent(fileKey)}` : s; }));
  const toWire = (data) => (C.sameOrigin ? data : mapStrings(data, (s) => { const m = REMOTE.exec(s); return m ? `/assets/${m[1]}` : s; }));
  async function refreshFileKey() {
    if (C.sameOrigin) return;
    try { fileKey = (await call("GET", "/api/asset-key")).k || ""; } catch (e) {}
  }

  /* ---------------- session ---------------- */
  let sessionP = null;
  function session() {
    if (!sessionP) {
      sessionP = (async () => {
        const s = await call("GET", "/api/me");
        await refreshFileKey();
        if (!C.sameOrigin) setInterval(async () => { await refreshFileKey(); refetchAll(); }, 3 * 3600e3);
        return s;
      })().catch((e) => { sessionP = null; throw e; });
    }
    return sessionP;
  }

  /* ---------------- db ---------------- */
  const subs = new Map();      // coll → Set<{ next, error }>
  const seq = new Map();       // coll → latest request number (stale answers are dropped)
  const timers = new Map();
  const wrapDoc = (id, data) => { const view = toView(data); return { id, exists: true, data: () => view }; };
  async function refetch(coll) {
    const set = subs.get(coll);
    if (!set || !set.size) return;
    const n = (seq.get(coll) || 0) + 1; seq.set(coll, n);
    try {
      const r = await call("GET", "/api/db/" + encodeURIComponent(coll));
      if (seq.get(coll) !== n) return;
      const docs = (r.docs || []).map((d) => wrapDoc(d.id, d.data));
      const snap = { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
      for (const s of set) { try { s.next(snap); } catch (e) { console.error(e); } }
    } catch (e) {
      if (seq.get(coll) !== n) return;
      for (const s of set) { try { s.error && s.error(e); } catch (x) {} }
    }
  }
  function soon(coll, ms) {
    clearTimeout(timers.get(coll));
    timers.set(coll, setTimeout(() => refetch(coll), ms == null ? 60 : ms));
  }
  function refetchAll() { for (const c of subs.keys()) soon(c, 0); }

  // Live updates: the server names each collection that changed.
  let es = null, wasDown = false, starting = false;
  async function stream() {
    if (es || starting || typeof EventSource === "undefined") return;
    starting = true;
    try {
      let src = C.url("/api/stream");
      if (!C.sameOrigin) {
        // An EventSource can't send the sign-in token, so it gets a short-lived ticket instead.
        const t = await call("POST", "/api/stream/ticket", {});
        src += "?ticket=" + encodeURIComponent(t.ticket);
      }
      es = new EventSource(src, { withCredentials: false });
    } catch (e) { setTimeout(stream, 10000); return; }
    finally { starting = false; }
    es.onopen = () => { if (wasDown) { wasDown = false; refetchAll(); } };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.coll) return;
      // Membership changes decide what a person may see — reload everything.
      if (m.coll === "members") refetchAll(); else soon(m.coll);
    };
    es.onerror = () => {
      wasDown = true;
      // The browser gives up for good after an error answer (a proxy's 502, an expired ticket): start over.
      if (es && es.readyState === 2) { es.close(); es = null; setTimeout(stream, 3000); }
      // A dead session shows up here too: check it, and go to sign-in if needed.
      C.request("/api/me").then((r) => { if (r.status === 401) toLogin(); }).catch(() => {});
    };
  }
  // Safety net if a proxy buffers the stream: refresh every 2 minutes, and when the tab comes back.
  setInterval(refetchAll, 120000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refetchAll(); });

  function docRef(coll, id) {
    const path = "/api/db/" + encodeURIComponent(coll) + "/" + encodeURIComponent(id);
    return {
      id,
      async get() { const r = await call("GET", path); return r.exists ? wrapDoc(id, r.data) : { id, exists: false, data: () => undefined }; },
      async set(data) { await call("PUT", path, toWire(data === undefined ? {} : data)); soon(coll, 0); },
      async delete() { await call("DELETE", path); soon(coll, 0); },
    };
  }
  const db = {
    collection(coll) {
      return {
        onSnapshot(next, error) {
          if (!subs.has(coll)) subs.set(coll, new Set());
          const s = { next, error };
          subs.get(coll).add(s);
          stream();
          soon(coll, 0);
          return () => subs.get(coll).delete(s);
        },
        async add(data) { const r = await call("POST", "/api/db/" + encodeURIComponent(coll), toWire(data || {})); soon(coll, 0); return docRef(coll, r.id); },
        doc: (id) => docRef(coll, id),
      };
    },
    doc(p) {
      const i = String(p).indexOf("/");
      if (i < 1) throw fail("Document path must look like collection/id", "bad_path");
      return docRef(p.slice(0, i), p.slice(i + 1));
    },
  };

  /* ---------------- assets ---------------- */
  const assets = {
    async upload(file, opts) {
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      const blob = file.type === type ? file : new Blob([file], { type });
      const name = (opts && opts.name) || file.name || "";
      const r = await call("POST", "/api/assets", blob, { "content-type": type, "x-filename": encodeURIComponent(name) });
      return Object.assign({}, r, { url: toView(r.url) });
    },
    async delete(id) { await call("DELETE", "/api/assets/" + encodeURIComponent(id)); return true; },
  };

  /* ---------------- AI (through the server) ---------------- */
  function b64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function run(input, opts, json) {
    opts = opts || {};
    const images = [];
    for (const im of opts.images || []) {
      if (im instanceof Blob) images.push({ mediaType: im.type || "image/jpeg", data: await b64(im) });
      else if (im && im.data) images.push({ mediaType: im.mediaType || im.media_type || "image/jpeg", data: im.data });
    }
    let res;
    try {
      res = await C.request("/api/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, images, json: !!json, modelTier: opts.modelTier, maxTokens: opts.maxTokens }),
      });
    } catch (e) { throw fail("Can't reach the Fieldbook server.", "offline"); }
    if (res.status === 401) { toLogin(); throw fail("Signed out", "unauthenticated", 401); }
    if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw fail(d.error || "AI request failed", d.code || "upstream_error", res.status); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "", final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.d) { text += m.d; if (opts.onText) { try { opts.onText({ text, delta: m.d }); } catch (e) {} } }
        else if (m.error) throw fail(m.error, m.code || "upstream_error");
        else if (m.done) final = m;
      }
    }
    if (!final) throw fail("The AI answer was cut off.", "upstream_error");
    return final;
  }
  const sample = async (input, opts) => { const f = await run(input, opts, false); return { text: f.text, truncated: !!f.truncated }; };
  sample.json = async (input, opts) => {
    const f = await run(input, opts, true);
    if (f.json === undefined || f.json === null) throw fail("The AI reply wasn't valid JSON.", "invalid_json");
    return f.json;
  };
  sample.limits = () => call("GET", "/api/sample/limits");

  /* ---------------- downloads ---------------- */
  const downloads = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data == null ? "" : data], { type: type || "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      const u = URL.createObjectURL(blob);
      a.href = u; a.download = filename || "download"; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 10000);
      return true;
    },
  };

  /* ---------------- user ---------------- */
  const user = {
    async me() { const s = await session(); return Object.assign({}, s.user); },
    async profiles(ids) { const r = await call("POST", "/api/profiles", { ids: (ids || []).slice(0, 500) }); return r.profiles || {}; },
  };

  window.fieldbook = {
    config: { ai: false, mail: false },
    async use(name) {
      const s = await session();
      window.fieldbook.config = { ai: !!s.ai, mail: !!s.mail };
      if (name === "db") return db;
      if (name === "assets") return assets;
      if (name === "downloads") return downloads;
      if (name === "user") return user;
      if (name === "sample") return s.ai ? sample : null;
      return null;
    },
  };
})();
