// Pages hosted on another site (GitHub Pages) talking to the NAS server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

const PAGES = "https://acme.github.io";
let srv, token;
const api = (path, { method = "GET", body, headers = {}, auth = true } = {}) => fetch(srv.base + path, {
  method,
  headers: { origin: PAGES, "x-fieldbook": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth && token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => { srv = await startServer({ ALLOWED_ORIGINS: `${PAGES}, https://other.example` }); });
after(() => srv.stop());

test("browsers may call the server only from ALLOWED_ORIGINS", async () => {
  const pre = await fetch(srv.base + "/api/db/projects", { method: "OPTIONS", headers: { origin: PAGES, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-fieldbook" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), PAGES);
  assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  const bad = await fetch(srv.base + "/api/db/projects", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("sign-in hands out a token; the token works without cookies", async () => {
  const r = await api("/api/auth/setup", { method: "POST", body: { name: "Ana", email: "ana@example.com", password: "a-long-password", token: true }, auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  token = (await r.json()).token;
  assert.ok(token.length > 30);
  const me = await api("/api/me");
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "ana@example.com");
  assert.equal((await api("/api/me", { headers: { authorization: "Bearer not-a-real-token-xxxxxxxxxxxx" }, auth: false })).status, 401);
  assert.equal((await api("/api/db/projects", { method: "POST", body: { name: "Remote job" } })).status, 200);
});

test("live updates through a stream ticket", async () => {
  const t = await (await api("/api/stream/ticket", { method: "POST", body: {} })).json();
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/stream?ticket=${t.ticket}`, { headers: { origin: PAGES }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), PAGES);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let text = "";
  const reading = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch {} })();
  await new Promise((r) => setTimeout(r, 100));
  await api("/api/db/events", { method: "POST", body: { title: "Pour concrete" } });
  await new Promise((r) => setTimeout(r, 200));
  ctrl.abort(); await reading;
  assert.match(text, /"coll":"events"/);
  assert.equal((await fetch(`${srv.base}/api/stream?ticket=nope`)).status, 401);
});

test("files open from another site with a file key, not without one", async () => {
  const up = await api("/api/assets", { method: "POST", headers: { "content-type": "image/png" } });
  // (empty upload is refused) — send real bytes
  assert.equal(up.status, 400);
  const res = await fetch(srv.base + "/api/assets", { method: "POST", headers: { origin: PAGES, "x-fieldbook": "1", authorization: `Bearer ${token}`, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3, 4]) });
  const a = await res.json();
  assert.equal(a.url, `/assets/${a.id}`, "stored links stay server-relative");
  const { k } = await (await api("/api/asset-key")).json();
  const ok = await fetch(`${srv.base}${a.url}?k=${encodeURIComponent(k)}`, { headers: { origin: PAGES } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), PAGES);
  assert.equal((await fetch(srv.base + a.url)).status, 401);
  const forged = k.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await fetch(`${srv.base}${a.url}?k=${encodeURIComponent(forged)}`)).status, 401);
});

test("logout ends the token", async () => {
  assert.equal((await api("/api/auth/logout", { method: "POST", body: {} })).status, 200);
  assert.equal((await api("/api/me")).status, 401);
});
