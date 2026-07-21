# Start here, Salim

This ZIP is one complete secure full-stack project. You do not upload separate frontend and backend ZIP files.

## What goes where

- **GitHub:** upload the whole unzipped `dublin-bus-live-board` folder.
- **Netlify:** connect Netlify to that GitHub repository.
- **NTA key:** add it only in Netlify Environment variables as `NTA_API_KEY`, scoped to Functions.
- **Authentication:** add the Cloudflare Turnstile public site key, private secret, and a random app session secret in Netlify.
- **Never place any secret inside `src`, `public`, HTML, or GitHub code.**

## Folder guide

- `src/` — passenger screen and airport-style flip design.
- `public/` — installable app icon, manifest and safe offline shell.
- `netlify/functions/` — protected backend, browser authentication, NTA refresh and shared cache.
- `scripts/` — downloads and converts the current NTA static schedule.
- `tests/` — automatic GTFS and authentication checks.
- `DEPLOYMENT.md` — exact deployment steps.
- `SECURITY.md` — how the app and API key are protected.

## First safe test

Follow **Safe local demo** in `DEPLOYMENT.md` and enter stop **9999**. After the interface works, add your real NTA and Turnstile keys in Netlify and deploy production mode.
