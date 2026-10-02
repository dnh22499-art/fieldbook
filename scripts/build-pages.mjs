// Builds the static website for GitHub Pages (or any static host) from web/.
// The pages talk to the Fieldbook server on the NAS at --api.
//
//   node scripts/build-pages.mjs --api https://fieldbook-api.example.com [--out _site] [--pdfjs dir]
//
// --pdfjs: a folder holding pdf.min.js and pdf.worker.min.js (the GitHub workflow downloads them);
//          without it, PDF receipts are read with the copy the NAS serves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));

export function buildPages({ api, out = path.join(ROOT, "_site"), pdfjs } = {}) {
  let origin;
  try { origin = new URL(api).origin; } catch { throw new Error("--api must be the full https:// address of the Fieldbook server on the NAS"); }
  if (!/^https:/.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("--api must use https:// (browsers block http:// calls from an https:// page)");
  const apiBase = api.replace(/\/+$/, "");

  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "web"), out, { recursive: true });

  // Where the server is.
  fs.writeFileSync(path.join(out, "static", "config.js"),
    `/* Written by scripts/build-pages.mjs — the Fieldbook server (API + real-time database) on the NAS. */\nwindow.FIELDBOOK_API = ${JSON.stringify(apiBase)};\n`);

  // GitHub Pages can't send security headers, so the policy goes into each page.
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
    `img-src 'self' data: blob: https: ${origin}`, `media-src 'self' blob: ${origin}`,
    `connect-src 'self' data: blob: ${origin}`, "worker-src 'self' blob:",
    `frame-src 'self' blob: data: ${origin} https://www.google.com https://maps.google.com`,
    "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join("; ");
  for (const f of ["index.html", "login.html", "account.html"]) {
    const p = path.join(out, f);
    const html = fs.readFileSync(p, "utf8");
    if (!html.includes("<!--fieldbook:csp-->")) throw new Error(`${f}: missing <!--fieldbook:csp--> marker`);
    fs.writeFileSync(p, html.replace("<!--fieldbook:csp-->", `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="same-origin">`));
  }
  // GitHub Pages serves /setup and /signup only if those pages exist.
  for (const alias of ["setup", "signup"]) fs.copyFileSync(path.join(out, "login.html"), path.join(out, `${alias}.html`));

  // PDF reader next to the pages (otherwise the NAS's copy is used).
  const vendor = path.join(out, "vendor", "pdfjs");
  if (pdfjs) {
    fs.mkdirSync(vendor, { recursive: true });
    for (const f of ["pdf.min.js", "pdf.worker.min.js"]) fs.copyFileSync(path.join(pdfjs, f), path.join(vendor, f));
  } else if (!fs.existsSync(path.join(vendor, "pdf.min.js"))) {
    const js = path.join(out, "static", "fieldbook.js");
    fs.writeFileSync(js, fs.readFileSync(js, "utf8").replace('const PDFJS_BASE = "vendor/pdfjs/";', `const PDFJS_BASE = ${JSON.stringify(apiBase + "/vendor/pdfjs/")};`));
    // …which then has to be allowed as a script source.
    for (const f of ["index.html"]) {
      const p = path.join(out, f);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("script-src 'self';", `script-src 'self' ${origin};`));
    }
  }
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = buildPages({ api: args.api || process.env.FIELDBOOK_API_URL, out: args.out && path.resolve(args.out), pdfjs: args.pdfjs && path.resolve(args.pdfjs) });
    console.log(`Static site written to ${out}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
