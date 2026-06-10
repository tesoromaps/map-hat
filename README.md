# map-hat

A [Next.js](https://nextjs.org) mapping playground.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the AI-enhanced map, or
[http://localhost:3000/simulator](http://localhost:3000/simulator) for the City Block Simulator.

## City Block Simulator (`/simulator`)

A procedurally generated city block sandbox rendered with MapLibre GL:

- **Multi-agent traffic** — cars, taxis, buses and trucks navigate a signalized
  road grid with car-following, stop lines, yellow-light decisions and random
  turning at intersections. Buses pull up and dwell at curbside bus stops.
  Click any vehicle to follow it with the camera.
- **Pedestrians** — sidewalk-walking agents that wait at signalized corners
  until cross-traffic has the red, with person-class detection boxes.
- **Live detection overlay** — toggleable CV-style bounding boxes around every
  vehicle with class, confidence and track ID labels, plus fading track trails.
- **Census-style tracts** — choropleth tract polygons with synthetic population,
  density and income data (click a tract for details).
- **Day → night cycle** — adjustable clock and day length drive a full palette
  transition; streetlights pop on one by one at dusk, headlights and signal
  glows appear at night, tall buildings light their windows, and a rooftop
  beacon blinks on the tallest tower.
- **Infrastructure animations** — cycling traffic signals at every interior
  intersection, crosswalks, lane lines, parks with trees, 3D extruded buildings.
- **Geo data import** — drop or browse for **GeoJSON, KML, KMZ, zipped
  shapefiles, or loose `.shp` + `.dbf` pairs**; each file becomes a toggleable,
  removable overlay layer with zoom-to-fit.

Key code:

| Path | Purpose |
| --- | --- |
| `app/simulator/page.tsx` | Route (client-only dynamic import) |
| `components/city-simulator/city-block-simulator.tsx` | Map, render loop, UI panel |
| `lib/city-simulator/citygen.ts` | Procedural city: road graph, blocks, buildings, tracts |
| `lib/city-simulator/traffic.ts` | Multi-agent traffic engine + GeoJSON frame builders |
| `lib/city-simulator/daynight.ts` | Day/night palette keyframes |
| `lib/city-simulator/geo-import.ts` | Shapefile / KML / KMZ / GeoJSON parsing |

## Build

```bash
npm run build
npm start
```
