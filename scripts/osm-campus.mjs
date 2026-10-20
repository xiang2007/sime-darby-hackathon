// Saves a snapshot of the APU campus from OpenStreetMap (boundary, buildings, footpaths, entrances)
// to web/data/apu-campus.osm.json. The app loads this file first, so it doesn't depend on Overpass at runtime.
//   node scripts/osm-campus.mjs            # ask Overpass and save
//   node scripts/osm-campus.mjs saved.json # use a file you exported from overpass-turbo.eu instead
// The query lives in web/index.html (CAMPUS_QUERY), so the app and this script always ask the same thing.
// Map data © OpenStreetMap contributors, ODbL: keep the credit wherever the data is shown.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Paths from the repo root, so the script works from any folder
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = ROOT + "web/data/apu-campus.osm.json";
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"];
// Overpass turns away requests with Node's default headers (HTTP 406), so say who we are and what we want back
const HEADERS = { "User-Agent": "UCampass-campus-snapshot/1.0 (github.com/xiang2007/sime-darby-hackathon)",
  Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function query() {
  const html = readFileSync(ROOT + "web/index.html", "utf8");
  const bbox = html.match(/const CAMPUS_BBOX=\[([^\]]+)\]/)?.[1];
  const q = html.match(/const CAMPUS_QUERY=`([^`]+)`/)?.[1];
  if (!bbox || !q) throw new Error("CAMPUS_BBOX or CAMPUS_QUERY not found in web/index.html");
  return q.replaceAll("${CAMPUS_BBOX}", bbox);
}

async function fetchOsm() {
  const data = query();
  for (let round = 0; round < 2; round++) {
    if (round) { console.warn("Waiting 30 s, then trying each server once more…"); await sleep(30000); }
    for (const url of SERVERS) {
      try {
        const r = await fetch(url, { method: "POST", headers: HEADERS, body: new URLSearchParams({ data }).toString() });
        if (r.ok) return await r.json();
        const why = (await r.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
        console.warn(`${url}: HTTP ${r.status}${why ? ` (${why})` : ""}`);
      } catch (e) { console.warn(`${url}: ${e.message}`); }
    }
  }
  throw new Error("Overpass didn't answer. Run the query on overpass-turbo.eu, export the raw JSON and pass the file here.");
}

const osm = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : await fetchOsm();
if (!Array.isArray(osm.elements)) throw new Error("Not Overpass JSON (no elements array)");
const count = t => osm.elements.filter(t).length;
mkdirSync(ROOT + "web/data", { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...osm, snapshot_at: new Date().toISOString() }));
console.log(`Saved ${OUT}: ${count(e => e.tags?.amenity === "university" || e.tags?.landuse === "education")} campus areas, ` +
  `${count(e => e.tags?.building)} buildings, ${count(e => e.tags?.highway)} paths, ${count(e => e.tags?.entrance)} entrances.`);
console.log("Check it in the app: Floor plan → Place on map. Credit: © OpenStreetMap contributors (ODbL).");
