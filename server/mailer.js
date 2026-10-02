// Outgoing e-mail over SMTP, with no third-party packages.
//   SMTP_URL=smtps://user:pass@smtp.example.com:465      (TLS from the start)
//   SMTP_URL=smtp://user:pass@smtp.example.com:587       (upgrades with STARTTLS; refuses to log in without it)
//   SMTP_URL=smtp://localhost:1025?tls=off               (local test catcher only — no login, no TLS)
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const b64wrap = (s) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
// Display names: ASCII ones are quoted (so "Smith, John" stays one recipient), others encoded.
const dispName = (s) => (/^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : encWord(s));
const addr = (email) => { const e = clean(email); if (!/^[^\s@<>]+@[^\s@<>]+$/.test(e)) throw new Error("Bad e-mail address: " + e); return e; };

export function buildMessage({ from, fromName, to, toName, subject, text, html }) {
  const boundary = "fb-" + crypto.randomBytes(12).toString("hex");
  const domain = from.split("@")[1] || "fieldbook.local";
  const head = [
    `From: ${fromName ? `${dispName(clean(fromName))} <${addr(from)}>` : `<${addr(from)}>`}`,
    `To: ${toName ? `${dispName(clean(toName))} <${addr(to)}>` : `<${addr(to)}>`}`,
    `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", b64wrap(body)].join("\r\n");
  return [...head, "", part("text/plain", text), part("text/html", html || text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\n/g, "<br>")), `--${boundary}--`, ""].join("\r\n");
}

async function smtpSend(url, envelopeFrom, rcpt, message, { timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  const implicitTls = u.protocol === "smtps:";
  const tlsOff = u.searchParams.get("tls") === "off";
  const host = u.hostname, port = Number(u.port) || (implicitTls ? 465 : 587);
  const user = decodeURIComponent(u.username || ""), pass = decodeURIComponent(u.password || "");
  let sock = implicitTls ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
  let buf = "", waiter = null, failure = null;
  const onData = (d) => { buf += d.toString("utf8"); pump(); };
  const onErr = (e) => { failure = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  function pump() {
    if (!waiter) return;
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiter; waiter = null;
        w.resolve({ code: Number(lines[i].slice(0, 3)), text: reply.join("\n") });
        return;
      }
    }
  }
  // Any close, error or stall fails the pending step — nothing waits forever.
  const attach = (s) => {
    s.on("data", onData); s.on("error", onErr);
    s.on("close", () => onErr(new Error("SMTP connection closed")));
    s.setTimeout(timeoutMs, () => { onErr(new Error("SMTP timed out")); s.destroy(); });
  };
  attach(sock);
  const read = () => new Promise((resolve, reject) => { if (failure) return reject(failure); waiter = { resolve, reject }; pump(); });
  const cmd = async (line, ok, label = line.split(" ")[0]) => {
    if (line !== null) sock.write(line + "\r\n");
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${label} failed: ${r.text.slice(0, 200)}`);
    return r;
  };
  try {
    await cmd(null, [220], "greeting");
    const me = "fieldbook.local";
    let ehlo = await cmd(`EHLO ${me}`, [250]);
    let secure = implicitTls;
    if (!secure && !tlsOff) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error("The mail server doesn't offer STARTTLS. Use smtps:// or a server that supports TLS.");
      await cmd("STARTTLS", [220]);
      // Anything the server sent after "220" arrived before encryption: drop it (STARTTLS injection).
      if (buf.length) throw new Error("The mail server sent data before the TLS handshake.");
      buf = "";
      const plain = sock;
      plain.removeAllListeners("data"); plain.removeAllListeners("close"); plain.setTimeout(0);
      sock = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host });
      attach(sock);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("SMTP TLS handshake timed out")), timeoutMs);
        sock.once("secureConnect", () => { clearTimeout(t); res(); });
        sock.once("error", (e) => { clearTimeout(t); rej(e); });
        sock.once("close", () => { clearTimeout(t); rej(new Error("SMTP connection closed")); });
      });
      secure = true;
      ehlo = await cmd(`EHLO ${me}`, [250]);
    }
    if (user) {
      if (!secure) throw new Error("Refusing to send the SMTP password without TLS.");
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) await cmd("AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`).toString("base64"), [235], "AUTH");
      else {
        await cmd("AUTH LOGIN", [334], "AUTH");
        await cmd(Buffer.from(user).toString("base64"), [334], "AUTH user");
        await cmd(Buffer.from(pass).toString("base64"), [235], "AUTH password");
      }
    }
    await cmd(`MAIL FROM:<${addr(envelopeFrom)}>`, [250]);
    await cmd(`RCPT TO:<${addr(rcpt)}>`, [250, 251]);
    await cmd("DATA", [354]);
    const body = message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await cmd(body + (body.endsWith("\r\n") ? "" : "\r\n") + ".", [250], "DATA body");
    try { sock.write("QUIT\r\n"); } catch {}
  } finally {
    setTimeout(() => sock.destroy(), 200).unref?.();
  }
}
// Overall deadline on top of the per-step timeouts.
function withDeadline(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("SMTP took too long")), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

/** Returns { kind, from, send({ to, toName, subject, text, html }) }. kind "none" = not configured. */
export function createMailer(config, log = console) {
  if (!config.smtpUrl) return { kind: "none", from: "", async send() { throw new Error("E-mail isn't set up on this server (SMTP_URL)."); } };
  const from = config.mailFrom || (() => { try { const u = new URL(config.smtpUrl); return decodeURIComponent(u.username) || "fieldbook@localhost"; } catch { return "fieldbook@localhost"; } })();
  return {
    kind: "smtp", from,
    async send(msg) {
      const raw = buildMessage({ from, fromName: config.mailFromName || "Fieldbook", ...msg });
      await withDeadline(smtpSend(config.smtpUrl, from, msg.to, raw), 60000);
      log.log?.(`[mail] sent "${clean(msg.subject)}" to ${msg.to}`);
    },
  };
}
