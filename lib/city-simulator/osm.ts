// Real-world city model from OpenStreetMap via the Overpass API. Builds a
// drivable road graph (polyline edges, one-way handling, signalized nodes)
// plus extruded building footprints, parks and trees, in the same CityModel
// shape the procedural generator produces so the simulator is source-agnostic.

import type { CityConfig, CityModel, RoadEdge, RoadNode, Pt } from "./citygen"
import { polylineGeom, mulberry32 } from "./citygen"

const M_PER_DEG_LAT = 111320

const SPEED_LANES: Record<string, { speed: number; lanes: number; avenue: boolean }> = {
  motorway: { speed: 27, lanes: 2, avenue: true },
  motorway_link: { speed: 16, lanes: 1, avenue: false },
  trunk: { speed: 22, lanes: 2, avenue: true },
  trunk_link: { speed: 13, lanes: 1, avenue: false },
  primary: { speed: 16, lanes: 2, avenue: true },
  primary_link: { speed: 11, lanes: 1, avenue: false },
  secondary: { speed: 14, lanes: 2, avenue: true },
  secondary_link: { speed: 10, lanes: 1, avenue: false },
  tertiary: { speed: 12, lanes: 1, avenue: false },
  tertiary_link: { speed: 9, lanes: 1, avenue: false },
  unclassified: { speed: 10, lanes: 1, avenue: false },
  residential: { speed: 9, lanes: 1, avenue: false },
  living_street: { speed: 6, lanes: 1, avenue: false },
  service: { speed: 6, lanes: 1, avenue: false },
  road: { speed: 9, lanes: 1, avenue: false },
}
const DRIVABLE = new Set(Object.keys(SPEED_LANES))

interface OSMNode {
  type: "node"
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}
interface OSMWay {
  type: "way"
  id: number
  nodes: number[]
  geometry?: { lat: number; lon: number }[]
  tags?: Record<string, string>
}
type OSMElement = OSMNode | OSMWay

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

/** Fetch buildings, roads, greenspace, signals and trees around a point. */
export async function fetchOSM(lng: number, lat: number, radiusM: number, signal?: AbortSignal): Promise<OSMElement[]> {
  const dLat = radiusM / M_PER_DEG_LAT
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
  const bbox = `(${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng})`
  const q =
    `[out:json][timeout:40];(` +
    `way["highway"]${bbox};` +
    `way["building"]${bbox};` +
    `way["leisure"~"^(park|garden|playground|pitch|recreation_ground|golf_course)$"]${bbox};` +
    `way["landuse"~"^(grass|forest|meadow|cemetery)$"]${bbox};` +
    `way["natural"~"^(wood|scrub|grassland)$"]${bbox};` +
    `node["highway"="traffic_signals"]${bbox};` +
    `node["natural"="tree"]${bbox};` +
    `);out geom;`
  let lastErr: unknown
  // Two rounds over the mirrors; Overpass 429/504 "slot busy" is transient.
  for (let round = 0; round < 2; round++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(q), signal })
        if (!res.ok) throw new Error(`Overpass ${res.status}`)
        const json = (await res.json()) as { elements?: OSMElement[] }
        return json.elements ?? []
      } catch (err) {
        if (signal?.aborted) throw err
        lastErr = err
      }
    }
    if (round === 0) await new Promise((r) => setTimeout(r, 1500))
  }
  throw lastErr instanceof Error ? lastErr : new Error("Overpass request failed")
}

function parseMaxspeed(v: string): number | null {
  const m = v.match(/(\d+(?:\.\d+)?)\s*(mph)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] ? n * 0.44704 : n / 3.6
}

function specForWay(tags: Record<string, string>) {
  const base = SPEED_LANES[tags.highway] ?? { speed: 9, lanes: 1, avenue: false }
  let speed = base.speed
  if (tags.maxspeed) {
    const m = parseMaxspeed(tags.maxspeed)
    if (m && m > 1) speed = m
  }
  return { speed, lanes: base.lanes, avenue: base.avenue }
}

