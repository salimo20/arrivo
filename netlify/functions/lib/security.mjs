import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

const COOKIE_NAME = 'db_live_session';
const ISSUER = 'dublin-bus-live-board';
const AUDIENCE = 'passenger-app';
const TURNSTILE_ACTION = 'passenger_session';
const DEPLOYED_CONTEXTS = new Set(['production', 'deploy-preview', 'branch-deploy']);

function isDeployed() {
  return DEPLOYED_CONTEXTS.has(process.env.CONTEXT || '');
}

function isLocalDevelopment() {
  return !isDeployed();
}

function getSessionSecret() {
  const value = process.env.APP_SESSION_SECRET;
  if (!value || value.length < 32) {
    if (isDeployed()) {
      throw new Error('APP_SESSION_SECRET must be at least 32 characters on deployed sites.');
    }
    return 'local-development-secret-change-me-1234567890';
  }
  return value;
}

function secretKey() {
  return new TextEncoder().encode(getSessionSecret());
}

function securityError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function verifySameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw securityError('Cross-site request rejected.');
  }

  const origin = request.headers.get('origin');
  if (!origin) return;

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) {
    throw securityError('Cross-origin request rejected.');
  }
}

export async function issueSession() {
  const ttlMinutes = Math.min(Math.max(Number(process.env.SESSION_TTL_MINUTES || 30), 5), 240);
  const token = await new SignJWT({ scope: ['arrivals:read'] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(randomUUID())
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(secretKey());

  return { token, ttlSeconds: ttlMinutes * 60 };
}

export function makeSessionCookie(token, ttlSeconds, secure = true) {
  const secureAttribute = secure ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}; Priority=High${secureAttribute}`;
}

export function clearSessionCookie(secure = true) {
  const secureAttribute = secure ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High${secureAttribute}`;
}

function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export async function getSession(request) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token || token.length > 4096) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5
    });
    return payload;
  } catch {
    return null;
  }
}

export async function requireSession(request) {
  const authMode = process.env.AUTH_MODE || 'turnstile';
  if (isLocalDevelopment() && authMode === 'off') {
    return { sub: 'local-dev', scope: ['arrivals:read'] };
  }

  const session = await getSession(request);
  if (!session || !Array.isArray(session.scope) || !session.scope.includes('arrivals:read')) {
    throw securityError('Authentication required.', 401);
  }
  return session;
}

export async function verifyTurnstile(token, remoteIp, expectedHostname) {
  const authMode = process.env.AUTH_MODE || 'turnstile';
  if (isLocalDevelopment() && authMode === 'off') return true;

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (isDeployed()) throw new Error('TURNSTILE_SECRET_KEY is missing.');
    return token === 'local-dev-bypass';
  }

  if (!token || typeof token !== 'string' || token.length > 2048) return false;

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: remoteIp || undefined,
        idempotency_key: randomUUID()
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) return false;
    const result = await response.json();
    if (result.success !== true) return false;
    if (result.action !== TURNSTILE_ACTION) return false;
    if (expectedHostname && result.hostname !== expectedHostname) return false;
    return true;
  } catch {
    return false;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      vary: 'Cookie',
      ...extraHeaders
    }
  });
}

export function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const safeMessage = status >= 500 ? 'The service is temporarily unavailable.' : error.message;
  if (status >= 500) console.error(error);
  return json({ ok: false, error: safeMessage }, status);
}
