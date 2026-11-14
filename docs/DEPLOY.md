# Deploying SPHEREx Blink

The site has two parts:

- **Website** (React, built to static files in `frontend/dist`)
- **API** (Python/FastAPI). It talks to NASA's archive, rotates and crops the
  images, and caches them. **It needs a host that runs Python** (or Docker).
  Pure static hosts cannot run it.

There are two ways to put it online. Pick one.

## Option A: one container for everything (recommended)

The `Dockerfile` builds the website and serves it from the same server as the
API, on one port. No CORS, one URL, one bill.

```bash
docker build -t spherex-blink .
docker run -p 8000:8000 -v spherex-cache:/data spherex-blink
# open http://localhost:8000
```

| Host | How | Notes |
| ---- | --- | ----- |
| **Render** | New > Blueprint, pick the repo. `render.yaml` is ready. | Starter plan includes a disk for the cache. Free plan sleeps after 15 min. |
| **Fly.io** | `fly launch --no-deploy`, `fly volumes create spherex_cache --size 5`, `fly deploy`. `fly.toml` is ready. | Scales to zero when idle, wakes on the next visit. |
| **Railway** | New project > Deploy from GitHub. It finds the Dockerfile. | Add a volume mounted at `/data`. |
| **Google Cloud Run** | `gcloud run deploy --source .` | No disk: the cache is lost on restart (still works, just slower first loads). |
| **Azure / AWS** | Container Apps or App Runner, from the Dockerfile. | Same as Cloud Run for the cache. |

Give the container **at least 1 GB of memory** (Astropy and image resampling
need it) and, if the host allows, a **persistent disk at `/data`** so cutouts
downloaded from NASA survive restarts.

## Option B: website on a static host, API elsewhere

Use this if the team's credits are on Vercel, Netlify or Cloudflare. Those are
great for the website but **cannot run the Python API**, so the API still
goes on one of the hosts from Option A.

1. Deploy the API (the Docker image above) and note its URL, for example
   `https://spherex-blink-api.onrender.com`.
2. On the API host set `SPHEREX_CORS_ORIGINS` to the website's address, for
   example `https://spherex-blink.vercel.app`.
3. On the static host set `VITE_API_BASE` to the API URL from step 1, then
   build:

| Host | Setup |
| ---- | ----- |
| **Vercel** | Import the repo. `vercel.json` sets the build. Add `VITE_API_BASE` under Settings > Environment Variables. |
| **Netlify** | Import the repo. `netlify.toml` sets the build. Add `VITE_API_BASE` under Site settings > Environment variables. |
| **Cloudflare Pages** | Root directory `frontend`, build command `npm run build`, output `dist`, env var `VITE_API_BASE`. |

## Settings

Every setting is an environment variable and all are optional. The full list
with explanations is in [`.env.example`](../.env.example).

| Variable | Where | What it does |
| -------- | ----- | ------------ |
| `PORT` | API | Port to listen on (hosts usually set it) |
| `SPHEREX_CACHE_DIR` | API | Cache folder, put it on a persistent disk |
| `SPHEREX_SEARCH_TTL` | API | Seconds before asking NASA again for new observations (default 3600) |
| `SPHEREX_CORS_ORIGINS` | API | Allowed website origins when hosted separately |
| `SENTRY_DSN` | API | Turns on server error reporting |
| `VITE_API_BASE` | Website build | API address when hosted separately |
| `VITE_SENTRY_DSN` | Website build | Turns on browser error reporting |

`VITE_*` values are baked in when the website is built, so rebuild after
changing them. With Docker pass them as build args:
`docker build --build-arg VITE_SENTRY_DSN=... -t spherex-blink .`

## Error reporting (Sentry)

1. Create a project at sentry.io (a "React" project for the browser and a
   "FastAPI" project for the API, or one project for both).
2. Copy its DSN into `SENTRY_DSN` (API, at run time) and `VITE_SENTRY_DSN`
   (website, at build time).
3. Redeploy. With no DSN set, nothing is sent and the SDK is not even loaded in
   the browser.

Cancelled image downloads (they happen every time someone moves the view) are
filtered out so they don't show up as errors.

## Checks after deploying

- `https://<your-site>/api/health` returns `{"ok": true}`
- The home page loads WISE 0855 and starts blinking within about 20 seconds
- `https://<your-site>/docs` shows the API documentation

## Making the demo fast

The first visit to a sky position downloads every cutout from NASA (around 15
to 20 seconds). After that it comes from the cache. Before a demo, open each
test target once on the deployed site so the cache is warm.
