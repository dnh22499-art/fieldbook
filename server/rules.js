// Who may read and write which documents — enforced here on the server,
// so nobody can bypass them from the browser:
//   members                               every signed-in person reads; only the owner and active Admins write
//   accessRequests/{uid}, auditLog/{uid}  a person reads and writes their own; Admins read and write all
//   everything else                       only approved (active) members and the owner read or write
// On top of that, Accountants may only write the collections the app lets them
// change (receipts, costs, budgets …) — the page already hides the other buttons —
// and job-site weather is written only by the server.
const SELF = new Set(["accessRequests", "auditLog"]);
const SERVER_ONLY = new Set(["weather"]);   // filled in by the server (Open-Meteo), read-only for people
const ACCOUNTANT_WRITES = new Set(["receipts", "financials", "budgets", "vendorRules", "comments", "documents", "settings", "analyses"]);

export function createRules(store) {
  const memberOf = (user) => (user ? store.get("members", user.id)?.data || null : null);
  const isAdmin = (user) => {
    if (!user) return false;
    if (user.is_owner) return true;
    const m = memberOf(user);
    return !!(m && m.status === "active" && m.role === "admin");
  };
  const isMember = (user) => {
    if (!user) return false;
    if (user.is_owner) return true;
    const m = memberOf(user);
    return !!(m && m.status === "active");
  };
  const roleOf = (user) => {
    if (!user) return null;
    if (user.is_owner) return "admin";
    const m = memberOf(user);
    return m && m.status === "active" ? (["admin", "pm", "accountant"].includes(m.role) ? m.role : "pm") : null;
  };
  return {
    isAdmin, isMember, roleOf,
    // Filter applied to a whole-collection read (documents the person may not see are left out).
    readFilter(user, coll) {
      if (coll === "members") return () => true;
      if (SELF.has(coll)) return isAdmin(user) ? () => true : (d) => d.id === user.id;
      return isMember(user) ? () => true : () => false;
    },
    canRead(user, coll, id) {
      if (coll === "members") return true;
      if (SELF.has(coll)) return isAdmin(user) || id === user.id;
      return isMember(user);
    },
    canWrite(user, coll, id) {
      if (coll === "members") return isAdmin(user);
      if (SELF.has(coll)) return isAdmin(user) || id === user.id;
      if (SERVER_ONLY.has(coll)) return false;
      const role = roleOf(user);
      if (!role) return false;
      if (role === "accountant") return ACCOUNTANT_WRITES.has(coll);
      return true;
    },
  };
}
export const validName = (s) => typeof s === "string" && /^[A-Za-z0-9_\-.~:@+]{1,100}$/.test(s) && s !== "." && s !== "..";
