# Dublin Bus Live Board

A secure, mobile-first passenger app that shows upcoming Dublin Bus services from the number printed on a stop pole. The interface uses navy, yellow, green and white, with a 1970s airport split-flap-inspired arrival display.

## Passenger flow

1. Enter the stop number.
2. Complete a quiet browser verification when a new session begins.
3. See all routes with a live arrival at that stop.
4. Tap one route to show its next four buses.
5. The board refreshes every 60 seconds and displays On time, Delayed, Early or Cancelled when those statuses exist in the feed.

## Architecture

- **Frontend:** Vite, responsive HTML/CSS/JavaScript and installable PWA shell.
- **Authentication:** Cloudflare Turnstile server validation plus a signed, short-lived HttpOnly session cookie.
- **Backend:** Netlify Functions.
- **Live cache:** Netlify Blobs shared across all passenger requests.
- **Realtime source:** NTA GTFS-Realtime `TripUpdates`.
- **Stop/route index:** generated at build time from the matching NTA static GTFS ZIP.
- **Source control:** GitHub.
- **Hosting:** Netlify.

## Why the backend is required

GitHub Pages alone would expose the NTA key because its code runs entirely in the passenger's browser. In this project, only the scheduled Netlify function knows the NTA key. Passenger phones read a filtered cached response from an authenticated endpoint.

The NTA fair-usage rule limits each GTFS-Realtime token to one call every 60 seconds. This project therefore fetches the feed centrally, adds a 61-second safety guard, and serves all passengers from one shared cache.

## Why the static GTFS build step matters

The number printed on a bus stop pole is a public `stop_code`. The realtime feed uses internal stop, trip and route IDs. The build script downloads the matching NTA schedule and creates the mappings needed to connect the public stop number to realtime arrivals. By default, the build filters for the `Bus Átha Cliath` agency.

## Commands

```bash
npm install
npm test
npm run dev
npm run build
```

For a UI-only demo build that keeps the included sample index:

```bash
npm run build:demo
```

## Important files

- `START-HERE.md` — which folder goes to GitHub, Netlify, and environment variables.
- `.env.example` — every required setting, with placeholders only.
- `DEPLOYMENT.md` — exact GitHub, Turnstile, and Netlify steps.
- `SECURITY.md` — authentication and protection design.
- `netlify/functions/refresh-feed.mjs` — the only function that calls NTA.
- `netlify/functions/arrivals.mjs` — authenticated passenger query.
- `scripts/build-gtfs-index.mjs` — creates the Dublin Bus stop/route/trip lookup index.

## First demo

Use the safe demo settings in `DEPLOYMENT.md`, run `npm run dev`, and search for stop **9999**. The demo includes E1, 7 and 46A arrivals, including delayed and cancelled examples.

## Public-launch note

This is an unofficial prototype and is not affiliated with Dublin Bus or the National Transport Authority. It includes the required NTA data attribution and “as is” disclaimer. Confirm branding, licensing, accessibility, privacy, and operational requirements before a wide public launch.
