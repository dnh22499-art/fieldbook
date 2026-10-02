// Third-party browser files the app loads on demand — today only the PDF reader
// (pdf.js 3.11.174, Apache-2.0), used to read PDF receipts.
// Looked up in order:
//   1. web/vendor/pdfjs/<file>          (put the files there for a fully offline install)
//   2. DATA_DIR/vendor/pdfjs/<file>     (saved copy from an earlier download)
//   3. downloaded once from cdnjs over HTTPS, then saved to (2)
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const PDFJS = { version: "3.11.174", files: new Set(["pdf.min.js", "pdf.worker.min.js"]) };

export function createVendor(config, log = console, fetchImpl = fetch) {
  const bundled = path.join(ROOT, "web", "vendor", "pdfjs");
  const cache = path.join(config.dataDir, "vendor", "pdfjs");
  const pending = new Map();

  async function file(name) {
    for (const dir of [bundled, cache]) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
    }
    if (!pending.has(name)) {
      pending.set(name, (async () => {
        const url = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS.version}/${name}`;
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 50_000 || !/pdfjs|pdf\.js/i.test(buf.subarray(0, 4000).toString("latin1"))) throw new Error(`${url}: unexpected content`);
        fs.mkdirSync(cache, { recursive: true });
        const f = path.join(cache, name);
        fs.writeFileSync(f + ".part", buf);
        fs.renameSync(f + ".part", f);
        log.log?.(`[vendor] saved ${name} (pdf.js ${PDFJS.version})`);
        return f;
      })().finally(() => pending.delete(name)));
    }
    return pending.get(name);
  }

  return {
    async serve(req, res, p) {
      const m = /^\/vendor\/pdfjs\/([a-z.]+)$/.exec(p);
      if (!m || !PDFJS.files.has(m[1])) { res.writeHead(404); return res.end("Not found"); }
      try {
        const f = await file(m[1]);
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff" });
        fs.createReadStream(f).pipe(res);
      } catch (e) {
        log.warn?.("[vendor] PDF reader unavailable: " + e.message);
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("The PDF reader isn't available on this server yet (no Internet to download it). See README → Offline install.");
      }
    },
  };
}
