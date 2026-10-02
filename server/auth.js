// Accounts and sessions. Passwords are hashed with scrypt; a session is a random
// token in an HttpOnly cookie, stored server-side only as its SHA-256 hash.
import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, key] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const COMMON = new Set(["password123", "1234567890", "qwertyuiop", "password1234", "iloveyou12", "0123456789", "abc1234567", "matkhau123"]);
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common.";
  return "";
}
export const validEmail = (e) => typeof e === "string" && e.length <= 200 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e);

export function createAuth(store, { sessionDays = 30 } = {}) {
  const db = store.db;
  const st = {
    count: db.prepare("SELECT COUNT(*) n FROM users"),
    byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    byId: db.prepare("SELECT * FROM users WHERE id = ?"),
    insert: db.prepare("INSERT INTO users (id, email, name, pass_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    setPass: db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?"),
    setName: db.prepare("UPDATE users SET name = ? WHERE id = ?"),
    newSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    session: db.prepare("SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"),
    touch: db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?"),
    endSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    endAll: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    purge: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    all: db.prepare("SELECT id, email, name, is_owner, disabled, created_at FROM users ORDER BY created_at"),
    setDisabled: db.prepare("UPDATE users SET disabled = ? WHERE id = ?"),
  };
  const later = () => new Date(Date.now() + sessionDays * 864e5).toISOString();
  return {
    needsSetup: () => st.count.get().n === 0,
    createUser({ email, name, password, owner = false }) {
      const id = "u_" + crypto.randomBytes(16).toString("base64url").slice(0, 22);
      st.insert.run(id, email.trim(), name.trim().slice(0, 80), hashPassword(password), owner ? 1 : 0, store.now());
      return st.byId.get(id);
    },
    findByEmail: (email) => st.byEmail.get(String(email || "").trim()),
    findById: (id) => st.byId.get(id),
    allUsers: () => st.all.all(),
    verify(email, password) {
      const u = st.byEmail.get(String(email || "").trim());
      // Spend the same time on unknown e-mails so they can't be told apart.
      if (!u) { checkPassword(password || "", "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86)); return null; }
      if (!checkPassword(password || "", u.pass_hash) || u.disabled) return null;
      return u;
    },
    setPassword(userId, password) { st.setPass.run(hashPassword(password), userId); st.endAll.run(userId); },
    setName(userId, name) { st.setName.run(String(name).trim().slice(0, 80), userId); },
    startSession(userId) {
      const token = crypto.randomBytes(32).toString("base64url");
      st.purge.run(store.now());
      st.newSession.run(sha(token), userId, store.now(), later());
      return token;
    },
    sessionUser(token) {
      if (!token) return null;
      const r = st.session.get(sha(token));
      if (!r || r.expires_at < store.now() || r.disabled) return null;
      // Sliding expiry, refreshed at most once a day.
      if (Date.parse(r.expires_at) - Date.now() < (sessionDays - 1) * 864e5) st.touch.run(later(), sha(token));
      return r;
    },
    endSession: (token) => token && st.endSession.run(sha(token)),
    endAllSessions: (userId) => st.endAll.run(userId),
    setDisabled(userId, disabled) { st.setDisabled.run(disabled ? 1 : 0, userId); if (disabled) st.endAll.run(userId); },
  };
}
