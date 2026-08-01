import { getStore } from '@netlify/blobs';
import index from './data/gtfs-index.json' with { type: 'json' };
import { filterArrivals, reconcileArrivals, scheduledArrivalsForStops } from './lib/gtfs.mjs';
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
  return reconcileArrivals(scheduled, realtime, { limit });
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

    let cache = await readCache();
    let cacheAgeSeconds = cache ? Math.floor((Date.now() - Date.parse(cache.generatedAt)) / 1000) : Infinity;

    // Self-heal: the every-minute background refresh can occasionally miss a beat
    // (scheduled functions aren't guaranteed to fire exactly on time). Rather than
    // show the user a "stale" error, refresh the feed on the spot when the cache is
    // missing or older than 180s, then use the fresh data. The NTA 60s interval
    // guard inside refreshFeed prevents this from hammering the feed.
    if (!cache || !Number.isFinite(cacheAgeSeconds) || cacheAgeSeconds > 180) {
      try {
        const fresh = await refreshFeed();
        if (fresh && fresh.generatedAt) {
          cache = fresh;
          cacheAgeSeconds = Math.floor((Date.now() - Date.parse(cache.generatedAt)) / 1000);
        }
      } catch (refreshError) {
        console.error('Inline refresh failed:', refreshError && refreshError.message);
      }
    }

    if (!cache) {
      return json({ ok: false, error: 'Live data is starting. Try again in a moment.' }, 503);
    }
    // Final safety net: only give up if, even after refreshing, data is very old.
    if (!Number.isFinite(cacheAgeSeconds) || cacheAgeSeconds > 300) {
      return json({ ok: false, error: 'Live data is temporarily unavailable. Please try again shortly.' }, 503);
    }

    const result = combinedArrivals(cache, stop.ids, route, route ? 8 : 24);
    const allRoutesResult = combinedArrivals(cache, stop.ids, '', 250);
    const routes = [...new Set(allRoutesResult.arrivals.map((item) => item.route))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (result.diagnostics.unmatchedScheduledCount || result.diagnostics.unmatchedRealtimeCount) {
      console.info('Arrival reconciliation diagnostics', {
        stopCode, route: route || 'ALL', ...result.diagnostics
      });
    }

    return json({
      ok: true,
      stop: { code: stopCode, name: stop.name },
      route: route || null,
      routes,
      arrivals: result.arrivals,
      diagnostics: result.diagnostics,
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
