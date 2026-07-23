import { writeFile, mkdir } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
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
  const entry = csvEntry(directory, filename);
  return entry.buffer().then((buffer) => parse(buffer, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }));
}

function csvEntry(directory, filename) {
  const entry = directory.files.find((file) => file.path.toLowerCase().endsWith(filename.toLowerCase()));
  if (!entry) throw new Error(`${filename} is missing from the GTFS ZIP.`);
  return entry;
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
const [agencyRows, routeRows, tripRows, stopRows, calendarRows, calendarDateRows] = await Promise.all([
  csvFile(archive, 'agency.txt'),
  csvFile(archive, 'routes.txt'),
  csvFile(archive, 'trips.txt'),
  csvFile(archive, 'stops.txt'),
  csvFile(archive, 'calendar.txt').catch(() => []),
  csvFile(archive, 'calendar_dates.txt').catch(() => [])
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
const tripIdsByScheduleIndex = [];
for (const row of tripRows) {
  if (!routes[row.route_id]) continue;
  const scheduleIndex = tripIdsByScheduleIndex.length;
  tripIdsByScheduleIndex.push(row.trip_id);
  trips[row.trip_id] = {
    routeId: row.route_id,
    headsign: row.trip_headsign || '',
    directionId: row.direction_id || '',
    serviceId: row.service_id || '',
    scheduleIndex
  };
}

function timeToSeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const scheduledStopTimesByStop = {};
let scheduledStopTimeCount = 0;
const stopTimeParser = csvEntry(archive, 'stop_times.txt').stream().pipe(parseStream({
  columns: true,
  skip_empty_lines: true,
  bom: true,
  relax_column_count: true
}));
for await (const row of stopTimeParser) {
  const tripId = String(row.trip_id || '').trim();
  if (!trips[tripId]) continue;
  const sequence = Number(row.stop_sequence);
  const stopId = String(row.stop_id || '').trim();
  const seconds = timeToSeconds(row.arrival_time || row.departure_time);
  if (!Number.isFinite(sequence) || !stopId || seconds == null) continue;
  (scheduledStopTimesByStop[stopId] ||= []).push(trips[tripId].scheduleIndex, sequence, seconds);
  scheduledStopTimeCount += 1;
}

const weekdayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const services = {};
for (const row of calendarRows) {
  const serviceId = String(row.service_id || '').trim();
  if (!serviceId) continue;
  let weekdayMask = 0;
  weekdayNames.forEach((day, index) => {
    if (String(row[day] || '') === '1') weekdayMask |= (1 << index);
  });
  services[serviceId] = [String(row.start_date || ''), String(row.end_date || ''), weekdayMask];
}

const serviceExceptions = {};
for (const row of calendarDateRows) {
  const serviceId = String(row.service_id || '').trim();
  const date = String(row.date || '').trim();
  const exceptionType = Number(row.exception_type);
  if (!serviceId || !/^\d{8}$/.test(date) || ![1, 2].includes(exceptionType)) continue;
  const entry = (serviceExceptions[date] ||= [[], []]);
  entry[exceptionType === 1 ? 0 : 1].push(serviceId);
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
  tripIdsByScheduleIndex,
  scheduledStopTimesByStop,
  services,
  serviceExceptions,
  stopsByCode
};

await mkdir(new URL('../netlify/functions/data/', import.meta.url), { recursive: true });
await writeFile(outputPath, JSON.stringify(index));
console.log(`GTFS index ready: ${Object.keys(stopsByCode).length} stops, ${Object.keys(routes).length} routes, ${Object.keys(trips).length} trips.`);
console.log(`Scheduled stop times indexed: ${scheduledStopTimeCount}.`);
if (allowedAgencyNames.length) console.log(`Agency filter: ${allowedAgencyNames.join(', ')}`);
else console.log(`Agencies found: ${[...new Set(Object.values(agencies))].filter(Boolean).join(' | ')}`);
