import { getStore } from '@netlify/blobs';
import index from './data/gtfs-index.json' with { type: 'json' };
import { decodeTripUpdates } from './lib/gtfs.mjs';

const CACHE_STORE = 'nta-realtime-cache';
const CACHE_KEY = 'trip-updates';
const MINIMUM_NTA_INTERVAL_MS = 61_000;
const MAX_WAIT_MS = 3_500;

function assertEnvironment() {
  if (!process.env.NTA_API_KEY) throw new Error('NTA_API_KEY is missing.');
  if (!process.env.NTA_TRIP_UPDATES_URL) throw new Error('NTA_TRIP_UPDATES_URL is missing.');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function respectNtaInterval(store) {
  const previous = await store.get(CACHE_KEY, { type: 'json' });
  if (!previous) return { previous: null, skipped: false };

  const lastRequest = Date.parse(previous.requestedAt || previous.generatedAt || '');
  if (!Number.isFinite(lastRequest)) return { previous, skipped: false };

  const remaining = MINIMUM_NTA_INTERVAL_MS - (Date.now() - lastRequest);
  if (remaining <= 0) return { previous, skipped: false };

  if (remaining <= MAX_WAIT_MS) {
    await sleep(remaining);
    return { previous, skipped: false };
  }

  return { previous, skipped: true };
}

export async function refreshFeed() {
  const store = getStore({ name: CACHE_STORE, consistency: 'strong' });

  if (process.env.DEMO_MODE === 'true') {
    const now = Math.floor(Date.now() / 1000);
    const demo = {
      requestedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      feedTimestamp: now,
      arrivals: [
        { tripId: 'demo-trip-e1', routeId: 'demo-e1', route: 'E1', destination: 'Northwood', agencyName: 'Dublin Bus', stopId: 'demo-stop', eta: now + 4 * 60, delay: 0, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED', vehicleId: '2441033' },
        { tripId: 'demo-trip-7', routeId: 'demo-7', route: '7', destination: 'Brides Glen', agencyName: 'Dublin Bus', stopId: 'demo-stop', eta: now + 9 * 60, delay: 240, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED', vehicleId: '2441068' },
        { tripId: 'demo-trip-46a', routeId: 'demo-46a', route: '46A', destination: 'Dún Laoghaire', agencyName: 'Dublin Bus', stopId: 'demo-stop', eta: now + 14 * 60, delay: 0, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED', vehicleId: '2441094' },
        { tripId: 'demo-cancelled', routeId: 'demo-e1', route: 'E1', destination: 'Ballywaltrim', agencyName: 'Dublin Bus', stopId: 'demo-stop', eta: now + 20 * 60, delay: 0, tripRelationship: 'CANCELED', stopRelationship: 'SCHEDULED', vehicleId: '' }
      ]
    };
    await store.setJSON(CACHE_KEY, demo);
    return { ...demo, skipped: false };
  }

  assertEnvironment();
  const interval = await respectNtaInterval(store);
  if (interval.skipped) return { ...interval.previous, skipped: true };

  const requestedAt = new Date().toISOString();
  const headerName = process.env.NTA_API_HEADER || 'x-api-key';
  const response = await fetch(process.env.NTA_TRIP_UPDATES_URL, {
    headers: {
      [headerName]: process.env.NTA_API_KEY,
      accept: 'application/x-protobuf, application/octet-stream'
    },
    signal: AbortSignal.timeout(25_000)
  });

  if (!response.ok) throw new Error(`NTA request failed with ${response.status}.`);
  const buffer = await response.arrayBuffer();
  const normalized = { requestedAt, ...decodeTripUpdates(buffer, index) };

  await store.setJSON(CACHE_KEY, normalized, {
    metadata: {
      requestedAt,
      generatedAt: normalized.generatedAt,
      count: normalized.arrivals.length
    }
  });
  return { ...normalized, skipped: false };
}

export default async () => {
  try {
    const result = await refreshFeed();
    if (result.skipped) {
      console.log('Skipped duplicate refresh to respect the NTA 60-second token limit.');
      return;
    }
    console.log(`Cached ${result.arrivals.length} arrival records at ${result.generatedAt}.`);
    if (result.diagnostics) {
      console.log(`Feed diagnostics: ${JSON.stringify(result.diagnostics)}`);
    }
  } catch (error) {
    console.error('Realtime refresh failed:', error);
    throw error;
  }
};

export const config = {
  schedule: '* * * * *'
};
