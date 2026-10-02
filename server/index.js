// Start-up: node server/index.js  (or npm start)
import { loadDotEnv, readConfig } from "./config.js";
import { createApp } from "./app.js";
import { startNotifier } from "./notify.js";
import { startDailyBackups } from "./backup.js";
import { startWeather } from "./weather.js";

loadDotEnv();
const config = readConfig();
const app = createApp(config);
const stops = [startNotifier(app.store, config, app.mailer), startDailyBackups(app.store, config)];
if (config.weather) stops.push(startWeather(app.store));

app.server.listen(config.port, config.host, () => {
  console.log(`Fieldbook is running on http://localhost:${config.port}${config.publicUrl ? `  (public address: ${config.publicUrl})` : ""}`);
  console.log(`Data folder: ${config.dataDir}`);
  console.log(`AI: ${app.ai.enabled ? `on (${app.ai.provider})` : "off (see AI settings in .env)"} · Morning e-mails: ${app.mailer.kind === "none" ? "off (set SMTP_URL)" : "on"}`);
  if (app.auth.needsSetup()) console.log(`First run: open the address above to create the owner (Admin) account.`);
});

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig}: shutting down…`);
  stops.forEach((s) => s());
  const t = setTimeout(() => process.exit(0), 5000); t.unref();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