function onewayDir(tags: Record<string, string>): 0 | 1 | -1 {
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1
  const o = tags.oneway
  if (o === "yes" || o === "true" || o === "1") return 1
  if (o === "-1" || o === "reverse") return -1
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return 1
  return 0
}

function parseHeight(tags: Record<string, string>, rng: () => number): { height: number; base: number } {
  let height = 0
  if (tags.height) height = parseFloat(tags.height)
  else if (tags["building:levels"]) height = parseFloat(tags["building:levels"]) * 3.2
  if (!height || !isFinite(height)) height = 8 + rng() * 20
  let base = 0
  if (tags.min_height) base = parseFloat(tags.min_height)
  else if (tags["building:min_level"]) base = parseFloat(tags["building:min_level"]) * 3.2
  return { height: Math.max(3, Math.round(height)), base: isFinite(base) ? base : 0 }
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features })
const ringClosed = (coords: [number, number][]): [number, number][] => {
  if (coords.length < 3) return coords
  const [fx, fy] = coords[0]
  const [lx, ly] = coords[coords.length - 1]
  return fx === lx && fy === ly ? coords : [...coords, coords[0]]
}

export interface OSMBuildResult {
  city: CityModel
  stats: { roads: number; nodes: number; buildings: number; signals: number }
}

/**
 * Assemble a CityModel from raw Overpass elements. Throws if the area has too
 * little road data to simulate (caller should fall back to procedural).
 */
