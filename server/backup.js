// Consistent database snapshots (SQLite "VACUUM INTO" — safe while the app runs).
// Uploaded files live in DATA_DIR/uploads and are never changed after upload,
// so copying that folder at any time is enough to back them up.
import fs from "node:fs";
import path from "node:path";

export function snapshot(store, dir = path.join(store.dataDir, "backups")) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `fieldbook-${stamp}.db`);
  try { fs.unlinkSync(file); } catch {}
  store.db.prepare("VACUUM INTO ?").run(file);
  return file;
}

export function prune(dir, keep) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^fieldbook-\d{8}-\d{6}\.db$/.test(f)).sort(); } catch { return 0; }
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return old.length;
}

/** One snapshot a day at BACKUP_HOUR (server time); keeps the newest BACKUP_KEEP. 0 = off. */
export function startDailyBackups(store, config, log = console) {
  if (!config.backupKeep) return () => {};
  const dir = path.join(store.dataDir, "backups");
  const tick = () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;  // server's local day
    if (now.getHours() < config.backupHour || store.kvGet("lastBackup") === today) return;
    try {
      const f = snapshot(store, dir);
      store.kvSet("lastBackup", today);
      prune(dir, config.backupKeep);
      log.log?.(`[backup] ${path.basename(f)}`);
    } catch (e) { log.error?.("[backup] failed:", e.message); }
  };
  const t = setInterval(tick, 10 * 60_000); t.unref?.();
  setTimeout(tick, 30_000).unref?.();
  return () => clearInterval(t);
}
