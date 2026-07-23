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

const dublinParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function dublinOffsetMilliseconds(epochMilliseconds) {
  const parts = Object.fromEntries(
    dublinParts.formatToParts(new Date(epochMilliseconds))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - epochMilliseconds;
}

function scheduledEpochSeconds(startDate, secondsAfterMidnight) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(startDate || ''));
  if (!match || !Number.isFinite(secondsAfterMidnight)) return null;
  const wallClockUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + secondsAfterMidnight * 1000;
  let epoch = wallClockUtc - dublinOffsetMilliseconds(wallClockUtc);
  epoch = wallClockUtc - dublinOffsetMilliseconds(epoch);
  return Math.floor(epoch / 1000);
}

function scheduledTimeFor(index, tripId, stopUpdate) {
  const tripIndex = index.trips?.[tripId]?.scheduleIndex;
  const stopId = String(stopUpdate.stopId || '');
  const byStop = index.scheduledStopTimesByStop?.[stopId];
  const sequence = toNumber(stopUpdate.stopSequence);
  if (tripIndex != null && byStop) {
    for (let position = 0; position < byStop.length; position += 3) {
      if (byStop[position] !== tripIndex) continue;
      if (sequence == null || byStop[position + 1] === sequence) return byStop[position + 2];
    }
  }

  // Backwards compatibility for the bundled development index.
  const tripTimes = index.scheduledStopTimes?.[tripId];
  if (!tripTimes) return null;
  for (let indexPosition = 0; indexPosition < tripTimes.length; indexPosition += 3) {
    if (sequence != null && tripTimes[indexPosition] === sequence) return tripTimes[indexPosition + 2];
    if (sequence == null && stopId && tripTimes[indexPosition + 1] === stopId) return tripTimes[indexPosition + 2];
  }
  return null;
}

function dateKeyFromParts(parts) {
  return `${String(parts.year).padStart(4, '0')}${String(parts.month).padStart(2, '0')}${String(parts.day).padStart(2, '0')}`;
}

