// Sets a new password for an account from the server's command line —
// for when the only Admin forgets theirs.
//   node scripts/reset-password.js admin@company.com            (prints a random password)
//   node scripts/reset-password.js admin@company.com "NewPass…"  (uses the one you give)
// With Docker:  docker compose exec fieldbook node scripts/reset-password.js admin@company.com
import crypto from "node:crypto";
import { loadDotEnv, readConfig } from "../server/config.js";
import { openStore } from "../server/store.js";
import { createAuth, passwordProblem } from "../server/auth.js";

loadDotEnv();
const [email, given] = process.argv.slice(2);
if (!email) { console.error("Usage: node scripts/reset-password.js <e-mail> [new password]"); process.exit(1); }
const store = openStore(readConfig().dataDir);
const auth = createAuth(store);
const u = auth.findByEmail(email.toLowerCase());
if (!u) {
  console.error(`No account with e-mail ${email}. Accounts:`);
  for (const a of auth.allUsers()) console.error(`  ${a.email}${a.is_owner ? "  (owner)" : ""}${a.disabled ? "  (disabled)" : ""}`);
  process.exit(1);
}
const pw = given || crypto.randomBytes(12).toString("base64url");
const problem = passwordProblem(pw);
if (problem) { console.error(problem); process.exit(1); }
auth.setPassword(u.id, pw);
if (u.disabled) auth.setDisabled(u.id, false);
console.log(`New password for ${u.email}: ${pw}`);
console.log("All of this person's sessions were signed out.");
store.close();
