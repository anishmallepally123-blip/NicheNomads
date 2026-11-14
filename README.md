# SPHEREx Blink

A web tool for the NASA Space Apps challenge **Planet X and SPHEREx**.

Type a sky position (RA/Dec) and the site shows every public SPHEREx image of
that patch as a short movie. Stars stay still. Anything that moves from frame
to frame could be a nearby object, which is exactly how you would look for a
new planet or brown dwarf in our Sun's neighbourhood.

Images come live from NASA's archive (IRSA), so new SPHEREx observations show
up on their own.

## Run it

You need [Node.js 18+](https://nodejs.org) and [Python 3.10+](https://www.python.org/downloads/).

```bash
npm run setup   # once: installs everything
npm run dev     # starts the site
```

Then open <http://localhost:5173>. The first load of a new sky position takes
about 20 seconds while images download from NASA. After that it is cached.

Other commands:

| Command         | What it does                                              |
| --------------- | --------------------------------------------------------- |
| `npm run test`  | Runs the backend tests and the frontend type check        |
| `npm run build` | Builds the frontend for production                        |
| `npm run start` | Runs one server on port 8000 with the site and the API    |

## Put it online

`docker build -t spherex-blink . && docker run -p 8000:8000 spherex-blink`
gives one server with the site and the API. Ready-made configs for Render,
Fly.io, Vercel and Netlify, plus Sentry error reporting, are explained in
[docs/DEPLOY.md](docs/DEPLOY.md).

## Using it

- Pick a **test target** (WISE 0855, Barnard's Star, Epsilon Indi B, RW Aurigae,
  R Draconis) or type coordinates such as `133.7951 -7.2451` or
  `08h55m10.8s -07d14m42s`.
- **Play / Pause**, change the **speed**, or step one frame at a time
  (space bar and arrow keys work too).
- **Scroll** to zoom, **drag** to pan, **double-click** to re-centre on a new spot.
- Choose the **band** (SPHEREx has six detectors covering 0.75 to 5 microns)
  and the **field of view**.
- The address bar always describes the current view, so you can share it:
  `/?ra=133.795129&dec=-7.245147&fov=10&band=6`. Add `&embed=1` for a bare
  viewer to put in an iframe.

## How the code is organised

```
backend/app/
  data_access.py   talks to NASA IRSA (find images, download cutouts, cache)
  cutouts.py       rotates each image to north-up so frames line up
  render.py        turns image data into a PNG
  targets.py       test targets and coordinate parsing
  api.py           the web API
frontend/src/
  api/client.ts    calls the backend
  state/           URL <-> app state
  viewer/          the blink player (canvas, playback, controls)
  components/      search box, target picker, status bar
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and
where to add new features.

## Data credit

SPHEREx data: NASA/JPL-Caltech, served by the NASA/IPAC Infrared Science
Archive (IRSA).
