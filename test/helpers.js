import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "../server/config.js";
import { createApp } from "../server/app.js";

export const quiet = { log() {}, warn() {}, error() {} };

/** A real server on a random port with its own empty data folder. */
export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldbook-test-"));
  const config = readConfig({ DATA_DIR: dataDir, BACKUP_KEEP: "0", ...env });
  const app = createApp(config, { log: quiet });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app, base, config, dataDir,
    async stop() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/** Minimal cookie-keeping client. */
export function client(base) {
  let cookie = "";
  async function req(method, url, body, headers = {}) {
    const isBuf = body instanceof Uint8Array;
    const res = await fetch(base + url, {
      method, redirect: "manual",
      headers: { "x-fieldbook": "1", ...(body !== undefined && !isBuf ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) { const m = /fb_session=([^;]*)/.exec(set); if (m) cookie = m[1] ? `fb_session=${m[1]}` : ""; }
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    req,
    get: (u, h) => req("GET", u, undefined, h),
    post: (u, b, h) => req("POST", u, b ?? {}, h),
    put: (u, b) => req("PUT", u, b),
    del: (u) => req("DELETE", u),
    get cookie() { return cookie; },
  };
}
