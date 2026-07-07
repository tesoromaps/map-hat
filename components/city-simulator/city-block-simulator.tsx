"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { generateCity, type CityModel } from "@/lib/city-simulator/citygen"
import { TrafficSim, PedestrianSim, type VehicleKind } from "@/lib/city-simulator/traffic"
import { paletteForHour, formatClock, dayPhase } from "@/lib/city-simulator/daynight"
import { importGeoFiles, ACCEPTED_EXTENSIONS, type ImportedLayer } from "@/lib/city-simulator/geo-import"
import { BASEMAPS, DEFAULT_BASEMAP, getBasemap, type Basemap } from "@/lib/city-simulator/basemaps"
import { geocode, type GeocodeResult } from "@/lib/city-simulator/geocode"
import { fetchOSMRoads, fetchOSMBuildings, buildCityFromOSM, buildExtrasFromOSM } from "@/lib/city-simulator/osm"

type ImportAnim = "none" | "flow" | "pulse" | "extrude"

const DEFAULT_CENTER: [number, number] = [-122.4194, 37.7749]
const BLOCKS_X = 10
const BLOCKS_Y = 8
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] }
// Imported overlays sit above the synthetic city graphics but below text labels,
// so a dropped shapefile/KML always shows instead of hiding under the buildings.
const IMPORT_ANCHOR = "box-labels"
const DYNAMIC_SOURCES = ["trails", "headlights", "vehicles", "peds", "boxes", "box-labels", "signals"]
const IMPORT_SUFFIXES = ["fill", "line", "circle", "glow", "extrude"]
// Canonical marching-ants dash sequence for the flowing-line effect.
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
]

interface UiState {
  playing: boolean
  vehicleCount: number
  pedCount: number
  simSpeed: number
  hour: number
  autoCycle: boolean
  dayLengthSec: number
  basemap: string
  groundOpacity: number
  osm: boolean
  osmRadius: number
  showBoxes: boolean
  showLabels: boolean
  showTrails: boolean
  showTracts: boolean
  show3d: boolean
  showSignals: boolean
  showStreetlights: boolean
}

interface ImportEntry extends ImportedLayer {
  id: number
  color: string
  visible: boolean
  anim: ImportAnim
}

interface Stats {
  counts: Record<VehicleKind, number>
  avgKmh: number
  fps: number
}

const DEFAULT_UI: UiState = {
  playing: true,
  vehicleCount: 90,
  pedCount: 60,
  simSpeed: 1,
  hour: 17.5,
  autoCycle: true,
  dayLengthSec: 150,
  basemap: DEFAULT_BASEMAP,
  groundOpacity: 1,
  osm: true,
  osmRadius: 450,
  showBoxes: true,
  showLabels: true,
  showTrails: true,
  showTracts: true,
  show3d: true,
  showSignals: true,
  showStreetlights: true,
}

function seedFromCoords(lng: number, lat: number): number {
  const n = (Math.floor((lng + 180) * 8192) ^ Math.floor((lat + 90) * 8192)) >>> 0
  return n || 1
}

function beaconFC(city: CityModel): GeoJSON.FeatureCollection {
  if (city.beacon.height <= 0) return EMPTY_FC
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: city.toLngLat(city.beacon.x, city.beacon.y) } }],
  }
}

/** Rewrite every static city source from a (re)generated model. */
function writeCitySources(map: maplibregl.Map, city: CityModel) {
  const set = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data)
  set("tracts", city.geo.tracts)
  set("tract-labels", city.geo.tractLabels)
  set("blocks", city.geo.blocks)
  set("parks", city.geo.parks)
  set("trees", city.geo.trees)
  set("roads", city.geo.roads)
  set("crosswalks", city.geo.crosswalks)
  set("buildings", city.geo.buildings)
  set("streetlights", city.geo.streetlights)
  set("bus-stops", city.geo.busStops)
  set("beacon", beaconFC(city))
}

/** Swap the bottom raster basemap layer, syncing its night brightness. */
function applyBasemap(map: maplibregl.Map, bm: Basemap, night: number) {
  if (map.getLayer("basemap-layer")) map.removeLayer("basemap-layer")
  if (map.getSource("basemap")) map.removeSource("basemap")
  if (!bm.tiles) return
  map.addSource("basemap", {
    type: "raster",
    tiles: bm.tiles,
    tileSize: 256,
    maxzoom: bm.maxzoom,
    attribution: bm.attribution,
  })
  const before = map.getLayer("tracts-fill") ? "tracts-fill" : undefined
  map.addLayer(
    {
      id: "basemap-layer",
      type: "raster",
      source: "basemap",
      paint: { "raster-brightness-max": 1 - night * 0.55, "raster-saturation": -night * 0.3 },
    },
    before,
  )
}

