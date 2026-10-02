// Makes a database snapshot now: data/backups/fieldbook-YYYYMMDD-HHMMSS.db
// Safe while Fieldbook is running. Uploaded files are in data/uploads — copy that folder too.
//   node scripts/backup.js        With Docker: docker compose exec fieldbook node scripts/backup.js
import { loadDotEnv, readConfig } from "../server/config.js";
import { openStore } from "../server/store.js";
import { snapshot } from "../server/backup.js";

loadDotEnv();
const store = openStore(readConfig().dataDir);
console.log("Backup written: " + snapshot(store));
store.close();
