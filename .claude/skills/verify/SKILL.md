---
name: verify
description: Build, run and drive the map-hat Next.js app (including the WebGL /simulator) headlessly to verify changes at the browser surface.
---

# Verifying map-hat

## Build & run
```bash
npm install
npx next build            # must pass; lint 'any' warnings in legacy files are expected
npx next start -p 3210 &  # prod server; pick a fresh port if 3210 is held by a zombie
```

## Browser handle (WebGL map)
Playwright is a devDependency. Chromium install: `npx playwright install chromium`.

Launch flags that make MapLibre render in this container (software GL):
```js
chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--no-sandbox"] })
```

**Gotcha — sandbox TLS interception:** this environment MITM-proxies HTTPS with a
custom CA that curl/node trust but Chromium does not (`ERR_CERT_AUTHORITY_INVALID`,
surfaces as `Failed to fetch` for Overpass/Nominatim/tiles). Create pages with
`ignoreHTTPSErrors: true` or all external fetches fail and the app silently uses
its procedural fallback.

Expect ~2-3 FPS under SwiftShader — that's the software rasterizer, not the app.

## Flows worth driving on /simulator
- Load → wait for `text=/Real roads/` then `text=/Real data ·/` (progressive OSM load).
- Motion: two screenshots 3s apart must differ (vehicles animate).
- Import: `page.setInputFiles('input[type="file"]', {name, mimeType, buffer})` with
  inline GeoJSON; then `page.selectOption("select", "flow" | "pulse" | "extrude")`.
- Search: fill `input[placeholder*="Search"]`, click `text=Go`, then `text=Build here`.
- Cancel: change the OSM radius slider (cache-buster), click rebuild, click Cancel fast.
- Garbage import: invalid JSON file → red error strip names the file.

The right control panel re-renders every ~400ms (stats sync); interact with
`page.evaluate` clicks if a locator ever reports "element is not stable".
