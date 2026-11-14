# Deploying

The site is static. The only thing a host must do besides serving files is
forward `/irsa/*` to `https://irsa.ipac.caltech.edu/*`, because IRSA does not
send CORS headers and browsers block direct calls from other sites.

| Host | What to do |
| --- | --- |
| Netlify | Import the repo. `netlify.toml` already has the build and the rewrite. |
| Vercel | Import the repo. `vercel.json` already has the build and the rewrite. |
| Cloudflare Pages | Build command `cd frontend && npm ci && npm run build`, output `frontend/dist`, and set `VITE_IRSA_BASE` to a Worker from `proxy/cloudflare-worker.js`. |
| GitHub Pages | Same as Cloudflare Pages: deploy the Worker, build with `VITE_IRSA_BASE`, publish `frontend/dist`. |

Optional: set `VITE_SENTRY_DSN` at build time to report browser errors to Sentry.

Notes
- IRSA answers "503 Server busy" above about four parallel requests per client,
  so the site downloads four cutouts at a time and retries with backoff.
- Each cutout file ends with a ~4 MB PSF table the viewer does not need. The
  browser stops reading after the image planes (a few kB), and closing the
  connection also frees IRSA.
