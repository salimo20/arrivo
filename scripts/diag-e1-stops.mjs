// scripts/diag-e1-stops.mjs
// TEMPORARY diagnostic. Does NOT modify production behaviour.
// Reproduces ArrivoGo's decode + filter logic in an instrumented form so that
// every E1 StopTimeUpdate lands in exactly one classification, and every live
// E1 trip that statically serves stop 773 gets one mutually-exclusive verdict.
//
// Usage:
//   node --env-file=.env scripts/diag-e1-stops.mjs <label>
//     <label> is "peak" or "offpeak" (used in output filenames only)
//
// Reads the PRODUCTION-generated index at netlify/functions/data/gtfs-index.json.
// Makes exactly ONE live NTA TripUpdates request. Never prints the API key.

import { readFile, writeFile } from 'node:fs/promises';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;

const TARGET_CODES = ['773', '774', '775'];
const PRIMARY_CODE = '773';
const ROUTE_SHORT = 'E1';
const label = (process.argv[2] || 'run').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'run';

const INDEX_URL = new URL('../netlify/functions/data/gtfs-index.json', import.meta.url);

// ---- load + guard the index ------------------------------------------------
const index = JSON.parse(await readFile(INDEX_URL, 'utf8'));

for (const code of TARGET_CODES) {
  const entry = index.stopsByCode?.[code];
  if (!entry?.ids?.length) {
    throw new Error(
      `Production GTFS index required: stop ${code} has no mapped stop IDs. ` +
      `Do not use the demo index stored in GitHub. Run scripts/build-gtfs-index.mjs first.`
    );
  }
}

console.log(`Index generatedAt: ${index.generatedAt}`);
console.log(`Index source:      ${index.source}`);
for (const code of TARGET_CODES) {
  const e = index.stopsByCode[code];
  console.log(`Stop ${code}: found, ${e.ids.length} mapped ID${e.ids.length === 1 ? '' : 's'} [${e.ids.join(', ')}]  "${e.name}"`);
}

// ---- helpers mirrored from lib/gtfs.mjs (do not import; keep prod untouched)
function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') { const p = Number(value); return Number.isFinite(p) ? p : null; }
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low === 'number') return value.low + (value.high || 0) * 4294967296;
  return null;
}

const dublinParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function dublinOffsetMs(ms) {
  const p = Object.fromEntries(dublinParts.formatToParts(new Date(ms))
    .filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}
function scheduledEpochSeconds(startDate, sec) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(startDate || ''));
  if (!m || !Number.isFinite(sec)) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]) + sec * 1000;
  let epoch = wall - dublinOffsetMs(wall);
  epoch = wall - dublinOffsetMs(epoch);
  return Math.floor(epoch / 1000);
}
function detectWholeHourClockCorrection(feedTs, nowSec) {
  const t = toNumber(feedTs); if (t == null) return 0;
  const skew = t - nowSec; const wh = Math.round(skew / 3600);
  if (wh === 0 || Math.abs(wh) > 2) return 0;
  return Math.abs(skew - wh * 3600) <= 900 ? -wh * 3600 : 0;
}

// scheduledTimeFor, mirrored exactly from production (incl. its limitations)
function scheduledTimeForProd(tripId, stopUpdate) {
  const tripIndex = index.trips?.[tripId]?.scheduleIndex;
  const stopId = String(stopUpdate.stopId || '');
  const byStop = index.scheduledStopTimesByStop?.[stopId];
  const sequence = toNumber(stopUpdate.stopSequence);
  if (tripIndex != null && byStop) {
    for (let p = 0; p < byStop.length; p += 3) {
      if (byStop[p] !== tripIndex) continue;
      if (sequence == null || byStop[p + 1] === sequence) return byStop[p + 2];
    }
  }
  const tripTimes = index.scheduledStopTimes?.[tripId]; // absent in production
  if (!tripTimes) return null;
  for (let p = 0; p < tripTimes.length; p += 3) {
    if (sequence != null && tripTimes[p] === sequence) return tripTimes[p + 2];
    if (sequence == null && stopId && tripTimes[p + 1] === stopId) return tripTimes[p + 2];
  }
  return null;
}