export function CityBlockSimulator() {
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const cityRef = useRef<CityModel | null>(null)
  const simRef = useRef<TrafficSim | null>(null)
  const pedSimRef = useRef<PedestrianSim | null>(null)
  const followRef = useRef<number | null>(null)
  const centerRef = useRef<[number, number]>(DEFAULT_CENTER)
  const loadedRef = useRef(false)
  const importIdRef = useRef(1)
  const osmAbortRef = useRef<AbortController | null>(null)
  // Mirror of imported-layer animation state, read by the rAF loop.
  const importAnimRef = useRef<{ id: number; color: string; anim: ImportAnim }[]>([])

  const [ui, setUi] = useState<UiState>(DEFAULT_UI)
  const uiRef = useRef(ui)
  uiRef.current = ui
  const [stats, setStats] = useState<Stats>({ counts: { car: 0, taxi: 0, bus: 0, truck: 0 }, avgKmh: 0, fps: 0 })
  const [clock, setClock] = useState({ hour: DEFAULT_UI.hour, night: 0 })
  const [coords, setCoords] = useState({ lng: DEFAULT_CENTER[0], lat: DEFAULT_CENTER[1], zoom: 15.1 })
  const [imports, setImports] = useState<ImportEntry[]>([])
  const [following, setFollowing] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [osmLoading, setOsmLoading] = useState<string | null>(null)
  const [osmNote, setOsmNote] = useState<string | null>(null)

  // search state
  const [searchQuery, setSearchQuery] = useState("")
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // ---------- map + simulation bootstrap ----------
  useEffect(() => {
    if (!containerRef.current) return
    const city = generateCity({ centerLng: DEFAULT_CENTER[0], centerLat: DEFAULT_CENTER[1], blocksX: BLOCKS_X, blocksY: BLOCKS_Y, seed: 20260610 })
    const sim = new TrafficSim(city, 99)
    sim.setVehicleCount(uiRef.current.vehicleCount)
    const pedSim = new PedestrianSim(sim, 7)
    pedSim.setCount(uiRef.current.pedCount)
    cityRef.current = city
    simRef.current = sim
    pedSimRef.current = pedSim
    centerRef.current = DEFAULT_CENTER

    const pal0 = paletteForHour(uiRef.current.hour)
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": pal0.bg } }],
      },
      center: DEFAULT_CENTER,
      zoom: 15.1,
      pitch: 48,
      bearing: -12,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left")
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left")
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right")

    map.on("load", () => {
      const addSrc = (id: string, data: GeoJSON.FeatureCollection) => map.addSource(id, { type: "geojson", data })
      addSrc("tracts", city.geo.tracts)
      addSrc("tract-labels", city.geo.tractLabels)
      addSrc("blocks", city.geo.blocks)
      addSrc("parks", city.geo.parks)
      addSrc("trees", city.geo.trees)
      addSrc("roads", city.geo.roads)
      addSrc("crosswalks", city.geo.crosswalks)
      addSrc("buildings", city.geo.buildings)
      addSrc("streetlights", city.geo.streetlights)
      addSrc("bus-stops", city.geo.busStops)
      addSrc("beacon", beaconFC(city))
      for (const id of DYNAMIC_SOURCES) addSrc(id, EMPTY_FC)

      map.addLayer({
        id: "tracts-fill", type: "fill", source: "tracts",
        paint: {
          "fill-color": ["interpolate", ["linear"], ["get", "density"], 2000, "#22c55e", 6000, "#eab308", 12000, "#ef4444"],
          "fill-opacity": 0.1,
        },
      })
      map.addLayer({ id: "blocks-fill", type: "fill", source: "blocks", paint: { "fill-color": pal0.block, "fill-opacity": uiRef.current.groundOpacity } })
      map.addLayer({ id: "parks-fill", type: "fill", source: "parks", paint: { "fill-color": pal0.park, "fill-opacity": uiRef.current.groundOpacity } })
      map.addLayer({
        id: "trees", type: "circle", source: "trees",
        paint: {
          "circle-color": "#3f8f4f",
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 1.5, 18, 14],
          "circle-opacity": 0.85,
        },
      })
      map.addLayer({
        id: "roads", type: "line", source: "roads",
        paint: {
          "line-color": ["case", ["==", ["get", "avenue"], 1], pal0.roadAvenue, pal0.road],
          "line-width": ["interpolate", ["exponential", 2], ["zoom"], 13, ["case", ["==", ["get", "avenue"], 1], 2.4, 1.4], 16, ["case", ["==", ["get", "avenue"], 1], 16, 10], 19, ["case", ["==", ["get", "avenue"], 1], 120, 75]],
        },
      })
      map.addLayer({
        id: "lane-lines", type: "line", source: "roads", minzoom: 15,
        paint: { "line-color": "#caa94c", "line-width": 0.8, "line-opacity": 0.5, "line-dasharray": [3, 3] },
      })
      map.addLayer({
        id: "crosswalks", type: "line", source: "crosswalks", minzoom: 15.5,
        paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.45, "line-dasharray": [0.8, 0.8] },
      })
      map.addLayer({
        id: "tracts-line", type: "line", source: "tracts",
        paint: { "line-color": pal0.tractLine, "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.85 },
      })
      map.addLayer({
        id: "trails", type: "line", source: "trails",
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.45, "line-blur": 0.5 },
        layout: { "line-cap": "round", "line-join": "round" },
      })
      map.addLayer({
        id: "streetlight-glow", type: "circle", source: "streetlights",
        paint: {
          "circle-color": "#ffd960",
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 4, 18, 34],
          "circle-blur": 1.4,
          "circle-opacity": 0,
        },
      })
      map.addLayer({
        id: "streetlight-pole", type: "circle", source: "streetlights", minzoom: 15,
        paint: { "circle-color": "#9aa3ad", "circle-radius": 1.6, "circle-opacity": 0.8 },
      })
      map.addLayer({
        id: "buildings", type: "fill-extrusion", source: "buildings",
        paint: {
          "fill-extrusion-color": pal0.building,
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["coalesce", ["get", "minHeight"], 0],
          "fill-extrusion-opacity": 0.92,
        },
      })
      map.addLayer({
        id: "headlights", type: "circle", source: "headlights",
        paint: {
          "circle-color": "#ffe9a8",
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 2, 18, 16],
          "circle-blur": 1.2,
          "circle-opacity": 0,
        },
      })
      map.addLayer({
        id: "bus-stops", type: "circle", source: "bus-stops", minzoom: 14.5,
        paint: {
          "circle-color": "#fbbf24",
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 1.5, 18, 6],
          "circle-stroke-color": "#78350f",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      })
      map.addLayer({ id: "vehicles", type: "fill", source: "vehicles", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.97 } })
      map.addLayer({
        id: "peds", type: "circle", source: "peds", minzoom: 14,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 1, 18, 5],
          "circle-stroke-color": "#1e293b",
          "circle-stroke-width": 0.5,
        },
      })
      map.addLayer({
        id: "boxes", type: "line", source: "boxes",
        paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-opacity": 0.95 },
      })
      map.addLayer({
        id: "signal-glow", type: "circle", source: "signals",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 4, 18, 26],
          "circle-blur": 1.3,
          "circle-opacity": 0,
        },
      })
      map.addLayer({
        id: "signals", type: "circle", source: "signals",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, 2, 18, 7],
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 1,
        },
      })
      map.addLayer({
        id: "beacon", type: "circle", source: "beacon",
        paint: { "circle-color": "#ff3b3b", "circle-radius": 4, "circle-blur": 0.4, "circle-opacity": 0.9 },
      })
      map.addLayer({
        id: "box-labels", type: "symbol", source: "box-labels", minzoom: 14.5,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 10.5,
          "text-anchor": "bottom",
          "text-offset": [0, -0.4],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": ["get", "color"], "text-halo-color": "#0b1220", "text-halo-width": 1.2 },
      })
      map.addLayer({
        id: "tract-label-text", type: "symbol", source: "tract-labels",
        layout: {
          "text-field": ["concat", "TRACT ", ["get", "tractId"]],
          "text-font": ["Open Sans Semibold"],
          "text-size": 12,
          "text-letter-spacing": 0.15,
        },
        paint: { "text-color": pal0.text, "text-halo-color": pal0.textHalo, "text-halo-width": 1.4, "text-opacity": 0.85 },
      })

      // Bottom raster basemap
      applyBasemap(map, getBasemap(uiRef.current.basemap), pal0.night)

      // Unified click handling: follow a vehicle > inspect imported feature > tract info
      const esc = (s: string) =>
        s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
      map.on("click", (e) => {
        const feats = map.queryRenderedFeatures(e.point)
        const vehicle = feats.find((f) => f.layer.id === "vehicles")
        if (vehicle?.properties) {
          followRef.current = Number(vehicle.properties.id)
          setFollowing(`${vehicle.properties.kind} #${vehicle.properties.id}`)
          return
        }
        if (followRef.current !== null) {
          followRef.current = null
          setFollowing(null)
        }
        const imported = feats.find((f) => f.layer.id.startsWith("imp-"))
        if (imported) {
          const props = (imported.properties || {}) as Record<string, unknown>
          const rows = Object.entries(props)
            .slice(0, 14)
            .map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(String(v))}</div>`)
            .join("")
          new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;color:#0f172a;max-height:240px;overflow:auto">
                 <strong>Imported feature</strong><br/>${rows || "<em>No properties</em>"}
               </div>`,
            )
            .addTo(map)
          return
        }
        const tract = feats.find((f) => f.layer.id === "tracts-fill")
        if (tract?.properties) {
          const p = tract.properties as Record<string, string | number>
          new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;color:#0f172a">
                 <strong>Census Tract ${p.tractId}</strong><br/>
                 Population: ${Number(p.population).toLocaleString()}<br/>
                 Density: ${Number(p.density).toLocaleString()} /km²<br/>
                 Median income: $${Number(p.medianIncome).toLocaleString()}<br/>
                 Area: ${p.areaKm2} km²
               </div>`,
            )
            .addTo(map)
        }
      })
      map.on("dragstart", () => {
        if (followRef.current !== null) {
          followRef.current = null
          setFollowing(null)
        }
      })
      map.on("mouseenter", "vehicles", () => (map.getCanvas().style.cursor = "pointer"))
      map.on("mouseleave", "vehicles", () => (map.getCanvas().style.cursor = ""))

      // Live coordinate readout (throttled)
      let lastCoordT = 0
      map.on("mousemove", (e) => {
        const now = performance.now()
        if (now - lastCoordT < 90) return
        lastCoordT = now
        setCoords({ lng: e.lngLat.lng, lat: e.lngLat.lat, zoom: map.getZoom() })
      })

      loadedRef.current = true
    })

    // ---------- animation loop ----------
    let raf = 0
    let last = performance.now()
    let lastStats = 0
    let lastPaletteHour = -99
    let frames = 0
    let fpsWindowStart = performance.now()
    let fps = 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dtReal = Math.min(0.1, (now - last) / 1000)
      last = now
      frames++
      if (now - fpsWindowStart > 1000) {
        fps = Math.round((frames * 1000) / (now - fpsWindowStart))
        frames = 0
        fpsWindowStart = now
      }
      const u = uiRef.current
      if (!loadedRef.current || !mapRef.current || !simRef.current || !pedSimRef.current) return
      const m = mapRef.current
      const s = simRef.current
      const ps = pedSimRef.current

      if (u.playing) {
        // Sub-step physics for stability at high sim speeds
        let remaining = dtReal * u.simSpeed
        while (remaining > 0) {
          const step = Math.min(0.05, remaining)
          s.step(step)
          ps.step(step)
          remaining -= step
        }
        if (u.autoCycle) {
          const newHour = (u.hour + dtReal * u.simSpeed * (24 / u.dayLengthSec)) % 24
          uiRef.current = { ...u, hour: newHour }
        }
      }
      const hour = uiRef.current.hour
      const pal = paletteForHour(hour)

      const setData = (id: string, data: GeoJSON.FeatureCollection) => {
        const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined
        if (src) src.setData(data)
      }
      setData("vehicles", s.buildVehicleFrame())
      setData("peds", ps.buildPedFrame())
      if (u.showBoxes || u.showLabels) {
        const det = s.buildDetectionFrame()
        const pedDet = ps.buildDetectionFrame()
        det.boxes.features.push(...pedDet.boxes)
        det.labels.features.push(...pedDet.labels)
        if (u.showBoxes) setData("boxes", det.boxes)
        if (u.showLabels) setData("box-labels", det.labels)
      }
      if (u.showTrails) setData("trails", s.buildTrailFrame())
      if (u.showSignals) setData("signals", s.buildTrafficLightFrame())
      if (pal.night > 0.05) setData("headlights", s.buildHeadlightFrame())

      // Follow camera: track the selected vehicle until click-away or drag
      if (followRef.current !== null) {
        const target = s.vehicles.find((v) => v.id === followRef.current)
        if (target) {
          m.jumpTo({ center: s.position(target).lngLat })
        } else {
          followRef.current = null
          setFollowing(null)
        }
      }

      // Animated import layers: flowing lines, pulsing points, live extrusions
      for (const im of importAnimRef.current) {
        if (im.anim === "flow") {
          const lid = `imp-${im.id}-line`
          if (m.getLayer(lid)) {
            m.setPaintProperty(lid, "line-dasharray", DASH_SEQUENCE[Math.floor(now / 55) % DASH_SEQUENCE.length])
            m.setPaintProperty(lid, "line-width", 3)
          }
          const gid = `imp-${im.id}-glow`
          if (m.getLayer(gid)) m.setPaintProperty(gid, "line-opacity", 0.28 + 0.22 * Math.sin(now / 300))
        } else if (im.anim === "pulse") {
          const cid = `imp-${im.id}-circle`
          if (m.getLayer(cid)) {
            m.setPaintProperty(cid, "circle-radius", 5 + 3.5 * (0.5 + 0.5 * Math.sin(now / 260 + im.id)))
            m.setPaintProperty(cid, "circle-opacity", 0.55 + 0.45 * Math.abs(Math.sin(now / 480 + im.id)))
          }
        } else if (im.anim === "extrude") {
          const eid = `imp-${im.id}-extrude`
          if (m.getLayer(eid)) m.setPaintProperty(eid, "fill-extrusion-opacity", 0.42 + 0.16 * Math.sin(now / 600 + im.id))
        }
      }

      // Blinking rooftop beacon (infrastructure animation)
      const blink = Math.sin(now / 280) > 0.2 ? 0.95 : 0.08
      if (m.getLayer("beacon")) m.setPaintProperty("beacon", "circle-opacity", blink)

      // Day/night palette transitions (only when the hour moved meaningfully)
      if (Math.abs(hour - lastPaletteHour) > 0.02 && m.getLayer("bg")) {
        lastPaletteHour = hour
        m.setPaintProperty("bg", "background-color", pal.bg)
        m.setPaintProperty("blocks-fill", "fill-color", pal.block)
        m.setPaintProperty("parks-fill", "fill-color", pal.park)
        m.setPaintProperty("roads", "line-color", ["case", ["==", ["get", "avenue"], 1], pal.roadAvenue, pal.road])
        m.setPaintProperty("tracts-line", "line-color", pal.tractLine)
        m.setPaintProperty("tract-label-text", "text-color", pal.text)
        m.setPaintProperty("tract-label-text", "text-halo-color", pal.textHalo)
        // Buildings: lit windows tint taller buildings at night
        m.setPaintProperty("buildings", "fill-extrusion-color", [
          "interpolate", ["linear"], ["get", "height"],
          10, pal.building,
          120, pal.night > 0.5 ? "#3d4a78" : pal.buildingTop,
        ])
        m.setLight({ color: pal.lightColor, intensity: pal.lightIntensity, anchor: "viewport" })
        // Streetlights pop on one by one as night falls (data-driven threshold)
        m.setPaintProperty("streetlight-glow", "circle-opacity", [
          "case", ["<", ["get", "th"], pal.night], 0.55, 0,
        ])
        m.setPaintProperty("headlights", "circle-opacity", pal.night * 0.5)
        m.setPaintProperty("signal-glow", "circle-opacity", pal.night * 0.65)
        m.setPaintProperty("trees", "circle-color", pal.night > 0.5 ? "#1d3a28" : "#3f8f4f")
        // Real basemap dims toward night so the day/night cycle still reads
        if (m.getLayer("basemap-layer")) {
          m.setPaintProperty("basemap-layer", "raster-brightness-max", 1 - pal.night * 0.55)
          m.setPaintProperty("basemap-layer", "raster-saturation", -pal.night * 0.3)
        }
      }

      // Throttled React state sync for HUD/stats
      if (now - lastStats > 400) {
        lastStats = now
        setClock({ hour, night: pal.night })
        setStats({ counts: s.countsByKind(), avgKmh: s.averageSpeedKmh(), fps })
        if (u.autoCycle && u.playing) setUi((prev) => ({ ...prev, hour }))
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      loadedRef.current = false
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- UI -> sim/map sync ----------
  useEffect(() => {
    simRef.current?.setVehicleCount(ui.vehicleCount)
  }, [ui.vehicleCount])

  useEffect(() => {
    pedSimRef.current?.setCount(ui.pedCount)
  }, [ui.pedCount])

  useEffect(() => {
    const m = mapRef.current
    if (!m || !loadedRef.current) return
    applyBasemap(m, getBasemap(ui.basemap), paletteForHour(uiRef.current.hour).night)
  }, [ui.basemap])

  useEffect(() => {
    const m = mapRef.current
    if (!m || !loadedRef.current) return
    if (m.getLayer("blocks-fill")) m.setPaintProperty("blocks-fill", "fill-opacity", ui.groundOpacity)
    if (m.getLayer("parks-fill")) m.setPaintProperty("parks-fill", "fill-opacity", ui.groundOpacity)
  }, [ui.groundOpacity])

  // Keep the rAF loop's view of import animations in sync with React state.
  useEffect(() => {
    importAnimRef.current = imports.map((e) => ({ id: e.id, color: e.color, anim: e.anim }))
  }, [imports])

  useEffect(() => {
    const m = mapRef.current
    if (!m || !loadedRef.current) return
    const vis = (ids: string[], on: boolean) =>
      ids.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", on ? "visible" : "none"))
    vis(["boxes"], ui.showBoxes)
    vis(["box-labels"], ui.showLabels)
    vis(["trails"], ui.showTrails)
    vis(["tracts-fill", "tracts-line", "tract-label-text"], ui.showTracts)
    vis(["signals", "signal-glow"], ui.showSignals)
    vis(["streetlight-glow", "streetlight-pole"], ui.showStreetlights)
    if (m.getLayer("buildings")) {
      m.setPaintProperty("buildings", "fill-extrusion-height", ui.show3d ? ["get", "height"] : 0)
    }
  }, [ui.showBoxes, ui.showLabels, ui.showTrails, ui.showTracts, ui.showSignals, ui.showStreetlights, ui.show3d])

  // ---------- relocate the whole simulation to a new coordinate ----------
  const installCity = useCallback((city: CityModel, lng: number, lat: number, fly: boolean) => {
    const m = mapRef.current
    if (!m) return
    const sim = new TrafficSim(city, 99)
    sim.setVehicleCount(uiRef.current.vehicleCount)
    const pedSim = new PedestrianSim(sim, 7)
    pedSim.setCount(uiRef.current.pedCount)
    cityRef.current = city
    simRef.current = sim
    pedSimRef.current = pedSim
    centerRef.current = [lng, lat]
    followRef.current = null
    setFollowing(null)
    writeCitySources(m, city)
    for (const id of DYNAMIC_SOURCES) (m.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC)
    if (fly) m.flyTo({ center: [lng, lat], zoom: 15.6, pitch: 52, bearing: -12, duration: 1600 })
  }, [])

  const relocateCity = useCallback(
    async (lng: number, lat: number, fly = true) => {
      if (!mapRef.current || !loadedRef.current) return
      const seed = seedFromCoords(lng, lat)
      // Cancel any in-flight OSM request.
      osmAbortRef.current?.abort()
      if (!uiRef.current.osm) {
        installCity(generateCity({ centerLng: lng, centerLat: lat, blocksX: BLOCKS_X, blocksY: BLOCKS_Y, seed }), lng, lat, fly)
        setOsmNote(null)
        return
      }
      const ctrl = new AbortController()
      osmAbortRef.current = ctrl
      setOsmLoading("Fetching real road network…")
      setOsmNote(null)
      try {
        // Roads first — small query, so agents start driving real streets
        // right away. Buildings/greenspace stream in behind the running sim.
        const roadEls = await fetchOSMRoads(lng, lat, uiRef.current.osmRadius, ctrl.signal)
        if (ctrl.signal.aborted) return
        const { city, stats } = buildCityFromOSM(lng, lat, seed, roadEls)
        installCity(city, lng, lat, fly)
        setOsmNote(`Real roads · ${stats.roads} streets · ${stats.signals} signals · loading buildings…`)
        fetchOSMBuildings(lng, lat, uiRef.current.osmRadius, ctrl.signal)
          .then((els) => {
            const m = mapRef.current
            // Drop the result if the user has since moved on to another city.
            if (ctrl.signal.aborted || cityRef.current !== city || !m) return
            const ex = buildExtrasFromOSM(lng, lat, seed, els)
            city.geo.buildings = ex.buildings
            city.geo.parks = ex.parks
            city.geo.trees = ex.trees
            if (ex.beacon.height > 0) city.beacon = ex.beacon
            const setData = (id: string, data: GeoJSON.FeatureCollection) =>
              (m.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data)
            setData("buildings", ex.buildings)
            setData("parks", ex.parks)
            setData("trees", ex.trees)
            setData("beacon", beaconFC(city))
            setOsmNote(`Real data · ${ex.counts.buildings} buildings · ${stats.roads} streets · ${stats.signals} signals`)
          })
          .catch((err) => {
            if (ctrl.signal.aborted || cityRef.current !== city) return
            setOsmNote(`Roads are real · buildings unavailable (${err instanceof Error ? err.message : "error"})`)
          })
      } catch (err) {
        if (ctrl.signal.aborted) return
        // Graceful fallback so the simulator always produces a city.
        installCity(generateCity({ centerLng: lng, centerLat: lat, blocksX: BLOCKS_X, blocksY: BLOCKS_Y, seed }), lng, lat, fly)
        setOsmNote(`OSM unavailable (${err instanceof Error ? err.message : "error"}) — using procedural city`)
      } finally {
        if (osmAbortRef.current === ctrl) osmAbortRef.current = null
        setOsmLoading(null)
      }
    },
    [installCity],
  )

  const cancelOsm = useCallback(() => {
    osmAbortRef.current?.abort()
    osmAbortRef.current = null
    setOsmLoading(null)
    setOsmNote("Fetch cancelled — keeping the current city")
  }, [])

  // Once the map is ready, upgrade the initial procedural placeholder to real
  // OpenStreetMap data for the default location (no camera move).
  const didInitOsm = useRef(false)
  useEffect(() => {
    if (didInitOsm.current) return
    let tries = 0
    const iv = setInterval(() => {
      if (loadedRef.current) {
        clearInterval(iv)
        didInitOsm.current = true
        if (uiRef.current.osm) relocateCity(DEFAULT_CENTER[0], DEFAULT_CENTER[1], false)
      } else if (++tries > 100) {
        clearInterval(iv)
      }
    }, 100)
    return () => clearInterval(iv)
  }, [relocateCity])

  // ---------- geo file imports ----------
  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (!files.length) return
    setImporting(true)
    setImportError(null)
    try {
      const layers = await importGeoFiles(files)
      const m = mapRef.current
      const entries: ImportEntry[] = layers.map((layer) => {
        const id = importIdRef.current++
        const color = `hsl(${(id * 67) % 360}, 85%, 60%)`
        if (m && loadedRef.current) {
          m.addSource(`imp-${id}`, { type: "geojson", data: layer.fc })
          const before = m.getLayer(IMPORT_ANCHOR) ? IMPORT_ANCHOR : undefined
          m.addLayer({
            id: `imp-${id}-fill`, type: "fill", source: `imp-${id}`,
            filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
            paint: { "fill-color": color, "fill-opacity": 0.3 },
          }, before)
          m.addLayer({
            id: `imp-${id}-line`, type: "line", source: `imp-${id}`,
            paint: { "line-color": color, "line-width": 2.2 },
          }, before)
          m.addLayer({
            id: `imp-${id}-circle`, type: "circle", source: `imp-${id}`,
            filter: ["any", ["==", ["geometry-type"], "Point"], ["==", ["geometry-type"], "MultiPoint"]],
            paint: { "circle-color": color, "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
          }, before)
        }
        return { ...layer, id, color, visible: true, anim: "none" as ImportAnim }
      })
      setImports((prev) => [...prev, ...entries])
      const withBounds = entries.find((e) => e.bounds)
      if (withBounds?.bounds && m) m.fitBounds(withBounds.bounds, { padding: 80, maxZoom: 17, duration: 1200 })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [])

  const toggleImport = (id: number) => {
    setImports((prev) =>
      prev.map((entry) => {
        if (entry.id !== id) return entry
        const visible = !entry.visible
        const m = mapRef.current
        if (m) {
          for (const suffix of IMPORT_SUFFIXES) {
            const lid = `imp-${id}-${suffix}`
            if (m.getLayer(lid)) m.setLayoutProperty(lid, "visibility", visible ? "visible" : "none")
          }
        }
        return { ...entry, visible }
      }),
    )
  }

  const removeImport = (id: number) => {
    const m = mapRef.current
    if (m) {
      for (const suffix of IMPORT_SUFFIXES) {
        const lid = `imp-${id}-${suffix}`
        if (m.getLayer(lid)) m.removeLayer(lid)
      }
      if (m.getSource(`imp-${id}`)) m.removeSource(`imp-${id}`)
    }
    importAnimRef.current = importAnimRef.current.filter((e) => e.id !== id)
    setImports((prev) => prev.filter((entry) => entry.id !== id))
  }

  // Attach/detach animation effect layers for an imported layer.
  const setImportAnim = (id: number, anim: ImportAnim) => {
    const m = mapRef.current
    const color = imports.find((e) => e.id === id)?.color ?? "#22d3ee"
    if (m) {
      const lineId = `imp-${id}-line`
      const glowId = `imp-${id}-glow`
      const circId = `imp-${id}-circle`
      const extId = `imp-${id}-extrude`
      // Tear down any previous effect and reset base paint.
      if (m.getLayer(glowId)) m.removeLayer(glowId)
      if (m.getLayer(extId)) m.removeLayer(extId)
      if (m.getLayer(lineId)) m.setPaintProperty(lineId, "line-dasharray", null)
      if (m.getLayer(circId)) {
        m.setPaintProperty(circId, "circle-radius", 5)
        m.setPaintProperty(circId, "circle-opacity", 1)
      }
      if (anim === "flow" && m.getLayer(lineId)) {
        m.addLayer(
          { id: glowId, type: "line", source: `imp-${id}`, paint: { "line-color": color, "line-width": 11, "line-blur": 6, "line-opacity": 0.3 } },
          lineId,
        )
      }
      if (anim === "extrude") {
        const before = m.getLayer(IMPORT_ANCHOR) ? IMPORT_ANCHOR : undefined
        m.addLayer(
          {
            id: extId, type: "fill-extrusion", source: `imp-${id}`,
            filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
            paint: {
              "fill-extrusion-color": color,
              "fill-extrusion-opacity": 0.5,
              "fill-extrusion-height": ["case", ["has", "height"], ["to-number", ["get", "height"]], 40],
              "fill-extrusion-base": 0,
            },
          },
          before,
        )
      }
    }
    setImports((prev) => prev.map((e) => (e.id === id ? { ...e, anim } : e)))
  }

  const zoomToImport = (entry: ImportEntry) => {
    if (entry.bounds && mapRef.current) mapRef.current.fitBounds(entry.bounds, { padding: 80, maxZoom: 17, duration: 1200 })
  }

  const buildAtImport = (entry: ImportEntry) => {
    const b = entry.bounds
    if (b) relocateCity((b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2)
  }

  const resetView = () => {
    mapRef.current?.flyTo({ center: centerRef.current, zoom: 15.1, pitch: 48, bearing: -12, duration: 1400 })
  }

  // ---------- place search ----------
  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchError(null)
    setResults([])
    try {
      const r = await geocode(searchQuery)
      setResults(r)
      if (!r.length) setSearchError("No matches found")
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setSearching(false)
    }
  }, [searchQuery])

  const pickResult = (r: GeocodeResult, build: boolean) => {
    setResults([])
    setSearchQuery(r.name.split(",")[0])
    const m = mapRef.current
    if (!m) return
    if (build) {
      relocateCity(r.lng, r.lat)
    } else if (r.bbox) {
      m.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 60, maxZoom: 16, duration: 1500 })
    } else {
      m.flyTo({ center: [r.lng, r.lat], zoom: 14, duration: 1500 })
    }
  }

  useEffect(() => {
    if (!importError) return
    const t = setTimeout(() => setImportError(null), 8000)
    return () => clearTimeout(t)
  }, [importError])

  const phase = dayPhase(clock.hour)
  const set = <K extends keyof UiState>(key: K, value: UiState[K]) => setUi((prev) => ({ ...prev, [key]: value }))

  const Toggle = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <label className="flex cursor-pointer items-center justify-between gap-2 py-0.5 text-xs text-slate-300">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 rounded-full transition-colors ${value ? "bg-cyan-500" : "bg-slate-600"}`}
        aria-pressed={value}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  )

  return (
    <div
      className="relative h-screen w-full overflow-hidden bg-slate-950"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      <div ref={containerRef} className="h-full w-full" />

      {/* Night vignette overlay */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: clock.night * 0.35,
          background: "radial-gradient(ellipse at center, transparent 40%, #02040c 100%)",
        }}
      />

      {/* OSM loading overlay */}
      {osmLoading && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-cyan-500/40 bg-slate-900/90 px-6 py-4 text-center shadow-2xl backdrop-blur">
          <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          <div className="text-sm font-semibold text-cyan-200">{osmLoading}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">OpenStreetMap · Overpass API</div>
          <button
            onClick={cancelOsm}
            className="pointer-events-auto mt-2 rounded-md border border-slate-600 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Drag-and-drop hint */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-2xl border-4 border-dashed border-cyan-400 bg-cyan-500/10">
          <div className="rounded-xl bg-slate-900/90 px-6 py-4 text-lg font-semibold text-cyan-300">
            Drop GeoJSON / KML / KMZ / Shapefile (.zip or .shp+.dbf)
          </div>
        </div>
      )}

      {/* Search bar */}
      <div className="absolute left-1/2 top-4 z-20 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-900/85 px-3 py-2 shadow-xl backdrop-blur">
          <span className="text-slate-400">🔍</span>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search a place or address…"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={runSearch}
            disabled={searching}
            className="rounded-md bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {searching ? "…" : "Go"}
          </button>
        </div>
        {(results.length > 0 || searchError) && (
          <div className="mt-1 overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/95 shadow-2xl backdrop-blur">
            {searchError && <div className="px-3 py-2 text-xs text-amber-300">{searchError}</div>}
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 last:border-0 hover:bg-slate-800/60">
                <button onClick={() => pickResult(r, false)} className="min-w-0 flex-1 text-left" title={r.name}>
                  <div className="truncate text-xs text-slate-200">{r.name.split(",")[0]}</div>
                  <div className="truncate text-[10px] text-slate-500">
                    {r.kind} · {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                  </div>
                </button>
                <button
                  onClick={() => pickResult(r, true)}
                  className="shrink-0 rounded-md bg-emerald-600/90 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500"
                  title="Generate the simulation at this location"
                >
                  Build here
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Follow-mode chip */}
      {following && (
        <div className="absolute left-1/2 top-[4.5rem] z-20 -translate-x-1/2 rounded-full border border-cyan-500/50 bg-cyan-950/90 px-4 py-1 font-mono text-xs text-cyan-300 shadow-lg backdrop-blur">
          ◉ FOLLOWING {following} — click empty map or drag to release
        </div>
      )}

      {/* Stats + coordinate readout */}
      <div className="absolute bottom-10 left-4 z-20 rounded-lg border border-slate-700/60 bg-slate-900/80 px-4 py-2 font-mono text-[11px] leading-5 text-slate-300 shadow-xl backdrop-blur">
        <div>
          <span className="text-cyan-400">AGENTS</span> car {stats.counts.car} · taxi {stats.counts.taxi} · bus {stats.counts.bus} · truck {stats.counts.truck} · ped {ui.pedCount}
        </div>
        <div>
          <span className="text-cyan-400">AVG SPEED</span> {stats.avgKmh.toFixed(1)} km/h · <span className="text-cyan-400">FPS</span> {stats.fps}
        </div>
        <div>
          <span className="text-cyan-400">LAT/LNG</span> {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} · <span className="text-cyan-400">Z</span> {coords.zoom.toFixed(1)}
        </div>
      </div>

      {/* HUD: clock + phase */}
      <div className="absolute bottom-4 right-4 z-20 rounded-xl border border-slate-700/60 bg-slate-900/80 px-4 py-1.5 text-center shadow-xl backdrop-blur">
        <span className="font-mono text-lg font-bold tabular-nums text-cyan-300">{formatClock(clock.hour)}</span>
        <span className="ml-2 text-[11px] uppercase tracking-widest text-slate-400">
          {phase.icon} {phase.label}
        </span>
      </div>

      {/* Control panel */}
      <div className="absolute right-4 top-4 z-20 max-h-[calc(100vh-2rem)] w-72 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/85 p-4 text-slate-200 shadow-2xl backdrop-blur">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-cyan-300">Simulation</h2>
          <button
            onClick={() => set("playing", !ui.playing)}
            className={`rounded-md px-3 py-1 text-xs font-semibold ${ui.playing ? "bg-amber-500/90 text-slate-900" : "bg-emerald-500 text-slate-900"}`}
          >
            {ui.playing ? "❚❚ Pause" : "▶ Play"}
          </button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">
          Vehicles: <span className="font-mono text-slate-200">{ui.vehicleCount}</span>
        </label>
        <input type="range" min={0} max={220} value={ui.vehicleCount} onChange={(e) => set("vehicleCount", +e.target.value)} className="mb-3 w-full accent-cyan-400" />

        <label className="mb-1 block text-xs text-slate-400">
          Pedestrians: <span className="font-mono text-slate-200">{ui.pedCount}</span>
        </label>
        <input type="range" min={0} max={150} value={ui.pedCount} onChange={(e) => set("pedCount", +e.target.value)} className="mb-3 w-full accent-cyan-400" />

        <label className="mb-1 block text-xs text-slate-400">
          Sim speed: <span className="font-mono text-slate-200">{ui.simSpeed.toFixed(2)}×</span>
        </label>
        <input type="range" min={0.25} max={5} step={0.25} value={ui.simSpeed} onChange={(e) => set("simSpeed", +e.target.value)} className="mb-1 w-full accent-cyan-400" />
        <p className="mb-3 text-[10px] text-slate-500">Tip: click any vehicle to follow it with the camera.</p>

        <div className="mb-3 border-t border-slate-700/60 pt-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-cyan-300">Basemap & Location</h3>
          <div className="mb-2 grid grid-cols-3 gap-1">
            {BASEMAPS.map((b) => (
              <button
                key={b.id}
                onClick={() => setUi((prev) => ({ ...prev, basemap: b.id, groundOpacity: b.imagery ? 0.4 : 1 }))}
                className={`rounded-md px-1.5 py-1 text-[10px] font-semibold ${ui.basemap === b.id ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {b.name}
              </button>
            ))}
          </div>
          <label className="mb-1 block text-xs text-slate-400">
            City ground opacity: <span className="font-mono text-slate-200">{Math.round(ui.groundOpacity * 100)}%</span>
          </label>
          <input type="range" min={0} max={1} step={0.05} value={ui.groundOpacity} onChange={(e) => set("groundOpacity", +e.target.value)} className="mb-2 w-full accent-cyan-400" />
          <Toggle label="Real buildings & roads (OSM)" value={ui.osm} onChange={(v) => set("osm", v)} />
          <label className="mb-1 mt-1 block text-xs text-slate-400">
            OSM area radius: <span className="font-mono text-slate-200">{ui.osmRadius} m</span>
          </label>
          <input type="range" min={250} max={900} step={50} value={ui.osmRadius} onChange={(e) => set("osmRadius", +e.target.value)} className="mb-2 w-full accent-cyan-400" />
          <button
            onClick={() => {
              const c = mapRef.current?.getCenter()
              if (c) relocateCity(c.lng, c.lat, false)
            }}
            disabled={!!osmLoading}
            className="w-full rounded-md bg-emerald-600 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {osmLoading ? "Loading…" : ui.osm ? "⟳ Rebuild from real data here" : "⟳ Rebuild city at map center"}
          </button>
          {osmNote && <p className="mt-1 text-[10px] leading-4 text-slate-500">{osmNote}</p>}
        </div>

        <div className="mb-3 border-t border-slate-700/60 pt-3">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-cyan-300">Day / Night</h3>
          <Toggle label="Auto day-night cycle" value={ui.autoCycle} onChange={(v) => set("autoCycle", v)} />
          <label className="mb-1 mt-1 block text-xs text-slate-400">
            Time of day: <span className="font-mono text-slate-200">{formatClock(ui.hour)}</span>
          </label>
          <input type="range" min={0} max={23.99} step={0.05} value={ui.hour} onChange={(e) => set("hour", +e.target.value)} className="mb-2 w-full accent-amber-400" />
          <label className="mb-1 block text-xs text-slate-400">
            Day length: <span className="font-mono text-slate-200">{ui.dayLengthSec}s</span>
          </label>
          <input type="range" min={30} max={600} step={10} value={ui.dayLengthSec} onChange={(e) => set("dayLengthSec", +e.target.value)} className="w-full accent-amber-400" />
        </div>

        <div className="mb-3 border-t border-slate-700/60 pt-3">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-cyan-300">Layers</h3>
          <Toggle label="Detection boxes" value={ui.showBoxes} onChange={(v) => set("showBoxes", v)} />
          <Toggle label="Detection labels" value={ui.showLabels} onChange={(v) => set("showLabels", v)} />
          <Toggle label="Vehicle tracks" value={ui.showTrails} onChange={(v) => set("showTrails", v)} />
          <Toggle label="Census tracts" value={ui.showTracts} onChange={(v) => set("showTracts", v)} />
          <Toggle label="3D buildings" value={ui.show3d} onChange={(v) => set("show3d", v)} />
          <Toggle label="Traffic signals" value={ui.showSignals} onChange={(v) => set("showSignals", v)} />
          <Toggle label="Streetlights" value={ui.showStreetlights} onChange={(v) => set("showStreetlights", v)} />
        </div>

        <div className="border-t border-slate-700/60 pt-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-cyan-300">Data Import</h3>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="mb-2 w-full rounded-md bg-cyan-600 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {importing ? "Parsing…" : "Add Shapefile / KML / KMZ / GeoJSON"}
          </button>
          <p className="mb-2 text-[10px] leading-4 text-slate-500">
            Or drag files onto the map. Shapefiles: drop a .zip, or select .shp + .dbf together.
          </p>
          {importError && <div className="mb-2 rounded-md bg-red-500/15 px-2 py-1.5 text-[11px] text-red-300">{importError}</div>}
          {imports.map((entry) => (
            <div key={entry.id} className="mb-1.5 rounded-md bg-slate-800/70 px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: entry.color }} />
                <button onClick={() => toggleImport(entry.id)} className={`min-w-0 flex-1 truncate text-left ${entry.visible ? "text-slate-200" : "text-slate-500 line-through"}`} title={`${entry.name} (${entry.fc.features.length} features) — click to toggle`}>
                  {entry.name}
                </button>
                <button onClick={() => zoomToImport(entry)} title="Zoom to layer" className="text-slate-400 hover:text-cyan-300">⌖</button>
                <button onClick={() => removeImport(entry.id)} title="Remove layer" className="text-slate-400 hover:text-red-400">✕</button>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span className="text-[10px] text-slate-500">Animate:</span>
                <select
                  value={entry.anim}
                  onChange={(e) => setImportAnim(entry.id, e.target.value as ImportAnim)}
                  className="flex-1 rounded bg-slate-900 px-1 py-0.5 text-[10px] text-slate-200"
                >
                  <option value="none">None</option>
                  <option value="flow">Flowing glow (lines)</option>
                  <option value="pulse">Pulse (points)</option>
                  <option value="extrude">Extrude (polygons)</option>
                </select>
              </div>
              {entry.bounds && (
                <button onClick={() => buildAtImport(entry)} className="mt-1 w-full rounded bg-emerald-700/70 py-0.5 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-600">
                  Build simulation over this layer
                </button>
              )}
            </div>
          ))}
          <button onClick={resetView} className="mt-1 w-full rounded-md border border-slate-600 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
            Reset camera to city
          </button>
        </div>
      </div>
    </div>
  )
}
