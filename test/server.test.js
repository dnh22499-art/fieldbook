import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client } from "./helpers.js";

let srv, owner, pm, acct, stranger;
before(async () => {
  srv = await startServer();
  owner = client(srv.base); pm = client(srv.base); acct = client(srv.base); stranger = client(srv.base);
});
after(() => srv.stop());

test("first visit goes to set-up, and set-up works only once", async () => {
  const r = await stranger.get("/");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/setup");
  assert.equal((await stranger.get("/api/auth/state")).data.needsSetup, true);
  assert.equal((await owner.post("/api/auth/setup", { name: "Ana", email: "Ana@Example.com", password: "short" })).status, 400);
  assert.equal((await owner.post("/api/auth/setup", { name: "Ana", email: "Ana@Example.com", password: "a-long-password" })).status, 200);
  assert.equal((await stranger.post("/api/auth/setup", { name: "X", email: "x@example.com", password: "a-long-password" })).status, 409);
  const me = (await owner.get("/api/me")).data;
  assert.equal(me.user.email, "ana@example.com");
  assert.equal(me.user.isOwner, true);
  assert.equal(me.user.canEdit, true);
  assert.equal(me.role, "admin");
});

test("the app page loads its own scripts and needs a session", async () => {
  assert.equal((await stranger.get("/")).headers.get("location"), "/login");
  const r = await owner.get("/");
  assert.equal(r.status, 200);
  assert.match(r.data, /<script src="static\/runtime.js"><\/script>/);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self';/);
  assert.equal((await stranger.get("/static/runtime.js")).status, 200);
  assert.equal((await stranger.get("/static/fieldbook.js")).status, 200);
  assert.equal((await stranger.get("/static/../server/auth.js")).status, 404);
});

test("sign-in: wrong password, rate limit, logout", async () => {
  const c = client(srv.base);
  assert.equal((await c.post("/api/auth/login", { email: "ana@example.com", password: "wrong-password" })).status, 401);
  assert.equal((await c.post("/api/auth/login", { email: "ANA@example.com", password: "a-long-password" })).status, 200);
  assert.equal((await c.get("/api/me")).status, 200);
  assert.equal((await c.post("/api/auth/logout")).status, 200);
  assert.equal((await c.get("/api/me")).status, 401);
  const d = client(srv.base);
  let last;
  for (let i = 0; i < 11; i++) last = await d.post("/api/auth/login", { email: "nobody@example.com", password: "whatever-123" });
  assert.equal(last.status, 429);
});

