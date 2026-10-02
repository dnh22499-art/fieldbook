// 6-day job-site forecasts from Open-Meteo (free, no API key). Writes the
// weather/{projectId} documents Fieldbook shows on Home:
//   {projectId, address, place, source, unit:"metric", tz, updatedAt, alerts:[], days:[{date, icon, phrase, hi, lo, rain, thunder, rainMm, gust, feel}]}
// `icon` uses AccuWeather-style numbers so the page's icon rules work unchanged.
const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FC = "https://api.open-meteo.com/v1/forecast";
const MAX_AGE_MS = 3 * 3600e3;

const WMO = {
  0: [1, "Clear sky"], 1: [2, "Mainly clear"], 2: [3, "Partly cloudy"], 3: [7, "Overcast"],
  45: [11, "Fog"], 48: [11, "Freezing fog"],
  51: [12, "Light drizzle"], 53: [12, "Drizzle"], 55: [12, "Heavy drizzle"], 56: [26, "Freezing drizzle"], 57: [26, "Freezing drizzle"],
  61: [12, "Light rain"], 63: [18, "Rain"], 65: [18, "Heavy rain"], 66: [26, "Freezing rain"], 67: [26, "Freezing rain"],
  71: [19, "Light snow"], 73: [22, "Snow"], 75: [22, "Heavy snow"], 77: [19, "Snow grains"],
  80: [12, "Rain showers"], 81: [18, "Rain showers"], 82: [18, "Violent rain showers"], 85: [22, "Snow showers"], 86: [22, "Heavy snow showers"],
  95: [15, "Thunderstorm"], 96: [15, "Thunderstorm with hail"], 99: [15, "Thunderstorm with heavy hail"],
};
const US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };

// "482 Maple St, Garden Grove, CA 92840" → candidate place names plus a US state filter.
export function placeCandidates(address) {
  const parts = String(address || "").split(",").map((s) => s.trim()).filter(Boolean);
  let state = null;
  const out = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    let p = parts[i].replace(/\b\d{4,6}(-\d{4})?\b/g, "").trim();           // drop ZIP / postal codes
    const m = /^([A-Z]{2})$/.exec(p);
    if (m && US_STATES[m[1]] && i === parts.length - 1) { state = US_STATES[m[1]]; continue; }
    if (!p || (/\d/.test(p) && i === 0)) continue;                             // the street line
    p = p.replace(/^(TP\.?|Thành phố|Tp\.?)\s+/i, "").replace(/^(Quận|Huyện|Phường|Q\.)\s+/i, "");
    if (p.length >= 2) out.push(p);
  }
  // Read from the end of the address: city / province first, then smaller areas as fallbacks.
  return { names: out.slice(0, 3), state };
}

export function mapForecast(fc) {
  const d = fc.daily || {};
  return (d.time || []).map((date, i) => {
    const code = d.weather_code?.[i];
    const [icon, phrase] = WMO[code] || [1, "—"];
    const n = (arr) => (arr && arr[i] != null ? Math.round(arr[i] * 10) / 10 : 0);
    return {
      date, icon, phrase,
      hi: n(d.temperature_2m_max), lo: n(d.temperature_2m_min), feel: n(d.apparent_temperature_max),
      rain: n(d.precipitation_probability_max), thunder: code >= 95 ? Math.max(60, n(d.precipitation_probability_max)) : 0,
      rainMm: n(d.precipitation_sum), gust: n(d.wind_gusts_10m_max),
    };
  });
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { "user-agent": "Fieldbook (self-hosted)" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

export function createWeather(store, { fetchImpl = fetch, log = console } = {}) {
  const geoCache = new Map();
  async function locate(address) {
    const { names, state } = placeCandidates(address);
    for (const name of names) {
      const key = name + "|" + (state || "");
      if (geoCache.has(key)) return geoCache.get(key);
      const g = await getJson(`${GEO}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`, fetchImpl);
      let hits = g.results || [];
      if (state) hits = hits.filter((h) => h.country_code === "US" && h.admin1 === state);
      const h = hits[0];
      if (h) {
        const abbr = state ? Object.keys(US_STATES).find((k) => US_STATES[k] === state) : null;
        const loc = { lat: h.latitude, lon: h.longitude, tz: h.timezone || "UTC", place: [h.name, abbr || h.admin1 || h.country].filter(Boolean).join(", ") };
        geoCache.set(key, loc);
        return loc;
      }
    }
    return null;
  }
  async function refresh({ force = false } = {}) {
    const sites = store.list("projects").filter((p) => !p.data.archived && String(p.data.address || "").trim());
    const have = new Map(store.list("weather").map((w) => [w.id, w.data]));
    let changed = 0;
    const skipped = [];
    for (const p of sites) {
      const addr = p.data.address.trim();
      const old = have.get(p.id);
      const age = old ? Date.now() - Date.parse(old.updatedAt || 0) : Infinity;
      if (!force && old && old.address === addr && age < MAX_AGE_MS) continue;
      try {
        const loc = await locate(addr);
        if (!loc) { skipped.push(`${p.data.name}: address not found`); continue; }
        const fc = await getJson(`${FC}?latitude=${loc.lat}&longitude=${loc.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max&timezone=${encodeURIComponent(loc.tz)}&forecast_days=6`, fetchImpl);
        store.set("weather", p.id, { projectId: p.id, address: addr, place: loc.place, source: "Open-Meteo", unit: "metric", tz: fc.timezone || loc.tz, updatedAt: new Date().toISOString(), alerts: [], days: mapForecast(fc) });
        changed++;
      } catch (e) { skipped.push(`${p.data.name}: ${e.message}`); }
    }
    for (const id of have.keys()) if (!sites.some((s) => s.id === id)) { store.del("weather", id); changed++; }
    if (skipped.length) log.warn?.("[weather] skipped: " + skipped.join("; "));
    return { changed, skipped };
  }
  return { refresh, locate };
}

/** Refreshes hourly (each forecast is renewed when older than 3 hours) and shortly after any project changes. */
export function startWeather(store, opts = {}) {
  const w = createWeather(store, opts);
  let busy = false, again = false, soon = null;
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { await w.refresh(); } catch (e) { (opts.log || console).warn?.("[weather] " + e.message); }
    finally { busy = false; if (again) { again = false; run(); } }
  };
  const t = setInterval(run, 3600e3); t.unref?.();
  setTimeout(run, 10_000).unref?.();
  const off = store.onChange((coll) => {
    if (coll !== "projects") return;
    clearTimeout(soon);
    soon = setTimeout(run, 20_000); soon.unref?.();
  });
  return () => { clearInterval(t); clearTimeout(soon); off(); };
}
