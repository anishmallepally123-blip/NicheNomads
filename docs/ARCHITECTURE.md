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
| `state/urlState.ts`          | The URL is the source of truth (all parameters listed at the top of the file) |
| `state/embedBridge.ts`       | postMessage API for pages that embed the viewer in an iframe |
| `api/client.ts`              | All backend calls and the data types                       |
| `viewer/useFrames.ts`        | Loads the frame list, then pictures, a few at a time       |
| `viewer/usePlayer.ts`        | Current frame, play/pause, speed                           |
| `viewer/BlinkCanvas.tsx`     | Canvas drawing, smooth pan/zoom/pinch, RA/Dec readout, marker, scale bar, compass |
| `viewer/imageOps.ts`, `useImageOps.ts` | Add / subtract frames (difference against median, previous, first or a pinned frame) |
| `viewer/PlayerControls.tsx`  | Buttons, scrubber, frame info                              |
| `components/Controls.tsx`    | Search box, target picker, band, field of view (`FovPicker`) |
| `components/SkyNavigator.tsx`| All-sky locator map (click to jump) and N/S/E/W step buttons |
| `components/ImageOpsPanel.tsx`, `EmbedPanel.tsx` | Add/subtract settings; share link and iframe code |
| `components/StatusBar.tsx`   | Latest-data indicator, loading progress, refresh           |
| `lib/sky.ts`                 | Coordinate maths and formatting                            |

## Where each next piece plugs in

### 1. Data and bands (102 bands, co-add, spectra, flags) — done

| File / route | What it does |
| --- | --- |
| `quality.py` | Reads flag names from the FLAGS header. "Bad" = the conservative list from the IRSA tutorials (TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, HOT, COLD, PERSIST, HALO, BLOOM, ...). SOURCE (set on 40-50 % of pixels, it just means "a star is here") and OUTLIER are *not* bad. |
| `cutouts.align_cutout()` | Bad pixels are removed before resampling. `data` has them filled from neighbours (display only, this fixes the white squares and black blobs), `science` keeps them as NaN, `filled` says which is which. `format=fits` downloads `science`. |
| `cutouts.coadd()`, `GET /api/coadd?ra&dec&fov&band[&channel]` | Weighted mean of all aligned frames of a detector or one of its 17 channels. One weight per frame (1/noise², so bright stars are not biased), flagged pixels left out, per-pixel outlier rejection that never clips real stars. Values stay in MJy/sr. `format=fits` adds an NFRAMES map. |
| `bands.py`, `GET /api/bands` | 6 bands × 17 channels = 102, equal-R channels in log wavelength. |
| `spectra.py`, `GET /api/spectrum?ra&dec` | Forced PSF photometry in every exposure with the mission ePSF, background fitted, flagged pixels excluded, converted to µJy with the pixel solid angle. Points plus a 102-channel binned spectrum. Saturated sources are reported as such instead of measured. |
| `data_access.fetch_stamp()` | Reads only a 17 × 17 pixel box per exposure from NASA's public S3 bucket (range requests). About 250 exposures take 30-90 s the first time, then cached. Falls back to a small IRSA cutout. |
| `GET /api/frames/{id}/meta` | Wavelength, channel, flags at the target pixel, flag counts, header checks. |
| `frontend/src/data/` | The "This frame", "Deep image" and "Spectrum" sections of the side panel. |

Checks done on real data: a 2MASS star next to WISE 0855 (J 15.4) comes out within
2-9 % of its 2MASS J, H, Ks fluxes. WISE 0855 itself (now about 1.6 arcmin west of
the challenge coordinates, at RA 133.7590, Dec -7.2419) shows the expected
brown-dwarf shape: faint near 1-3.5 µm and bright at 4.2-5 µm. Barnard's Star is
saturated in nearly every exposure, so its spectrum is refused with that reason.

Wavelengths: the foundation read the per-pixel wavelength with the sky
distortion (SIP) applied to the wavelength table, which shifted it by about
0.15 %. `cutouts.alt_wcs()` now turns SIP off for the alternate WCSs, as the
IRSA tutorials do.

Known limits: the position is fixed for all exposures, so a fast mover
(WISE 0855 moves ~1.3 pixels over the year) loses a little flux in the
earliest and latest frames. Channel edges are computed, not read from the
mission table, so a frame right on an edge can land in the neighbouring channel.

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

### 3. Controls (done: navigation, FOV, add/subtract, URL embedding)

- URL parameters: `ra`, `dec` (degrees, or `8h55m10.8s` / `-7d14m42s`), `fov`
  (1 to 60 arcmin), `band`, `frame` (obs_id, opens paused on it), `fps`,
  `play=0`, `zoom`, `op=diff|sum` with `ref=median|mean|prev|first|<obs_id>`,
  `gain`, `n`, `invert`, `marker=0`, `embed=1`, `controls=0`. Moving to a new
  place adds a browser history entry, everything else updates the current one.
- Add/subtract runs in the browser on the PNGs, after undoing the asinh
  stretch. If `render.stretch()` changes, update `ASINH_A` in `imageOps.ts`.
- Embedding: `embed=1` shows only the picture and player. The host page can
  steer it with `postMessage({type: "spherex-blink:set", ra, dec, fov})` and
  `spherex-blink:play|pause|step`, and receives `spherex-blink:view` messages.

### 4. Polish and deploy

Done: see [DEPLOY.md](DEPLOY.md). Colours and spacing are tokens at the top of
`styles.css`; reuse them (`--accent`, `--cool`, `--panel`...) for new UI.
Loading, empty and error states for the viewer live in
`components/ViewerOverlay.tsx`. Error reporting is in `lib/monitoring.ts`
(browser) and `backend/app/monitoring.py` (API), both off without a DSN.

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
