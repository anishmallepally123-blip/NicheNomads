# Architecture

## The idea in one picture

```
Browser (React)                      Backend (FastAPI)                   NASA IRSA
---------------                      -----------------                   ---------
URL ?ra&dec&fov&band
   |
   v
GET /api/frames?ra&dec&band  ----->  data_access.search_frames()  -----> image search (SIA)
   <- list of exposures, by time

for each exposure:
GET /api/frames/{id}/image   ----->  data_access.fetch_cutout()   -----> FITS cutout
                                     cutouts.align_cutout()  (north up)
   <- PNG + wavelength headers       render.to_png()

canvas blinks through the PNGs
```

## Things worth knowing about SPHEREx

- Each exposure is a 3.5 degree image on one of six detectors (D1 to D6,
  0.75 to 5.0 microns), at 6.15 arcsec per pixel.
- SPHEREx has no filter wheel. A filter that changes across the detector
  means **every pixel sees a different wavelength**. So two exposures of the
  same star are usually at slightly different wavelengths. The file carries a
  lookup table for this (`WCS-WAVE`), and `cutouts.py` reads the wavelength at
  the view centre for every frame.
- Every exposure is rotated differently, so frames must be resampled onto a
  common grid before blinking. That is the job of `align_cutout()`.
- Each FITS file has extensions `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI` (model of
  the zodiacal light background, which we subtract), `EPSF`, `WCS-WAVE`.

## Backend modules (`backend/app`)

| File             | Job                                                                 | Talks to network? |
| ---------------- | ------------------------------------------------------------------- | ----------------- |
| `config.py`      | Settings, all overridable with environment variables                | no                |
| `data_access.py` | Find exposures covering a position, download cutouts, disk cache    | **yes, only here** |
| `cutouts.py`     | Align a cutout to a north-up grid, read wavelength and flag stats   | no                |
| `render.py`      | Stretch pixel values and encode a PNG                               | no                |
| `targets.py`     | Test targets, coordinate parsing                                    | no                |
| `api.py`         | HTTP routes, input validation                                       | no                |
| `main.py`        | Creates the app, CORS, serves the built frontend                    | no                |

### API

| Route                              | Returns                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `GET /api/targets`                 | The test targets                                                |
| `GET /api/resolve?q=`              | RA/Dec for a target name or a coordinate string                 |
| `GET /api/frames?ra&dec&band`      | Time-ordered exposures, per-band counts, newest observation     |
| `GET /api/frames/{id}/image?ra&dec&fov&size&zodi&stretch&format` | Aligned PNG (or `format=fits`). Headers: `X-Wavelength-Um`, `X-Bandwidth-Um`, `X-Coverage`, `X-Flagged-Fraction` |
| `GET /api/status`                  | Data source and the newest observation seen per IRSA collection |
| `POST /api/refresh`                | Clears cached searches                                          |

Interactive API docs are at <http://localhost:8000/docs> while the backend runs.

### How new data gets picked up

`search_frames()` asks IRSA for *all* SPHEREx images at a position (by
instrument, not by release name), so a new release needs no code change.
Search answers are cached for one hour (`SPHEREX_SEARCH_TTL`). The
"Check for new data" button passes `refresh=true` to skip the cache.
Downloaded cutouts are cached forever in `backend/.cache/` because a released
exposure never changes. Delete that folder any time to free space.

IRSA answers "503 Server busy" if we ask for too much at once, so downloads
are limited to 4 at a time and retried with a short wait.

## Frontend modules (`frontend/src`)

