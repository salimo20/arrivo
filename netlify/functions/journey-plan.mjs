import { planJourney } from '../../src/journey-planner.js';
import { errorResponse, json, verifySameOrigin } from './lib/security.mjs';

const PREFERENCES = new Set(['fastest', 'cheapest', 'accessible', 'walking']);
const PLACE_PATTERN = /^[\p{L}\p{N}\s,'’.\-/()]{2,120}$/u;

function validatePlace(value, label) {
  const place = String(value || '').trim();
  if (!PLACE_PATTERN.test(place)) {
    const error = new Error(`Enter a valid ${label}.`);
    error.status = 400;
    throw error;
  }
  return place;
}

export default async (request) => {
  try {
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed.' }, 405, { allow: 'POST' });
    }
    verifySameOrigin(request);

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json({ ok: false, error: 'Content type must be application/json.' }, 415);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ ok: false, error: 'Enter a valid journey request.' }, 400);
    }

    const origin = validatePlace(body.origin, 'starting point');
    const destination = validatePlace(body.destination, 'destination');
    const preference = PREFERENCES.has(body.preference) ? body.preference : 'fastest';
    const journey = planJourney({ origin, destination, preference });

    return json({
      ok: true,
      provider: 'arrivogo-controlled-estimates',
      liveRouting: false,
      journey
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = {
  path: '/api/journey-plan',
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip', 'domain'],
    windowSize: 60,
    windowLimit: 20
  }
};
