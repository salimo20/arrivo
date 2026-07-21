import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;

export function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low === 'number') return value.low + (value.high || 0) * 4294967296;
  return null;
}

function relationshipName(value) {
  const names = {
    0: 'SCHEDULED',
    1: 'SKIPPED',
    2: 'NO_DATA',
    3: 'UNSCHEDULED',
    5: 'REPLACEMENT',
    6: 'DUPLICATED',
    7: 'DELETED',
    8: 'CANCELED'
  };
  if (typeof value === 'string') return value;
  return names[value] || 'SCHEDULED';
}

function tripRelationshipName(value) {
  const names = {
    0: 'SCHEDULED',
    1: 'ADDED',
    2: 'UNSCHEDULED',
    3: 'CANCELED',
    5: 'REPLACEMENT',
    6: 'DUPLICATED',
    7: 'DELETED'
  };
  if (typeof value === 'string') return value;
  return names[value] || 'SCHEDULED';
}

export function decodeTripUpdates(buffer, index, nowSeconds = Math.floor(Date.now() / 1000)) {
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  const arrivals = [];
  const horizon = nowSeconds + 3 * 60 * 60;

  for (const entity of feed.entity || []) {
    const update = entity.tripUpdate;
    if (!update?.trip) continue;

    const tripId = update.trip.tripId || '';
    const tripMeta = index.trips[tripId] || {};
    const routeId = update.trip.routeId || tripMeta.routeId || '';
    const routeMeta = index.routes[routeId];
    if (!routeMeta) continue;
    const tripRelationship = tripRelationshipName(update.trip.scheduleRelationship);
    const vehicleId = update.vehicle?.label || update.vehicle?.id || '';

    for (const stopUpdate of update.stopTimeUpdate || []) {
      const arrivalTime = toNumber(stopUpdate.arrival?.time);
      const departureTime = toNumber(stopUpdate.departure?.time);
      const eta = arrivalTime ?? departureTime;
      if (!eta || eta < nowSeconds - 60 || eta > horizon) continue;

      const delay = toNumber(stopUpdate.arrival?.delay) ?? toNumber(stopUpdate.departure?.delay) ?? 0;
      const stopRelationship = relationshipName(stopUpdate.scheduleRelationship);

      arrivals.push({
        tripId,
        routeId,
        route: routeMeta.shortName || routeId || '—',
        destination: tripMeta.headsign || routeMeta.longName || 'Destination unavailable',
        agencyName: routeMeta.agencyName || '',
        stopId: stopUpdate.stopId || '',
        eta,
        delay,
        tripRelationship,
        stopRelationship,
        vehicleId
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    feedTimestamp: toNumber(feed.header?.timestamp),
    arrivals
  };
}

export function statusFor(arrival) {
  if (['CANCELED', 'DELETED'].includes(arrival.tripRelationship)) return 'Cancelled';
  if (arrival.stopRelationship === 'SKIPPED') return 'Cancelled';
  if (arrival.delay >= 180) return 'Delayed';
  if (arrival.delay <= -90) return 'Early';
  return 'On time';
}

export function filterArrivals(cache, stopIds, routeFilter, limit = 8, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ids = new Set(stopIds);
  const wantedRoute = String(routeFilter || '').trim().toUpperCase();
  const unique = new Map();

  for (const item of cache.arrivals || []) {
    if (!ids.has(item.stopId)) continue;
    if (item.eta < nowSeconds - 45) continue;
    if (wantedRoute && String(item.route).toUpperCase() !== wantedRoute) continue;

    const key = `${item.tripId}|${item.stopId}|${item.eta}`;
    if (!unique.has(key)) {
      unique.set(key, {
        ...item,
        status: statusFor(item),
        minutes: Math.max(0, Math.ceil((item.eta - nowSeconds) / 60))
      });
    }
  }

  return [...unique.values()].sort((a, b) => a.eta - b.eta).slice(0, limit);
}
