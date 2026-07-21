import { writeFile, mkdir } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import unzipper from 'unzipper';

const outputPath = new URL('../netlify/functions/data/gtfs-index.json', import.meta.url);

if (process.env.SKIP_GTFS_DOWNLOAD === 'true') {
  console.log('Skipping GTFS download; keeping the bundled demo index.');
  process.exit(0);
}

const sourceUrl = process.env.GTFS_STATIC_URL || 'https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip';
const allowedAgencyNames = (process.env.ALLOWED_AGENCY_NAMES ?? 'Bus Átha Cliath')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

function csvFile(directory, filename) {
  const entry = directory.files.find((file) => file.path.toLowerCase().endsWith(filename.toLowerCase()));
  if (!entry) throw new Error(`${filename} is missing from the GTFS ZIP.`);
  return entry.buffer().then((buffer) => parse(buffer, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }));
}

function allowedAgency(name) {
  if (!allowedAgencyNames.length) return true;
  const candidate = String(name || '').toLowerCase();
  return allowedAgencyNames.some((allowed) => candidate.includes(allowed));
}

console.log(`Downloading current GTFS schedule from ${sourceUrl}`);
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`GTFS download failed with HTTP ${response.status}.`);

const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
const [agencyRows, routeRows, tripRows, stopRows] = await Promise.all([
  csvFile(archive, 'agency.txt'),
  csvFile(archive, 'routes.txt'),
  csvFile(archive, 'trips.txt'),
  csvFile(archive, 'stops.txt')
]);

const agencies = Object.fromEntries(agencyRows.map((row) => [row.agency_id || 'default', row.agency_name || '']));
const routes = {};
for (const row of routeRows) {
  const agencyName = agencies[row.agency_id || 'default'] || row.agency_id || '';
  if (!allowedAgency(agencyName)) continue;
  routes[row.route_id] = {
    shortName: row.route_short_name || row.route_id,
    longName: row.route_long_name || '',
    agencyName,
    type: row.route_type || ''
  };
}

const trips = {};
for (const row of tripRows) {
  if (!routes[row.route_id]) continue;
  trips[row.trip_id] = {
    routeId: row.route_id,
    headsign: row.trip_headsign || '',
    directionId: row.direction_id || ''
  };
}

const stopsByCode = {};
for (const row of stopRows) {
  const code = String(row.stop_code || '').trim();
  if (!/^\d{1,8}$/.test(code)) continue;
  const id = String(row.stop_id || '').trim();
  if (!id) continue;

  const existing = stopsByCode[code];
  if (existing) {
    if (!existing.ids.includes(id)) existing.ids.push(id);
  } else {
    stopsByCode[code] = {
      ids: [id],
      name: row.stop_name || `Stop ${code}`,
      lat: Number(row.stop_lat) || null,
      lon: Number(row.stop_lon) || null
    };
  }
}

const index = {
  generatedAt: new Date().toISOString(),
  source: sourceUrl,
  agencyFilter: allowedAgencyNames,
  agencies,
  routes,
  trips,
  stopsByCode
};

await mkdir(new URL('../netlify/functions/data/', import.meta.url), { recursive: true });
await writeFile(outputPath, JSON.stringify(index));
console.log(`GTFS index ready: ${Object.keys(stopsByCode).length} stops, ${Object.keys(routes).length} routes, ${Object.keys(trips).length} trips.`);
if (allowedAgencyNames.length) console.log(`Agency filter: ${allowedAgencyNames.join(', ')}`);
else console.log(`Agencies found: ${[...new Set(Object.values(agencies))].filter(Boolean).join(' | ')}`);
