import test from 'node:test';
import assert from 'node:assert/strict';
import sessionHandler from '../netlify/functions/session.mjs';
import {
  getSession,
  issueSession,
  makeSessionCookie,
  requireSession,
  verifySameOrigin
} from '../netlify/functions/lib/security.mjs';

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
});

test('signed session can be read from an HttpOnly Strict cookie', async () => {
  process.env.APP_SESSION_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
  process.env.SESSION_TTL_MINUTES = '30';
  delete process.env.CONTEXT;

  const { token, ttlSeconds } = await issueSession();
  const cookie = makeSessionCookie(token, ttlSeconds, false);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /; Secure/);

  const request = new Request('http://localhost/api/arrivals', {
    headers: { cookie: cookie.split(';')[0] }
  });
  const payload = await getSession(request);
  assert.ok(payload);
  assert.deepEqual(payload.scope, ['arrivals:read']);
});

test('tampered session is rejected', async () => {
  process.env.APP_SESSION_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
  process.env.AUTH_MODE = 'turnstile';
  delete process.env.CONTEXT;

  const request = new Request('http://localhost/api/arrivals', {
    headers: { cookie: 'db_live_session=not-a-valid-token' }
  });
  await assert.rejects(() => requireSession(request), /Authentication required/);
});

test('local authentication bypass cannot be used in production', async () => {
  process.env.APP_SESSION_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
  process.env.AUTH_MODE = 'off';
  process.env.CONTEXT = 'production';

  const request = new Request('https://example.netlify.app/api/arrivals');
  await assert.rejects(() => requireSession(request), /Authentication required/);
});

test('cross-site requests are rejected using Fetch Metadata', () => {
  const request = new Request('https://example.netlify.app/api/session', {
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.throws(() => verifySameOrigin(request), /Cross-site request rejected/);
});

test('local session endpoint issues a cookie after the local demo verification', async () => {
  process.env.AUTH_MODE = 'off';
  process.env.APP_SESSION_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
  delete process.env.CONTEXT;

  const request = new Request('http://localhost/api/session', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ turnstileToken: 'local-dev-bypass' })
  });

  const response = await sessionHandler(request, { ip: '127.0.0.1' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') || '', /db_live_session=/);
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly/);
});
