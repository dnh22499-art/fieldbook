// All settings come from environment variables (or a .env file next to package.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader: KEY=value lines, # comments, optional quotes. Real env vars win.
export function loadDotEnv(file = path.join(ROOT, ".env")) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));

export function readConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || "").replace(/\/+$/, "");
  return {
    port: num(env.PORT, 8080),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(ROOT, env.DATA_DIR || "data"),
    publicUrl,
    // Cookies are marked Secure on HTTPS requests (seen through TRUST_PROXY's X-Forwarded-Proto),
    // so the same server works over https outside and plain http on the office network.
    // COOKIE_SECURE=true forces Secure always (only if every visit is over https).
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, false),
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    // Sites allowed to use this server from the browser when the pages are hosted elsewhere,
    // e.g. ALLOWED_ORIGINS=https://yourname.github.io  (scheme + host only, comma-separated)
    allowedOrigins: String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    sessionDays: num(env.SESSION_DAYS, 30),
    maxUploadMb: num(env.MAX_UPLOAD_MB, 50),
    // AI (optional): "anthropic" (ANTHROPIC_API_KEY) or "openai" = any OpenAI-compatible server (Ollama, LM Studio, OpenAI…)
    aiProvider: (env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : env.AI_BASE_URL ? "openai" : "")).toLowerCase(),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || "",
    aiBaseUrl: env.AI_BASE_URL || "",
    aiApiKey: env.AI_API_KEY || "",
    model: env.AI_MODEL || "claude-sonnet-4-5",
    modelQuick: env.AI_MODEL_QUICK || env.AI_MODEL || "claude-haiku-4-5",
    modelComplex: env.AI_MODEL_COMPLEX || env.AI_MODEL || "claude-sonnet-4-5",
    aiPerUserPerHour: num(env.AI_PER_USER_PER_HOUR, 120),
    smtpUrl: env.SMTP_URL || "",
    mailFrom: env.MAIL_FROM || "",
    mailFromName: env.MAIL_FROM_NAME || "Fieldbook",
    mailLang: env.MAIL_LANG === "vi" ? "vi" : "en",
    weather: bool(env.WEATHER, true),
    backupHour: num(env.BACKUP_HOUR, 2),
    backupKeep: num(env.BACKUP_KEEP, 14),
  };
}
