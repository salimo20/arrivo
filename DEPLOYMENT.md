# GitHub + Netlify deployment

## 1. Put the whole project on GitHub

1. Unzip `dublin-bus-live-board-secure.zip` on your Windows 11 laptop.
2. Open the unzipped `dublin-bus-live-board` folder in VS Code.
3. Create a new **private** GitHub repository.
4. In the VS Code terminal run:

```bash
git init
git add .
git commit -m "Initial secure passenger live board"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Do not upload separate frontend and backend ZIP files. GitHub receives the complete project folder.

## 2. Connect GitHub to Netlify

1. In Netlify choose **Add new project → Import an existing project**.
2. Choose GitHub and select the repository.
3. Netlify reads `netlify.toml`; normally no build fields need changing.
4. Add the environment variables below before the production deploy.

## 3. Add environment variables in Netlify

Open **Project configuration → Environment variables** and add:

| Variable | Value | Scope |
|---|---|---|
| `NTA_API_KEY` | Your NTA primary or secondary key | Functions only |
| `NTA_TRIP_UPDATES_URL` | `https://api.nationaltransport.ie/gtfsr/v2/TripUpdates` | Functions only |
| `NTA_API_HEADER` | `x-api-key` | Functions only |
| `GTFS_STATIC_URL` | `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip` | Builds only |
| `APP_SESSION_SECRET` | Long random value | Functions only |
| `SESSION_TTL_MINUTES` | `30` | Functions only |
| `TURNSTILE_SECRET_KEY` | Cloudflare private secret | Functions only |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare public site key | Builds only |
| `ALLOWED_AGENCY_NAMES` | `Bus Átha Cliath` | Builds only |
| `AUTH_MODE` | `turnstile` | Functions only |
| `DEMO_MODE` | `false` | Functions only |
| `VITE_DEMO_MODE` | `false` | Builds only |

Generate `APP_SESSION_SECRET` on Windows PowerShell:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Copy the generated result directly into Netlify. Do not put it in GitHub.

## 4. Create Cloudflare Turnstile keys

1. Create a free Turnstile widget in the Cloudflare dashboard.
2. Use **Managed** mode.
3. Add the Netlify production domain, for example `your-project.netlify.app`.
4. Add your custom domain later, when you have one.
5. Copy the public **site key** to `VITE_TURNSTILE_SITE_KEY`.
6. Copy the private **secret key** to `TURNSTILE_SECRET_KEY`.

The app uses the Turnstile action `passenger_session` and verifies the exact hostname on the server. No Cloudflare action setting is required in the dashboard.

## 5. Deploy and prime the cache

1. Trigger **Deploy project**.
2. Check the build log. It should create the GTFS index and report Dublin Bus routes and trips.
3. Open **Functions** and confirm `refresh-feed` has the **Scheduled** badge.
4. Select `refresh-feed` and use **Run now** once, or allow the next scheduled minute to run.
5. Test a real stop number.

Passenger searches do not call NTA. Only `refresh-feed` does, and the code enforces at least 61 seconds between NTA requests.

## 6. Safe local demo before using live keys

Create a local `.env` file only on your laptop:

```env
AUTH_MODE=off
DEMO_MODE=true
VITE_DEMO_MODE=true
SKIP_GTFS_DOWNLOAD=true
APP_SESSION_SECRET=local-development-secret-change-me-1234567890
```

Then run:

```bash
npm install
npm run dev
```

Use demo stop **9999**. `AUTH_MODE=off` is allowed only locally and is rejected automatically on Netlify production, branch, and deploy-preview contexts.

## 7. Recommended account protection

Enable two-factor authentication on GitHub, Netlify, Cloudflare, and the NTA developer portal. Keep the repository private during testing and never paste the NTA key into chat screenshots, HTML, JavaScript, or GitHub commits.