// Build a reverse map (tripId, sequence) -> stopId by scanning the forward
// scheduledStopTimesByStop once. This is what the PROPOSED fix would rely on;
// here it is used ONLY to *classify* whether a sequence-only record is
// recoverable in principle. It does not change production output.
function buildSeqResolver() {
  const bySchedIndex = new Map(); // scheduleIndex -> Map(seq -> stopId)
  const codeByStopId = new Map();
  for (const code of Object.keys(index.stopsByCode)) {
    for (const id of index.stopsByCode[code].ids) codeByStopId.set(id, code);
  }
  for (const [stopId, arr] of Object.entries(index.scheduledStopTimesByStop || {})) {
    for (let p = 0; p < arr.length; p += 3) {
      const si = arr[p], seq = arr[p + 1];
      let m = bySchedIndex.get(si);
      if (!m) { m = new Map(); bySchedIndex.set(si, m); }
      if (!m.has(seq)) m.set(seq, stopId);
    }
  }
  return { bySchedIndex, codeByStopId };
}
const resolver = buildSeqResolver();
function resolveSeqToStopId(tripId, sequence) {
  const si = index.trips?.[tripId]?.scheduleIndex;
  if (si == null || sequence == null) return '';
  return resolver.bySchedIndex.get(si)?.get(sequence) || '';
}

// ---- E1 route ids + the static trip set that serves 773 --------------------
const E1_ROUTE_IDS = new Set(
  Object.keys(index.routes).filter(r => String(index.routes[r].shortName || '').toUpperCase() === ROUTE_SHORT)
);
const targetIds = Object.fromEntries(TARGET_CODES.map(c => [c, new Set(index.stopsByCode[c].ids)]));

function staticE1TripsServing(code) {
  const set = new Set();
  for (const id of index.stopsByCode[code].ids) {
    const arr = index.scheduledStopTimesByStop[id] || [];
    for (let p = 0; p < arr.length; p += 3) {
      const t = index.tripIdsByScheduleIndex[arr[p]];
      if (E1_ROUTE_IDS.has(index.trips[t]?.routeId)) set.add(t);
    }
  }
  return set;
}
const static773Trips = staticE1TripsServing(PRIMARY_CODE);

// ---- fetch ONE live feed ---------------------------------------------------
const FEED_URL = process.env.NTA_TRIP_UPDATES_URL || 'https://api.nationaltransport.ie/gtfsr/v2/TripUpdates';
const HEADER = process.env.NTA_API_HEADER || 'x-api-key';
const KEY = process.env.NTA_API_KEY;
if (!KEY) throw new Error('NTA_API_KEY missing. Run with: node --env-file=.env scripts/diag-e1-stops.mjs <label>');

