# Security design

This project treats the browser and every public request as untrusted.

## Passenger authentication

Passengers do **not** need to create an account. On the first lookup, Cloudflare Turnstile verifies that the request comes from a genuine browser. The verification token is validated only on the Netlify backend.

The backend additionally checks:

- the Turnstile action is exactly `passenger_session`;
- the Turnstile hostname matches the hostname serving the app;
- the token is submitted from the same origin;
- the session endpoint has not exceeded its IP/domain rate limit.

After successful verification, the backend issues a short-lived signed JWT session in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. JavaScript cannot read this cookie. The protected arrivals endpoint rejects missing, expired, modified, or incorrectly scoped sessions.

This is service authentication and anti-abuse protection, not personal passenger identification. No names, emails, passwords, or passenger profiles are collected.

## Protection layers

1. **The NTA API key exists only in Netlify environment variables.** It is used only by the scheduled `refresh-feed` function and is never returned to the browser.
2. **Turnstile is validated server-side.** Client-side success alone is never trusted.
3. **Signed short-lived sessions protect the arrivals endpoint.** The JWT uses HS256, an issuer, audience, expiry, unique subject, unique token ID, and a narrow `arrivals:read` scope.
4. **Same-origin and Fetch Metadata checks block cross-site API use.**
5. **Netlify rate limits authentication and arrival requests by IP and domain.**
6. **NTA traffic is isolated.** A scheduled backend function writes one shared Netlify Blobs cache; passenger searches never contact NTA directly.
7. **A 61-second server guard protects the NTA subscription limit.** Duplicate or early scheduled invocations wait briefly or skip instead of calling NTA too soon.
8. **Inputs are allow-listed.** Stop numbers are numeric and route values accept only short alphanumeric identifiers.
9. **The PWA service worker never caches API or third-party authentication requests.**
10. **Security headers are set globally.** CSP, HSTS, clickjacking protection, MIME sniffing protection, resource isolation, restrictive permissions, and referrer controls are enabled.
11. **No personal passenger data is stored.** The session contains random identifiers only and expires automatically.

## Production rules

- Generate a unique `APP_SESSION_SECRET` of at least 32 characters.
- Never set `AUTH_MODE=off` on a deployed site. The code also refuses that bypass in production, branch deploys, and deploy previews.
- Never commit `.env`, NTA keys, Turnstile secrets, or session secrets to GitHub.
- Scope NTA and Turnstile secrets to **Functions** in Netlify; only the public Turnstile site key needs **Builds** scope.
- Restrict the Turnstile widget to the final Netlify and custom domains.
- Use a private GitHub repository while the project is under development.
- Enable two-factor authentication on GitHub, Netlify, Cloudflare, and the NTA developer account.
- Rotate the NTA secondary key first, deploy it, verify it, and then rotate the primary key.
- Review function logs for repeated 401, 403, 429, and refresh failures.
