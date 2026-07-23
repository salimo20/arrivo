import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWholeHourClockCorrection, filterArrivals, statusFor, toNumber } from '../netlify/functions/lib/gtfs.mjs';

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
