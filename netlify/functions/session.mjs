import {
  clearSessionCookie,
  errorResponse,
  getSession,
  issueSession,
  json,
  makeSessionCookie,
  verifySameOrigin,
  verifyTurnstile
} from './lib/security.mjs';

function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export default async (request, context) => {
  try {
    verifySameOrigin(request);

    if (request.method === 'GET') {
      const session = await getSession(request);
      return json({ ok: true, authenticated: Boolean(session) });
    }

    if (request.method === 'DELETE') {
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(isHttps(request)) });
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json({ ok: false, error: 'Content type must be application/json.' }, 415);
    }

    const body = await request.json().catch(() => ({}));
    const expectedHostname = new URL(request.url).hostname;
    const verified = await verifyTurnstile(body.turnstileToken, context?.ip, expectedHostname);
    if (!verified) return json({ ok: false, error: 'Security verification failed.' }, 401);

    const { token, ttlSeconds } = await issueSession();
    return json(
      { ok: true, authenticated: true, expiresIn: ttlSeconds },
      200,
      { 'set-cookie': makeSessionCookie(token, ttlSeconds, isHttps(request)) }
    );
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = {
  path: '/api/session',
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip', 'domain'],
    windowSize: 60,
    windowLimit: 10
  }
};