| File                         | Job                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| `state/urlState.ts`          | The URL is the source of truth: `ra`, `dec`, `fov`, `band`, `embed` |
| `api/client.ts`              | All backend calls and the data types                       |
| `viewer/useFrames.ts`        | Loads the frame list, then pictures, a few at a time       |
| `viewer/usePlayer.ts`        | Current frame, play/pause, speed                           |
| `viewer/BlinkCanvas.tsx`     | Canvas drawing, pan, zoom, marker, scale bar, compass      |
| `viewer/PlayerControls.tsx`  | Buttons, scrubber, frame info                              |
| `components/Controls.tsx`    | Search box, target picker, band, field of view             |
| `components/StatusBar.tsx`   | Latest-data indicator, loading progress, refresh           |
| `lib/sky.ts`                 | Coordinate maths and formatting                            |

## Where each next piece plugs in

### 1. Data and bands (102 bands, co-add, spectra, flags)

- Wavelength per frame is already returned (`X-Wavelength-Um`). To filter or
  group by wavelength, add the filter in `useFrames.ts` or add a
  `wave_min/wave_max` parameter to `/api/frames/{id}/image`.
- Co-adds: add a function next to `align_cutout()` in `cutouts.py` that takes
  several `AlignedImage`s (they share one grid) and averages them, then a new
  route such as `/api/coadd` in `api.py`.
- Spectra: for each frame take the pixel value at the centre plus its
  wavelength. A `/api/spectrum?ra&dec` route can loop over all six bands.
- Flags: `align_cutout()` already opens the `FLAGS` extension and reports the
  flagged fraction. Mask or return per-bit information there. The bright
  square and black blobs in the pictures are flagged pixels that are not
  masked yet.

### 2. Overlays (Gaia DR3, WISE, Aladin) — done

- Backend: `catalogs.py` cone-searches IRSA's Gator service (about 1 s; IRSA
  TAP has the same tables but takes 20 to 30 s). Layers: Gaia DR3
  (`gaia_dr3_source`, epoch J2016.0), CatWISE2020 (`catwise_2020`, motion-fit
  epoch MJD 57170) and a short hand-made list of famous fast movers that the
  catalogues miss or split (WISE 0855). Routes live in `overlays_api.py`:
  `GET /api/overlays/{gaia|wise|movers}?ra&dec&fov`. Answers are cached on
  disk for a week. Wider views ask for brighter stars only (`MAG_LIMITS`).
- CatWISE has many fake "movers" around bright or fast stars (pieces of the
  star's halo). Sources whose motion fit is bad (`rchi2_pm > 10`) or below 3
  sigma come back with `pm_ok: false` and are drawn where they were measured.
- Frontend: everything is in `frontend/src/overlays/`. `motion.ts` moves each
  source to the date of the frame on screen and projects it (forward of
  `offsetToSky`). BlinkCanvas only exposes three hooks: `drawExtra`, `onPick`
  and `children` (the info card).
- Layer choices are remembered in localStorage, not the URL (yet).
- "Compare with other sky surveys" loads Aladin Lite 3.8.2 from jsDelivr only
  when opened.

### 3. Controls (FOV, add/subtract, URL embedding)

- New URL parameters go in `ViewState` in `urlState.ts` (parse and write).
  Good candidates: `frame`, `fps`, `invert`, `zoom`.
- Add/subtract: `format=fits` returns the aligned float data, or do it on the
  server with two `AlignedImage`s and `render.to_png()`.
- `embed=1` already hides the header, controls and side panel.

### 4. Polish and deploy

- `npm run build` then `npm run start` serves everything from one process on
  one port, which suits most hosts. Set `SPHEREX_CACHE_DIR` to a persistent
  disk if the host has one.
- If the frontend is hosted separately, set `VITE_API_BASE` at build time and
  `SPHEREX_CORS_ORIGINS` on the backend.
- Speed: IRSA cutouts take about 4 seconds each. The search results also list
  an AWS S3 location for every file (`cloud_access`), and S3 supports partial
  downloads, so reading only the needed pixels straight from S3 would be a
  good speed-up. Pre-warming the cache for the five test targets is the cheap
  option.

## Tests

`npm run test` runs `backend/tests` (offline: fake rotated cutouts check that
alignment puts the target in the centre) and the TypeScript type check.