const res = await fetch(FEED_URL, { headers: { [HEADER]: KEY } });
if (!res.ok) throw new Error(`NTA feed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const buf = new Uint8Array(await res.arrayBuffer());
const feed = transit_realtime.FeedMessage.decode(buf);

const nowSec = Math.floor(Date.now() / 1000);
const feedTs = toNumber(feed.header?.timestamp);
const clockCorrection = detectWholeHourClockCorrection(feedTs, nowSec);
const horizon = nowSec + 3 * 60 * 60;
const dublinNow = dublinParts.format(new Date());

// ---- classification of every E1 StopTimeUpdate -----------------------------
const CATS = [
  'MATCHED_TRIP_UPDATE',
  'MISSING_STOP_ID_SEQ_RESOLVABLE',
  'MISSING_STOP_ID_SEQ_UNRESOLVABLE_UNKNOWN_TRIP',
  'MISSING_STOP_ID_SEQ_UNRESOLVABLE_UNKNOWN_SEQUENCE',
  'MISSING_STOP_ID_NO_SEQUENCE',
  'WRONG_STOP_ID',
  'TRIP_ID_NOT_FOUND_IN_STATIC_INDEX',
  'UNKNOWN_ROUTE',
  'ROUTE_MISMATCH',
  'MISSING_ETA',
  'MISSING_SCHEDULED_TIME',
  'PAST_DECODE_WINDOW_60_SECONDS',
  'PAST_FINAL_FILTER_WINDOW_45_SECONDS',
  'OUTSIDE_3_HOUR_HORIZON',
  'CANCELLED_OR_DELETED',
  'SKIPPED_STOP'
];

// per target code: records that pertain to that code (either carry its id, or
// are sequence-only on a trip that statically serves it and resolve to its id)
const perCode = Object.fromEntries(TARGET_CODES.map(c => [c, { counts: {}, samples: {} }]));
for (const c of TARGET_CODES) for (const cat of CATS) { perCode[c].counts[cat] = 0; perCode[c].samples[cat] = []; }

const liveE1 = [];        // per-entity summaries (Part 2)
const tripVerdict773 = new Map(); // realtime tripId -> verdict (Part 3 per-trip)

function relName(v) {
  const n = { 0: 'SCHEDULED', 1: 'SKIPPED', 2: 'NO_DATA', 3: 'UNSCHEDULED', 5: 'REPLACEMENT', 6: 'DUPLICATED', 7: 'DELETED' };
  return typeof v === 'string' ? v : (n[v] || 'SCHEDULED');
}
function tripRelName(v) {
  const n = { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT', 6: 'DUPLICATED', 7: 'DELETED' };
  return typeof v === 'string' ? v : (n[v] || 'SCHEDULED');
}

let totalTripUpdates = 0;
let e1TripUpdates = 0;

for (const entity of feed.entity || []) {
  const update = entity.tripUpdate;
  if (!update) continue;
  totalTripUpdates += 1;
  if (!update.trip) continue;

  const tripId = update.trip.tripId || '';
  const tripMeta = index.trips[tripId] || {};
  const rtRouteId = update.trip.routeId || '';
  const routeId = rtRouteId || tripMeta.routeId || '';
  const routeMeta = index.routes[routeId];
  const staticShort = routeMeta ? String(routeMeta.shortName || '').toUpperCase() : '';

  // Is this an E1 trip? Accept if realtime route resolves to E1, OR the static
  // trip resolves to an E1 route (covers route_id string mismatches).
  const rtLooksE1 = /(^|\s)E1(\s|$)/.test(String(rtRouteId));
  const staticIsE1 = E1_ROUTE_IDS.has(tripMeta.routeId);
  if (!rtLooksE1 && !staticIsE1 && staticShort !== ROUTE_SHORT) continue;
  e1TripUpdates += 1;

  const tripRelationship = tripRelName(update.trip.scheduleRelationship);
  const stus = update.stopTimeUpdate || [];
  const seqs = stus.map(s => toNumber(s.stopSequence)).filter(n => n != null);
  const anyStopId = stus.some(s => s.stopId);
  const anyСeq = seqs.length > 0;

  liveE1.push({
    entity_id: entity.id,
    rt_trip_id: tripId,
    rt_route_id: rtRouteId,
    rt_direction_id: update.trip.directionId ?? null,
    static_lookup: index.trips[tripId] ? 'FOUND' : 'NOT_FOUND',
    static_route_short: staticShort || null,
    static_direction_id: tripMeta.directionId ?? null,
    start_date: update.trip.startDate || null,
    start_time: update.trip.startTime || null,
    trip_schedule_relationship: tripRelationship,
    stu_count: stus.length,
    any_stop_id: anyStopId,
    any_sequence: anyСeq,
    only_stop_id: stus.filter(s => s.stopId && toNumber(s.stopSequence) == null).length,
    only_sequence: stus.filter(s => !s.stopId && toNumber(s.stopSequence) != null).length,
    both: stus.filter(s => s.stopId && toNumber(s.stopSequence) != null).length,
    neither: stus.filter(s => !s.stopId && toNumber(s.stopSequence) == null).length,
    min_seq: seqs.length ? Math.min(...seqs) : null,
    max_seq: seqs.length ? Math.max(...seqs) : null,
    has_773: stus.some(s => targetIds['773'].has(String(s.stopId || ''))),
    has_774: stus.some(s => targetIds['774'].has(String(s.stopId || ''))),
    has_775: stus.some(s => targetIds['775'].has(String(s.stopId || ''))),
  });

  const servesStatically = static773Trips.has(tripId); // trip that SHOULD hit 773

  // walk each stop update, classify against each target code it pertains to
  let verdict773 = null;

  for (const su of stus) {
    const rtStopId = String(su.stopId || '');
    const seq = toNumber(su.stopSequence);
    const stopRel = relName(su.scheduleRelationship);
    const arrivalTime = toNumber(su.arrival?.time);
    const departureTime = toNumber(su.departure?.time);
    const delay = toNumber(su.arrival?.delay) ?? toNumber(su.departure?.delay) ?? 0;

    // Determine which target code, if any, this stop update is ABOUT.
    let aboutCode = null;
    if (rtStopId) {
      for (const c of TARGET_CODES) if (targetIds[c].has(rtStopId)) aboutCode = c;
    } else if (seq != null) {
      const resolvedId = resolveSeqToStopId(tripId, seq);
      for (const c of TARGET_CODES) if (targetIds[c].has(resolvedId)) aboutCode = c;
    }
    if (!aboutCode) continue; // this STU isn't about 773/774/775

    // classify
    const failures = [];
    let category = null;

    if (!routeMeta) { failures.push('UNKNOWN_ROUTE'); }
    if (routeMeta && staticShort && staticShort !== ROUTE_SHORT) failures.push('ROUTE_MISMATCH');
    if (['CANCELED', 'DELETED'].includes(tripRelationship)) failures.push('CANCELLED_OR_DELETED');
    if (stopRel === 'SKIPPED') failures.push('SKIPPED_STOP');

    // scheduled-time reconstruction, mirrored from production
    const scheduledSeconds = scheduledTimeForProd(tripId, su);
    const scheduledEpoch = scheduledEpochSeconds(update.trip.startDate, scheduledSeconds);
    let eta = arrivalTime ?? departureTime;
    if (eta != null) eta += clockCorrection;
    let reconstructed = false;
    if (!eta) {
      if (scheduledEpoch != null) { eta = scheduledEpoch + delay; reconstructed = true; }
      else failures.push('MISSING_SCHEDULED_TIME');
    }
    if (!eta) failures.push('MISSING_ETA');

    // stop-id resolution status (the crux)
    const seqResolvedId = (!rtStopId && seq != null) ? resolveSeqToStopId(tripId, seq) : '';
    if (!rtStopId) {
      if (seq == null) failures.push('MISSING_STOP_ID_NO_SEQUENCE');
      else if (!index.trips[tripId]) failures.push('MISSING_STOP_ID_SEQ_UNRESOLVABLE_UNKNOWN_TRIP');
      else if (!seqResolvedId) failures.push('MISSING_STOP_ID_SEQ_UNRESOLVABLE_UNKNOWN_SEQUENCE');
      else failures.push('MISSING_STOP_ID_SEQ_RESOLVABLE');
    } else if (!targetIds[aboutCode].has(rtStopId)) {
      failures.push('WRONG_STOP_ID');
    }

    if (!index.trips[tripId]) failures.push('TRIP_ID_NOT_FOUND_IN_STATIC_INDEX');

    // time windows (production: decode drops <now-60 or >horizon; filter drops <now-45)
    if (eta != null) {
      if (eta < nowSec - 60 || eta > horizon) {
        if (eta > horizon) failures.push('OUTSIDE_3_HOUR_HORIZON');
        else failures.push('PAST_DECODE_WINDOW_60_SECONDS');
      } else if (eta < nowSec - 45) {
        failures.push('PAST_FINAL_FILTER_WINDOW_45_SECONDS');
      }
    }

    // Would production actually DISPLAY this? It displays iff:
    //  - it survives decode (has eta, within [-60, horizon]) AND
    //  - the pushed stopId (== rtStopId||'') is in the wanted id set AND
    //  - survives filter window (-45)
    const prodPushedStopId = rtStopId || '';
    const prodDecodeOk = eta != null && eta >= nowSec - 60 && eta <= horizon;
    const prodFilterOk = eta != null && eta >= nowSec - 45;
    const prodStopMatch = targetIds[aboutCode].has(prodPushedStopId);
    const displayed = prodDecodeOk && prodFilterOk && prodStopMatch
      && !['CANCELED', 'DELETED'].includes(tripRelationship) && stopRel !== 'SKIPPED';

    if (displayed) category = 'MATCHED_TRIP_UPDATE';
    else category = failures[0] || 'MATCHED_TRIP_UPDATE';

    const rec = {
      first_failure: failures[0] || null,
      all_failures: failures,
      category,
      displayed,
      rt_trip_id: tripId,
      rt_stop_id: rtStopId,
      stop_sequence: seq,
      seq_resolved_stop_id: seqResolvedId || null,
      eta,
      eta_dublin: eta ? dublinParts.format(new Date(eta * 1000)) : null,
      delay,
      reconstructed,
      static_trip_found: !!index.trips[tripId],
      static_serves_773: servesStatically,
    };

    perCode[aboutCode].counts[category] += 1;
    if (perCode[aboutCode].samples[category].length < 3) perCode[aboutCode].samples[category].push(rec);

    // per-trip verdict for 773 (mutually exclusive; first pertinent STU wins,
    // but prefer a "displayed" if any STU displays)
    if (aboutCode === PRIMARY_CODE) {
      const v = displayed ? 'displayed'
        : rtStopId && !targetIds['773'].has(rtStopId) ? 'wrong stop ID'
        : !rtStopId && seq == null ? 'missing from live stop list'
        : !rtStopId && !index.trips[tripId] ? 'unknown trip'
        : !rtStopId && !seqResolvedId ? 'sequence-only unresolvable'
        : !rtStopId && seqResolvedId ? 'sequence-only recoverable'
        : (eta != null && eta < nowSec - 45) ? 'present but expired'
        : 'missing from live stop list';
      if (!verdict773 || v === 'displayed') verdict773 = v;
    }
  }

  // trips that statically serve 773 but produced NO stop update about 773 at all
  if (servesStatically && verdict773 == null) verdict773 = 'missing from live stop list';
  if (verdict773 != null) tripVerdict773.set(tripId, verdict773);
}

// ---- assemble reports ------------------------------------------------------
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }

const verdictTally = {};
for (const v of tripVerdict773.values()) verdictTally[v] = (verdictTally[v] || 0) + 1;
const displayed773 = verdictTally['displayed'] || 0;
const rejected773 = [...tripVerdict773.values()].filter(v => v !== 'displayed').length;

const staticCompare = {
  e1_route_ids: [...E1_ROUTE_IDS],
  static_773_trip_count: static773Trips.size,
  live_e1_trip_updates: e1TripUpdates,
  live_trips_serving_773_statically: [...tripVerdict773.keys()].length,
};

const report = {
  meta: {
    label,
    server_time_iso: new Date().toISOString(),
    dublin_wall_clock: dublinNow,
    feed_timestamp: feedTs,
    feed_age_seconds: feedTs != null ? nowSec - feedTs : null,
    clock_correction_seconds: clockCorrection,
    index_generatedAt: index.generatedAt,
    total_feed_entities: (feed.entity || []).length,
    total_trip_updates: totalTripUpdates,
    total_e1_trip_updates: e1TripUpdates,
  },
  static_mapping: Object.fromEntries(TARGET_CODES.map(c => [c, {
    ids: index.stopsByCode[c].ids,
    name: index.stopsByCode[c].name,
    lat: index.stopsByCode[c].lat,
    lon: index.stopsByCode[c].lon,
    static_e1_trips: staticE1TripsServing(c).size,
  }])),
  static_compare: staticCompare,
  per_code_classification: Object.fromEntries(TARGET_CODES.map(c => {
    const total = Object.values(perCode[c].counts).reduce((a, b) => a + b, 0);
    return [c, {
      total_stu_about_code: total,
      counts: perCode[c].counts,
      percentages: Object.fromEntries(Object.entries(perCode[c].counts).map(([k, v]) => [k, pct(v, total)])),
      samples: perCode[c].samples,
    }];
  })),
  trip_verdicts_773: {
    tally: verdictTally,
    displayed: displayed773,
    rejected_total: rejected773,
    rows: [...tripVerdict773.entries()].map(([tripId, verdict]) => ({ tripId, verdict })),
  },
  live_e1_entities: liveE1,
};

const jsonPath = new URL(`../diag-e1-${label}.json`, import.meta.url);
const txtPath = new URL(`../diag-e1-${label}.txt`, import.meta.url);
await writeFile(jsonPath, JSON.stringify(report, null, 2));

// ---- human-readable text ---------------------------------------------------
const L = [];
L.push(`ArrivoGo E1 / 773-774-775 diagnostic  [${label}]`);
L.push(`Dublin wall clock:   ${dublinNow}`);
L.push(`Feed timestamp:      ${feedTs}  (age ${report.meta.feed_age_seconds}s, clock correction ${clockCorrection}s)`);
L.push(`Index generatedAt:   ${index.generatedAt}`);
L.push(`Feed entities:       ${report.meta.total_feed_entities}   tripUpdates: ${totalTripUpdates}   E1 tripUpdates: ${e1TripUpdates}`);
L.push('');
L.push('STATIC MAPPING');
for (const c of TARGET_CODES) {
  const s = report.static_mapping[c];
  L.push(`  ${c}  ${s.ids.join(',')}  "${s.name}"  (${s.lat},${s.lon})  static E1 trips: ${s.static_e1_trips}`);
}
L.push('');
L.push('PER-CODE CLASSIFICATION (E1 stop updates about each code)');
for (const c of TARGET_CODES) {
  const b = report.per_code_classification[c];
  L.push(`  Stop ${c}  (total STU about this code: ${b.total_stu_about_code})`);
  for (const cat of CATS) {
    const n = b.counts[cat]; if (!n) continue;
    L.push(`     ${cat.padEnd(46)} ${String(n).padStart(4)}  ${b.percentages[cat]}%`);
  }
}
L.push('');
L.push('773 PER-TRIP VERDICTS (one mutually-exclusive verdict per live E1 trip that serves 773)');
for (const [v, n] of Object.entries(verdictTally).sort((a, b) => b[1] - a[1])) {
  L.push(`     ${v.padEnd(32)} ${String(n).padStart(4)}`);
}
L.push(`     ${'—'.repeat(38)}`);
L.push(`     displayed        : ${displayed773}`);
L.push(`     rejected (total) : ${rejected773}`);
L.push('');
L.push('SAMPLE 773 STOP UPDATES BY CATEGORY (up to 3 each)');
{
  const b = report.per_code_classification['773'];
  for (const cat of CATS) {
    const s = b.samples[cat]; if (!s || !s.length) continue;
    L.push(`  [${cat}]`);
    for (const r of s) {
      L.push(`     trip=${r.rt_trip_id} stopId="${r.rt_stop_id}" seq=${r.stop_sequence} resolved=${r.seq_resolved_stop_id || '-'} eta=${r.eta_dublin || '-'} delay=${r.delay} displayed=${r.displayed} firstFail=${r.first_failure || '-'}`);
    }
  }
}
await writeFile(txtPath, L.join('\n'));

console.log('\n' + L.join('\n'));
console.log(`\nWrote diag-e1-${label}.json and diag-e1-${label}.txt`);
