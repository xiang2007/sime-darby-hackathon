// Saves a snapshot of the APU campus from OpenStreetMap (boundary, buildings, footpaths, entrances)
// to web/data/apu-campus.osm.json. The app loads this file first, so it doesn't depend on Overpass at runtime.
//   node scripts/osm-campus.mjs            # ask Overpass and save
//   node scripts/osm-campus.mjs saved.json # use a file you exported from overpass-turbo.eu instead
// The query lives in web/index.html (CAMPUS_QUERY), so the app and this script always ask the same thing.
// Map data © OpenStreetMap contributors, ODbL: keep the credit wherever the data is shown.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = "web/data/apu-campus.osm.json";
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

function query() {
  const html = readFileSync("web/index.html", "utf8");
  const bbox = html.match(/const CAMPUS_BBOX=\[([^\]]+)\]/)?.[1];
  const q = html.match(/const CAMPUS_QUERY=`([^`]+)`/)?.[1];
  if (!bbox || !q) throw new Error("CAMPUS_BBOX or CAMPUS_QUERY not found in web/index.html");
  return q.replaceAll("${CAMPUS_BBOX}", bbox);
}

async function fetchOsm() {
  const data = query();
  for (const url of SERVERS) {
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data }) });
      if (r.ok) return await r.json();
      console.warn(`${url}: HTTP ${r.status}`);
    } catch (e) { console.warn(`${url}: ${e.message}`); }
  }
  throw new Error("Overpass didn't answer. Run the query on overpass-turbo.eu, export the raw JSON and pass the file here.");
}

const osm = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : await fetchOsm();
if (!Array.isArray(osm.elements)) throw new Error("Not Overpass JSON (no elements array)");
const count = t => osm.elements.filter(t).length;
mkdirSync("web/data", { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...osm, snapshot_at: new Date().toISOString() }));
console.log(`Saved ${OUT}: ${count(e => e.tags?.amenity === "university" || e.tags?.landuse === "education")} campus areas, ` +
  `${count(e => e.tags?.building)} buildings, ${count(e => e.tags?.highway)} paths, ${count(e => e.tags?.entrance)} entrances.`);
console.log("Check it in the app: Floor plan → Place on map. Credit: © OpenStreetMap contributors (ODbL).");