function dublinDateParts(epochMilliseconds) {
  const values = Object.fromEntries(
    dublinParts.formatToParts(new Date(epochMilliseconds))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return { year: values.year, month: values.month, day: values.day };
}

function nearbyServiceDates(nowMilliseconds) {
  const current = dublinDateParts(nowMilliseconds);
  const anchor = Date.UTC(current.year, current.month - 1, current.day, 12);
  return [-1, 0, 1].map((offset) => {
    const date = new Date(anchor + offset * 86_400_000);
    const parts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    const weekdayIndex = (date.getUTCDay() + 6) % 7;
    return { dateKey: dateKeyFromParts(parts), weekdayIndex };
  });
}

function activeServicesForDate(index, dateKey, weekdayIndex) {
  const active = new Set();
  for (const [serviceId, definition] of Object.entries(index.services || {})) {
    const [startDate, endDate, weekdayMask] = definition;
    if (dateKey >= startDate && dateKey <= endDate && (weekdayMask & (1 << weekdayIndex))) {
      active.add(serviceId);
    }
  }
  const [added = [], removed = []] = index.serviceExceptions?.[dateKey] || [];
  added.forEach((serviceId) => active.add(serviceId));
  removed.forEach((serviceId) => active.delete(serviceId));
  return active;
}

export function scheduledArrivalsForStops(
  index,
  stopIds,
  nowSeconds = Math.floor(Date.now() / 1000),
  horizonSeconds = 3 * 60 * 60
) {
  if (!index.scheduledStopTimesByStop || !index.tripIdsByScheduleIndex) return [];
  const horizon = nowSeconds + horizonSeconds;
  const arrivals = [];

  for (const { dateKey, weekdayIndex } of nearbyServiceDates(nowSeconds * 1000)) {
    const activeServices = activeServicesForDate(index, dateKey, weekdayIndex);
    for (const stopId of stopIds) {
      const stopTimes = index.scheduledStopTimesByStop[stopId] || [];
      for (let position = 0; position < stopTimes.length; position += 3) {
        const tripId = index.tripIdsByScheduleIndex[stopTimes[position]];
        const trip = index.trips?.[tripId];
        if (!trip || !activeServices.has(trip.serviceId)) continue;
        const eta = scheduledEpochSeconds(dateKey, stopTimes[position + 2]);
        if (eta == null || eta < nowSeconds - 45 || eta > horizon) continue;
        const route = index.routes?.[trip.routeId];
        if (!route) continue;
        arrivals.push({
          tripId,
          routeId: trip.routeId,
          route: route.shortName || trip.routeId,
          destination: trip.headsign || route.longName || 'Destination unavailable',
          agencyName: route.agencyName || '',
          stopId,
          eta,
          delay: 0,
          tripRelationship: 'SCHEDULED',
          stopRelationship: 'SCHEDULED',
          vehicleId: '',
          source: 'scheduled',
          status: 'Scheduled',
          minutes: Math.max(0, Math.ceil((eta - nowSeconds) / 60))
        });
      }
    }
  }
  return arrivals.sort((a, b) => a.eta - b.eta);
}

export function detectWholeHourClockCorrection(feedTimestamp, nowSeconds = Math.floor(Date.now() / 1000)) {
  const timestamp = toNumber(feedTimestamp);
  if (timestamp == null) return 0;

  const skewSeconds = timestamp - nowSeconds;
  const wholeHours = Math.round(skewSeconds / 3600);
  if (wholeHours === 0 || Math.abs(wholeHours) > 2) return 0;

  const residualSeconds = Math.abs(skewSeconds - wholeHours * 3600);
  return residualSeconds <= 15 * 60 ? -wholeHours * 3600 : 0;
}

export function detectEventClockCorrection(eta, scheduledEta) {
  const realtime = toNumber(eta);
  const scheduled = toNumber(scheduledEta);
  if (realtime == null || scheduled == null) return 0;

  const skewSeconds = realtime - scheduled;
  const wholeHours = Math.round(skewSeconds / 3600);
  if (wholeHours === 0 || Math.abs(wholeHours) > 2) return 0;

  const residualSeconds = Math.abs(skewSeconds - wholeHours * 3600);
  return residualSeconds <= 15 * 60 ? -wholeHours * 3600 : 0;
}

export function decodeTripUpdates(buffer, index, nowSeconds = Math.floor(Date.now() / 1000)) {
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  const arrivals = [];
  const horizon = nowSeconds + 3 * 60 * 60;
  const feedTimestamp = toNumber(feed.header?.timestamp);
  const clockCorrectionSeconds = detectWholeHourClockCorrection(feedTimestamp, nowSeconds);
  const diagnostics = {
    entities: (feed.entity || []).length,
    tripUpdates: 0,
    missingTripDescriptor: 0,
    missingRouteId: 0,
    matchedRoutes: 0,
    unmatchedRoutes: 0,
    stopUpdates: 0,
    missingEta: 0,
    missingScheduledTime: 0,
    reconstructedEta: 0,
    outsideWindow: 0,
    accepted: 0,
    clockCorrectionSeconds
  };

  for (const entity of feed.entity || []) {
    const update = entity.tripUpdate;
    if (!update) continue;
    diagnostics.tripUpdates += 1;
    if (!update.trip) {
      diagnostics.missingTripDescriptor += 1;
      continue;
    }

    const tripId = update.trip.tripId || '';
    const tripMeta = index.trips[tripId] || {};
    const routeId = update.trip.routeId || tripMeta.routeId || '';
    if (!routeId) {
      diagnostics.missingRouteId += 1;
      continue;
    }
    const routeMeta = index.routes[routeId];
    if (!routeMeta) {
      diagnostics.unmatchedRoutes += 1;
      continue;
    }
    diagnostics.matchedRoutes += 1;
    const tripRelationship = tripRelationshipName(update.trip.scheduleRelationship);
    const vehicleId = update.vehicle?.label || update.vehicle?.id || '';

    for (const stopUpdate of update.stopTimeUpdate || []) {
      diagnostics.stopUpdates += 1;
      const arrivalTime = toNumber(stopUpdate.arrival?.time);
      const departureTime = toNumber(stopUpdate.departure?.time);
      const delay = toNumber(stopUpdate.arrival?.delay) ?? toNumber(stopUpdate.departure?.delay) ?? 0;
      const scheduledSeconds = scheduledTimeFor(index, tripId, stopUpdate);
      const scheduledEpoch = scheduledEpochSeconds(update.trip.startDate, scheduledSeconds);
      let eta = arrivalTime ?? departureTime;
      if (eta != null) {
        const eventCorrection = detectEventClockCorrection(eta, scheduledEpoch == null ? null : scheduledEpoch + delay);
        eta += eventCorrection || clockCorrectionSeconds;
        if (eventCorrection) diagnostics.correctedEventTimestamps = (diagnostics.correctedEventTimestamps || 0) + 1;
      }
      if (!eta) {
        if (scheduledEpoch != null) {
          eta = scheduledEpoch + delay;
          diagnostics.reconstructedEta += 1;
        } else {
          diagnostics.missingScheduledTime += 1;
        }
      }
      if (!eta) {
        diagnostics.missingEta += 1;
        continue;
      }
      if (eta < nowSeconds - 60 || eta > horizon) {
        diagnostics.outsideWindow += 1;
        continue;
      }

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
      diagnostics.accepted += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    feedTimestamp,
    clockCorrectionSeconds,
    arrivals,
    diagnostics
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
        source: 'realtime',
        status: statusFor(item),
        minutes: Math.max(0, Math.ceil((item.eta - nowSeconds) / 60))
      });
    }
  }

  return [...unique.values()].sort((a, b) => a.eta - b.eta).slice(0, limit);
}