test("changes need the Fieldbook header (no cross-site posts)", async () => {
  const r = await fetch(srv.base + "/api/db/projects", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("documents: add, list, get, set, delete", async () => {
  const a = await owner.post("/api/db/projects", { name: "Harlow", address: "1 Main St" });
  assert.equal(a.status, 200);
  const id = a.data.id;
  assert.match(id, /^[a-z0-9]{20}$/);
  assert.deepEqual((await owner.get("/api/db/projects")).data.docs, [{ id, data: { name: "Harlow", address: "1 Main St" } }]);
  assert.deepEqual((await owner.get(`/api/db/projects/${id}`)).data, { exists: true, data: { name: "Harlow", address: "1 Main St" } });
  assert.equal((await owner.put(`/api/db/projects/${id}`, { name: "Harlow 2" })).status, 200);
  assert.equal((await owner.get(`/api/db/projects/${id}`)).data.data.name, "Harlow 2");
  assert.equal((await owner.put("/api/db/meta/flags", { seeded: true })).status, 200);
  assert.equal((await owner.get("/api/db/meta/flags")).data.data.seeded, true);
  assert.equal((await owner.put("/api/db/projects/x", [1, 2])).status, 400);
  assert.equal((await owner.get("/api/db/..")).status, 404);
  assert.equal((await owner.del(`/api/db/projects/${id}`)).status, 200);
  assert.deepEqual((await owner.get(`/api/db/projects/${id}`)).data, { exists: false });
});

test("newcomers see nothing until an Admin approves them; roles are enforced on the server", async () => {
  assert.equal((await pm.post("/api/auth/signup", { name: "Bao", email: "bao@example.com", password: "another-pass-1" })).status, 200);
  assert.equal((await stranger.post("/api/auth/signup", { name: "Bao 2", email: "BAO@example.com", password: "another-pass-1" })).status, 409);
  await owner.post("/api/db/projects", { name: "Secret job" });
  assert.equal((await pm.get("/api/db/projects")).data.docs.length, 0);
  assert.equal((await pm.post("/api/db/projects", { name: "x" })).status, 403);
  const pmId = (await pm.get("/api/me")).data.user.id;
  // they can file their own access request, read members, but not approve themselves
  assert.equal((await pm.put(`/api/db/accessRequests/${pmId}`, { requestedRole: "admin" })).status, 200);
  assert.equal((await pm.put(`/api/db/accessRequests/someone-else`, {})).status, 403);
  assert.equal((await pm.put(`/api/db/members/${pmId}`, { role: "admin", status: "active" })).status, 403);
  assert.equal((await owner.get("/api/db/accessRequests")).data.docs.length, 1);
  // owner approves as project manager
  assert.equal((await owner.put(`/api/db/members/${pmId}`, { role: "pm", status: "active" })).status, 200);
  assert.equal((await pm.get("/api/db/projects")).data.docs.length, 1);
  assert.equal((await pm.post("/api/db/projects", { name: "PM job" })).status, 200);
  assert.equal((await pm.get("/api/accounts")).status, 403);
  assert.equal((await pm.get("/api/db/accessRequests")).data.docs.length, 1, "own request only");
  // nobody writes the server's weather
  assert.equal((await owner.put("/api/db/weather/p1", {})).status, 403);
  // profiles
  const prof = (await pm.post("/api/profiles", { ids: [pmId, "nope"] })).data.profiles;
  assert.equal(prof[pmId].name, "Bao");
});

test("accountants can only change the money side", async () => {
  const r = await owner.post("/api/accounts", { name: "Cam", email: "cam@example.com", role: "accountant" });
  assert.equal(r.status, 200);
  assert.ok(r.data.password.length >= 14);
  assert.equal((await acct.post("/api/auth/login", { email: "cam@example.com", password: r.data.password })).status, 200);
  assert.equal((await acct.get("/api/me")).data.role, "accountant");
  assert.equal((await acct.post("/api/db/receipts", { total: 12 })).status, 200);
  assert.equal((await acct.post("/api/db/projects", { name: "nope" })).status, 403);
  // Admin resets the password and disables the account
  const reset = await owner.post(`/api/accounts/${r.data.id}/password`);
  assert.equal(reset.status, 200);
  assert.equal((await acct.get("/api/me")).status, 401, "reset signs them out");
  assert.equal((await acct.post("/api/auth/login", { email: "cam@example.com", password: reset.data.password })).status, 200);
  assert.equal((await owner.post(`/api/accounts/${r.data.id}/disable`)).status, 200);
  assert.equal((await acct.get("/api/me")).status, 401);
  assert.equal((await acct.post("/api/auth/login", { email: "cam@example.com", password: reset.data.password })).status, 401);
  assert.equal((await owner.post(`/api/accounts/${(await owner.get("/api/me")).data.user.id}/disable`)).status, 400);
});

test("own password change signs out other devices", async () => {
  const other = client(srv.base);
  await other.post("/api/auth/login", { email: "bao@example.com", password: "another-pass-1" });
  assert.equal((await pm.post("/api/account/password", { current: "wrong", password: "brand-new-pass-1" })).status, 400);
  assert.equal((await pm.post("/api/account/password", { current: "another-pass-1", password: "brand-new-pass-1" })).status, 200);
  assert.equal((await pm.get("/api/me")).status, 200, "this device stays signed in");
  assert.equal((await other.get("/api/me")).status, 401);
});

test("files: upload, serve to members only, delete", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const up = await owner.req("POST", "/api/assets", bytes, { "content-type": "image/png", "x-filename": encodeURIComponent("site photo.png") });
  assert.equal(up.status, 200);
  assert.match(up.data.url, /^\/assets\/[a-f0-9]{32}$/);
  const got = await fetch(srv.base + up.data.url, { headers: { cookie: owner.cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await fetch(srv.base + up.data.url)).status, 401);
  // HTML is never served as a page
  const html = await owner.req("POST", "/api/assets", new TextEncoder().encode("<script>alert(1)</script>"), { "content-type": "text/html" });
  const h = await fetch(srv.base + html.data.url, { headers: { cookie: owner.cookie } });
  assert.equal(h.headers.get("content-type"), "application/octet-stream");
  assert.match(h.headers.get("content-disposition"), /^attachment/);
  assert.equal((await owner.del(`/api/assets/${up.data.id}`)).status, 200);
  assert.equal((await fetch(srv.base + up.data.url, { headers: { cookie: owner.cookie } })).status, 404);
});

test("live updates: the stream names collections a person may see", async () => {
  const ctrl = new AbortController();
  const res = await fetch(srv.base + "/api/stream", { headers: { cookie: pm.cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const seen = [];
  const reading = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); } } catch {} })();
  await new Promise((r) => setTimeout(r, 100));
  const ownerId = (await owner.get("/api/me")).data.user.id;
  await owner.put(`/api/db/auditLog/${ownerId}`, { events: [] });   // not the PM's business
  await owner.post("/api/db/events", { title: "Inspection" });
  await new Promise((r) => setTimeout(r, 200));
  ctrl.abort(); await reading;
  const text = seen.join("");
  assert.match(text, /"coll":"events"/);
  assert.doesNotMatch(text, /auditLog/);
});

test("AI is reported as off without an API key", async () => {
  assert.equal((await owner.get("/api/me")).data.ai, false);
  assert.equal((await owner.post("/api/sample", { input: "hi" })).status, 503);
});

test("own audit trail is append-only; oversized bodies get a clean 413", async () => {
  const pmId = (await pm.get("/api/me")).data.user.id;
  await pm.put(`/api/db/auditLog/${pmId}`, { events: [{ at: "2026-10-01T01:00:00Z", action: "a", detail: "1" }] });
  await pm.put(`/api/db/auditLog/${pmId}`, { events: [{ at: "2026-10-01T02:00:00Z", action: "b", detail: "2" }] });
  assert.deepEqual((await pm.get(`/api/db/auditLog/${pmId}`)).data.data.events.map((e) => e.action), ["a", "b"]);
  assert.equal((await pm.del(`/api/db/auditLog/${pmId}`)).status, 403);
  const big = await pm.put(`/api/db/accessRequests/${pmId}`, { note: "x".repeat(600 * 1024) });
  assert.equal(big.status, 413);
});

test("set-up can't be repeated by a request that was already on its way", async () => {
  const s2 = await startServer();
  try {
    const body = JSON.stringify({ name: "Late", email: "late@example.com", password: "a-long-password" });
    // headers first, body later — the real owner sets up in between
    const http = await import("node:http");
    const port = new URL(s2.base).port;
    const late = new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/api/auth/setup", method: "POST", headers: { "x-fieldbook": "1", "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => resolve(res.statusCode));
      r.flushHeaders();
      setTimeout(() => r.end(body), 300);
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await client(s2.base).post("/api/auth/setup", { name: "Real", email: "real@example.com", password: "a-long-password" })).status, 200);
    assert.equal(await late, 409);
    assert.equal(s2.app.auth.allUsers().filter((u) => u.is_owner).length, 1);
  } finally { await s2.stop(); }
});