export function buildCityFromOSM(centerLng: number, centerLat: number, seed: number, elements: OSMElement[]): OSMBuildResult {
  const rng = mulberry32(seed)
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180)
  const toXY = (lon: number, la: number): Pt => ({ x: (lon - centerLng) * mPerDegLng, y: (la - centerLat) * M_PER_DEG_LAT })
  const toLngLat = (x: number, y: number): [number, number] => [centerLng + x / mPerDegLng, centerLat + y / M_PER_DEG_LAT]

  const ways = elements.filter((e): e is OSMWay => e.type === "way" && !!e.geometry && e.geometry.length >= 2)
  const pointNodes = elements.filter((e): e is OSMNode => e.type === "node")
  const signalIds = new Set(pointNodes.filter((n) => n.tags?.highway === "traffic_signals").map((n) => n.id))

  const roadWays = ways.filter((w) => w.tags?.highway && DRIVABLE.has(w.tags.highway) && w.nodes.length === w.geometry!.length)

  // A node splits ways into edges if it is a shared junction, a way endpoint,
  // or carries a traffic signal.
  const useCount = new Map<number, number>()
  for (const w of roadWays) for (const id of w.nodes) useCount.set(id, (useCount.get(id) ?? 0) + 1)
  const isSplit = (nodeId: number, idx: number, len: number) =>
    idx === 0 || idx === len - 1 || (useCount.get(nodeId) ?? 0) >= 2 || signalIds.has(nodeId)

  const nodeMap = new Map<number, number>() // osm node id -> graph node index
  const giToOsm = new Map<number, number>()
  const gnodes: RoadNode[] = []
  const ensureNode = (osmId: number, x: number, y: number): number => {
    let gi = nodeMap.get(osmId)
    if (gi === undefined) {
      gi = gnodes.length
      nodeMap.set(osmId, gi)
      giToOsm.set(gi, osmId)
      gnodes.push({ id: gi, i: 0, j: 0, x, y, hasLight: false, lightOffset: Math.floor(rng() * 30) })
    }
    return gi
  }

  const edges: RoadEdge[] = []
  const revMap = new Map<number, number>()
  const addEdge = (from: number, to: number, pts: Pt[], spec: { speed: number; lanes: number; avenue: boolean }): RoadEdge | null => {
    const g = polylineGeom(pts)
    if (g.length < 1) return null
    const e: RoadEdge = {
      id: edges.length, from, to, pts, cum: g.cum, length: g.length,
      bearingStart: g.bearingStart, bearingEnd: g.bearingEnd,
      lanes: spec.lanes, speedLimit: spec.speed, avenue: spec.avenue,
    }
    edges.push(e)
    return e
  }

  for (const w of roadWays) {
    const spec = specForWay(w.tags!)
    const dir = onewayDir(w.tags!)
    const geom = w.geometry!
    const ids = w.nodes
    let startIdx = 0
    for (let i = 1; i < ids.length; i++) {
      if (!isSplit(ids[i], i, ids.length)) continue
      const segPts: Pt[] = []
      for (let k = startIdx; k <= i; k++) segPts.push(toXY(geom[k].lon, geom[k].lat))
      const aGi = ensureNode(ids[startIdx], segPts[0].x, segPts[0].y)
      const bGi = ensureNode(ids[i], segPts[segPts.length - 1].x, segPts[segPts.length - 1].y)
      if (aGi !== bGi && segPts.length >= 2) {
        const fwd = dir >= 0 ? addEdge(aGi, bGi, segPts, spec) : null
        const bwd = dir <= 0 ? addEdge(bGi, aGi, segPts.slice().reverse(), spec) : null
        if (fwd && bwd) {
          revMap.set(fwd.id, bwd.id)
          revMap.set(bwd.id, fwd.id)
        }
      }
      startIdx = i
    }
  }

  if (edges.length < 8) throw new Error("Not enough road data at this location — try a denser area.")

  // Keep only the largest connected component so agents never get trapped.
  const parent = gnodes.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (const e of edges) {
    const ra = find(e.from)
    const rb = find(e.to)
    if (ra !== rb) parent[ra] = rb
  }
  const compSize = new Map<number, number>()
  for (let i = 0; i < gnodes.length; i++) {
    const r = find(i)
    compSize.set(r, (compSize.get(r) ?? 0) + 1)
  }
  let best = -1
  let bestSize = -1
  for (const [r, sz] of compSize) if (sz > bestSize) [best, bestSize] = [r, sz]
  const keep = (gi: number) => find(gi) === best

  // Reindex kept nodes and edges into a compact model.
  const nodeRemap = new Map<number, number>()
  const nodes: RoadNode[] = []
  for (let gi = 0; gi < gnodes.length; gi++) {
    if (!keep(gi)) continue
    const nid = nodes.length
    nodeRemap.set(gi, nid)
    const osmId = giToOsm.get(gi)
    nodes.push({ ...gnodes[gi], id: nid, hasLight: osmId !== undefined && signalIds.has(osmId) })
  }
  const keptEdgeIds = edges.filter((e) => keep(e.from) && keep(e.to)).map((e) => e.id)
  const edgeRemap = new Map<number, number>()
  const finalEdges: RoadEdge[] = []
  for (const oldId of keptEdgeIds) {
    const e = edges[oldId]
    const nid = finalEdges.length
    edgeRemap.set(oldId, nid)
    finalEdges.push({ ...e, id: nid, from: nodeRemap.get(e.from)!, to: nodeRemap.get(e.to)! })
  }
  const reverseEdge = finalEdges.map((_, newId) => {
    const revOld = revMap.get(keptEdgeIds[newId])
    return revOld !== undefined && edgeRemap.has(revOld) ? edgeRemap.get(revOld)! : -1
  })
  const outgoing: number[][] = nodes.map(() => [])
  for (const e of finalEdges) outgoing[e.from].push(e.id)

  // Bus stops on longer arterials.
  const busStops = new Map<number, number>()
  const busStopFeatures: GeoJSON.Feature[] = []
  for (const e of finalEdges) {
    if (!e.avenue || e.length < 90 || rng() > 0.35) continue
    const s = e.length * (0.4 + rng() * 0.25)
    busStops.set(e.id, s)
    const seg = sampleAlong(e, s)
    busStopFeatures.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: toLngLat(seg.x + seg.hy * 5, seg.y - seg.hx * 5) } })
  }

  // Streetlights sampled along every edge, alternating curb side.
  const streetlightFeatures: GeoJSON.Feature[] = []
  let flip = false
  for (const e of finalEdges) {
    if (reverseEdge[e.id] >= 0 && e.id > reverseEdge[e.id]) continue // once per undirected road
    const n = Math.floor(e.length / 42)
    for (let k = 1; k < n; k++) {
      flip = !flip
      const seg = sampleAlong(e, (e.length * k) / n)
      const off = (e.avenue ? 9 : 6) * (flip ? 1 : -1)
      streetlightFeatures.push({
        type: "Feature",
        properties: { th: rng() },
        geometry: { type: "Point", coordinates: toLngLat(seg.x + seg.hy * off, seg.y - seg.hx * off) },
      })
    }
  }

  // Roads (one LineString per undirected road) for rendering.
  const roadFeatures: GeoJSON.Feature[] = []
  for (const e of finalEdges) {
    if (reverseEdge[e.id] >= 0 && e.id > reverseEdge[e.id]) continue
    roadFeatures.push({
      type: "Feature",
      properties: { avenue: e.avenue ? 1 : 0 },
      geometry: { type: "LineString", coordinates: e.pts.map((p) => toLngLat(p.x, p.y)) },
    })
  }

  // Buildings with heights; track the tallest for the beacon.
  const buildingFeatures: GeoJSON.Feature[] = []
  let beacon = { x: 0, y: 0, height: 0 }
  for (const w of ways) {
    if (!w.tags?.building) continue
    const coords = ringClosed(w.geometry!.map((p) => [p.lon, p.lat] as [number, number]))
    if (coords.length < 4) continue
    const { height, base } = parseHeight(w.tags, rng)
    buildingFeatures.push({ type: "Feature", properties: { height, minHeight: base }, geometry: { type: "Polygon", coordinates: [coords] } })
    if (height > beacon.height) {
      const c = toXY(w.geometry![0].lon, w.geometry![0].lat)
      beacon = { x: c.x, y: c.y, height }
    }
  }

  // Parks / greenspace polygons and trees.
  const parkFeatures: GeoJSON.Feature[] = []
  for (const w of ways) {
    const t = w.tags
    if (!t) continue
    const green = t.leisure || t.landuse || t.natural
    if (!green || t.building || t.highway) continue
    const coords = ringClosed(w.geometry!.map((p) => toLngLat(p.lon, p.lat) as [number, number]))
    if (coords.length < 4) continue
    parkFeatures.push({ type: "Feature", properties: { park: 1 }, geometry: { type: "Polygon", coordinates: [coords] } })
  }
  const treeFeatures: GeoJSON.Feature[] = pointNodes
    .filter((n) => n.tags?.natural === "tree")
    .map((n) => ({ type: "Feature", properties: { r: 2 + rng() * 3 }, geometry: { type: "Point", coordinates: [n.lon, n.lat] } }))

  const config: CityConfig = { centerLng, centerLat, blocksX: 0, blocksY: 0, seed }
  const city: CityModel = {
    config,
    nodes,
    edges: finalEdges,
    outgoing,
    reverseEdge,
    busStops,
    toLngLat,
    nodePos: (id: number) => ({ x: nodes[id].x, y: nodes[id].y }),
    beacon,
    geo: {
      roads: fc(roadFeatures),
      blocks: fc([]),
      parks: fc(parkFeatures),
      buildings: fc(buildingFeatures),
      tracts: fc([]),
      tractLabels: fc([]),
      streetlights: fc(streetlightFeatures),
      trees: fc(treeFeatures),
      crosswalks: fc([]),
      busStops: fc(busStopFeatures),
    },
  }
  return {
    city,
    stats: { roads: roadFeatures.length, nodes: nodes.length, buildings: buildingFeatures.length, signals: nodes.filter((n) => n.hasLight).length },
  }
}

// Local copy of the polyline sampler (kept here to avoid importing the sim).
function sampleAlong(edge: RoadEdge, s: number): { x: number; y: number; hx: number; hy: number } {
  const { pts, cum } = edge
  const sc = Math.max(0, Math.min(edge.length, s))
  let i = 1
  while (i < cum.length - 1 && cum[i] < sc) i++
  const segLen = cum[i] - cum[i - 1] || 1
  const t = (sc - cum[i - 1]) / segLen
  const a = pts[i - 1]
  const b = pts[i]
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, hx: (b.x - a.x) / segLen, hy: (b.y - a.y) / segLen }
}
