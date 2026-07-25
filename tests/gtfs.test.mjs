import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEventClockCorrection,
  detectWholeHourClockCorrection,
  filterArrivals,
  reconcileArrivals,
  scheduledArrivalsForStops,
  statusFor,
  toNumber
} from '../netlify/functions/lib/gtfs.mjs';

test('toNumber supports common protobuf representations', () => {
  assert.equal(toNumber(123), 123);
  assert.equal(toNumber('456'), 456);
  assert.equal(toNumber({ low: 10, high: 0 }), 10);
});

test('status labels delays and cancellations', () => {
  assert.equal(statusFor({ delay: 0, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED' }), 'On time');
  assert.equal(statusFor({ delay: 240, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED' }), 'Delayed');
  assert.equal(statusFor({ delay: 0, tripRelationship: 'CANCELED', stopRelationship: 'SCHEDULED' }), 'Cancelled');
});

test('corrects only a clear whole-hour feed clock skew', () => {
  const now = 1_750_000_000;
  assert.equal(detectWholeHourClockCorrection(now + 3600, now), -3600);
  assert.equal(detectWholeHourClockCorrection(now - 3600, now), 3600);
  assert.equal(detectWholeHourClockCorrection(now + 120, now), 0);
  assert.equal(detectWholeHourClockCorrection(now + 5400, now), 0);
});

test('corrects a whole-hour event skew relative to its scheduled time and delay', () => {
  const scheduledEta = 1_750_000_000;
  assert.equal(detectEventClockCorrection(scheduledEta + 3600, scheduledEta), -3600);
  assert.equal(detectEventClockCorrection(scheduledEta - 3600, scheduledEta), 3600);
  assert.equal(detectEventClockCorrection(scheduledEta + 8 * 60, scheduledEta), 0);
  assert.equal(detectEventClockCorrection(scheduledEta + 28 * 60, scheduledEta), 0);
});

test('filterArrivals sorts, filters by stop and route, and limits results', () => {
  const now = 2_000;
  const cache = {
    arrivals: [
      { tripId: 'b', stopId: 'stop-1', route: '7', eta: 2_600, delay: 0, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED' },
      { tripId: 'a', stopId: 'stop-1', route: 'E1', eta: 2_300, delay: 180, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED' },
      { tripId: 'c', stopId: 'stop-2', route: 'E1', eta: 2_100, delay: 0, tripRelationship: 'SCHEDULED', stopRelationship: 'SCHEDULED' }
    ]
  };
  const result = filterArrivals(cache, ['stop-1'], 'E1', 4, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].tripId, 'a');
  assert.equal(result[0].minutes, 5);
  assert.equal(result[0].status, 'Delayed');
});

test('scheduled fallback returns active Dublin service with a scheduled label', () => {
  const now = Date.parse('2026-07-20T11:00:00Z') / 1000; // 12:00 in Dublin, Monday.
  const index = {
    routes: {
      routeE1: { shortName: 'E1', longName: '', agencyName: 'Dublin Bus' }
    },
    trips: {
      tripE1: { routeId: 'routeE1', headsign: 'Ballywaltrim', serviceId: 'weekday', scheduleIndex: 0 }
    },
    tripIdsByScheduleIndex: ['tripE1'],
    scheduledStopTimesByStop: {
      stop759: [0, 12, 12 * 3600 + 10 * 60]
    },
    services: {
      weekday: ['20260101', '20261231', 31]
    },
    serviceExceptions: {}
  };

  const arrivals = scheduledArrivalsForStops(index, ['stop759'], now);
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].route, 'E1');
  assert.equal(arrivals[0].destination, 'Ballywaltrim');
  assert.equal(arrivals[0].minutes, undefined);
  assert.equal(arrivals[0].status, 'Scheduled');
  assert.equal(arrivals[0].displayMode, 'clock');
  assert.equal(arrivals[0].realtime, false);
});

test('reconciliation replaces a scheduled trip with its exact realtime update', () => {
  const scheduled = [{ tripId: 'static-trip', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '0', eta: 10_000, source: 'scheduled' }];
  const realtime = [{ tripId: 'static-trip', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '0', eta: 10_240, source: 'realtime', minutes: 4 }];
  const result = reconcileArrivals(scheduled, realtime);
  assert.deepEqual(result.arrivals, realtime);
  assert.equal(result.diagnostics.matchedCount, 1);
  assert.equal(result.diagnostics.unmatchedScheduledCount, 0);
});

test('reconciliation tolerates changed trip IDs using route, stop, direction, destination, and time', () => {
  const scheduled = [{ tripId: 'static-2026', stopId: 'stop-773', route: 'E1', destination: 'Northwood via City Centre', directionId: '0', eta: 20_000, source: 'scheduled' }];
  const realtime = [{ tripId: 'realtime-4711', stopId: 'stop-773', route: 'e1', destination: 'Northwood', directionId: '0', eta: 20_360, source: 'realtime', minutes: 6 }];
  const result = reconcileArrivals(scheduled, realtime, { toleranceSeconds: 600 });
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].source, 'realtime');
  assert.equal(result.diagnostics.matchedCount, 1);
});

test('reconciliation keeps timetable-only rows clearly scheduled and reports unmatched records', () => {
  const scheduled = [{ tripId: 'scheduled-e1', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '0', eta: 30_000, source: 'scheduled', status: 'Scheduled', displayMode: 'clock', realtime: false }];
  const realtime = [{ tripId: 'live-39a', stopId: 'stop-773', route: '39A', destination: 'Ongar', directionId: '1', eta: 29_900, source: 'realtime', displayMode: 'countdown', realtime: true, minutes: 2 }];
  const result = reconcileArrivals(scheduled, realtime);
  assert.equal(result.arrivals.length, 2);
  assert.equal(result.arrivals[1].source, 'scheduled');
  assert.equal(result.arrivals[1].minutes, undefined);
  assert.equal(result.diagnostics.unmatchedScheduledCount, 1);
  assert.equal(result.diagnostics.unmatchedRealtimeCount, 1);
  assert.equal(result.diagnostics.unmatchedScheduled[0].route, 'E1');
  assert.equal(result.diagnostics.unmatchedRealtime[0].route, '39A');
});

test('reconciliation does not match the wrong direction or a distant scheduled time', () => {
  const scheduled = [{ tripId: 'scheduled-e1', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '0', eta: 40_000, source: 'scheduled' }];
  const wrongDirection = [{ tripId: 'different-live-id', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '1', eta: 40_120, source: 'realtime' }];
  const tooFarAway = [{ tripId: 'different-live-id', stopId: 'stop-773', route: 'E1', destination: 'Northwood', directionId: '0', eta: 42_000, source: 'realtime' }];
  assert.equal(reconcileArrivals(scheduled, wrongDirection).arrivals.length, 2);
  assert.equal(reconcileArrivals(scheduled, tooFarAway, { toleranceSeconds: 600 }).arrivals.length, 2);
});
