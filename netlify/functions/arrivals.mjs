import { getStore } from '@netlify/blobs';
import index from './data/gtfs-index.json' with { type: 'json' };
import { filterArrivals, scheduledArrivalsForStops } from './lib/gtfs.mjs';
import { errorResponse, json, requireSession, verifySameOrigin } from './lib/security.mjs';
import { refreshFeed } from './refresh-feed.mjs';

const STOP_PATTERN = /^\d{1,8}$/;
const ROUTE_PATTERN = /^[A-Za-z0-9-]{0,8}$/;

async function readCache() {
  const store = getStore({ name: 'nta-realtime-cache', consistency: 'strong' });
  let cache = await store.get('trip-updates', { type: 'json' });

  if (!cache && process.env.DEMO_MODE === 'true') {
    cache = await refreshFeed();
  }
  return cache;
}

function combinedArrivals(cache, stopIds, routeFilter, limit) {
  const wantedRoute = String(routeFilter || '').trim().toUpperCase();
  const scheduled = scheduledArrivalsForStops(index, stopIds)
    .filter((item) => !wantedRoute || String(item.route).toUpperCase() === wantedRoute);
  const realtime = filterArrivals(cache, stopIds, routeFilter, 250);
  const combined = new Map();

  for (const item of scheduled) combined.set(`${item.tripId}|${item.stopId}`, item);
  for (const item of realtime) combined.set(`${item.tripId}|${item.stopId}`, item);

  return [...combined.values()]
    .sort((a, b) => a.eta - b.eta)
    .slice(0, limit);
}

export default async (request) => {
  try {
    if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
    verifySameOrigin(request);
    await requireSession(request);

    const url = new URL(request.url);
    const stopCode = (url.searchParams.get('stop') || '').trim();
    const route = (url.searchParams.get('route') || '').trim();

    if (!STOP_PATTERN.test(stopCode)) {
      return json({ ok: false, error: 'Enter a valid numeric bus stop number.' }, 400);
    }
    if (!ROUTE_PATTERN.test(route)) {
      return json({ ok: false, error: 'The route number is invalid.' }, 400);
    }

    const stop = index.stopsByCode[stopCode];
    if (!stop) {
      return json({ ok: false, error: 'That stop number is not in the current NTA schedule.' }, 404);
    }

    const cache = await readCache();
    if (!cache) {
      return json({ ok: false, error: 'Live data is starting. Try again after the next one-minute refresh.' }, 503);
    }

    const cacheAgeSeconds = Math.floor((Date.now() - Date.parse(cache.generatedAt)) / 1000);
    if (!Number.isFinite(cacheAgeSeconds) || cacheAgeSeconds > 180) {
      return json({ ok: false, error: 'Live data is temporarily stale. Please try again shortly.' }, 503);
    }

    const arrivals = combinedArrivals(cache, stop.ids, route, route ? 8 : 24);
    const routes = [...new Set(combinedArrivals(cache, stop.ids, '', 250).map((item) => item.route))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return json({
      ok: true,
      stop: { code: stopCode, name: stop.name },
      route: route || null,
      routes,
      arrivals,
      refreshedAt: cache.generatedAt,
      cacheAgeSeconds
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = {
  path: '/api/arrivals',
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip', 'domain'],
    windowSize: 60,
    windowLimit: 30
  }
};
