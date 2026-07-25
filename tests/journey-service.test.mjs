import test from 'node:test';
import assert from 'node:assert/strict';
import journeyPlanHandler from '../netlify/functions/journey-plan.mjs';

function request(body, headers = {}) {
  return new Request('https://arrivo.example/api/journey-plan', {
    method: 'POST',
    headers: {
      origin: 'https://arrivo.example',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test('journey service returns controlled estimates through a provider boundary', async () => {
  const response = await journeyPlanHandler(request({
    origin: 'Ballyogan Road',
    destination: 'Blanchardstown Shopping Centre',
    preference: 'fastest'
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.provider, 'arrivogo-controlled-estimates');
  assert.equal(result.liveRouting, false);
  assert.equal(result.journey.knownJourney, true);
});

test('journey service rejects cross-site requests', async () => {
  const response = await journeyPlanHandler(request(
    { origin: 'Dundrum', destination: 'Heuston Station' },
    { 'sec-fetch-site': 'cross-site' }
  ));
  assert.equal(response.status, 403);
});

test('journey service validates endpoint length and characters', async () => {
  const response = await journeyPlanHandler(request({
    origin: 'A'.repeat(121),
    destination: 'Heuston Station'
  }));
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.match(result.error, /starting point/i);
});

test('journey service only accepts JSON POST requests', async () => {
  const getResponse = await journeyPlanHandler(new Request('https://arrivo.example/api/journey-plan'));
  assert.equal(getResponse.status, 405);

  const textResponse = await journeyPlanHandler(new Request('https://arrivo.example/api/journey-plan', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'Dundrum'
  }));
  assert.equal(textResponse.status, 415);
});
