// Procedural city block generator: road grid, blocks, buildings, parks,
// census-style tracts, streetlights and traffic-light intersections.
// All geometry is generated in local meters and projected to lng/lat.

export type LngLat = [number, number]

export interface CityConfig {
  centerLng: number
  centerLat: number
  blocksX: number
  blocksY: number
  seed: number
}

export interface RoadNode {
  id: number
  i: number
  j: number
  x: number
  y: number
  hasLight: boolean
  lightOffset: number // seconds offset into the signal cycle
}

export interface RoadEdge {
  id: number
  from: number
  to: number
  axis: "h" | "v" // horizontal = east/west travel, vertical = north/south
  sign: 1 | -1 // +1 = east or north, -1 = west or south
  length: number
  lanes: number
  speedLimit: number // m/s
  avenue: boolean
}

export interface CityModel {
  config: CityConfig
  nodes: RoadNode[]
  edges: RoadEdge[]
  outgoing: number[][] // node id -> edge ids leaving that node
  reverseEdge: number[] // edge id -> opposite-direction edge id
  busStops: Map<number, number> // edge id -> stop position (meters along edge)
  toLngLat: (x: number, y: number) => LngLat
  nodePos: (id: number) => { x: number; y: number }
  beacon: { x: number; y: number; height: number }
  geo: {
    roads: GeoJSON.FeatureCollection
    blocks: GeoJSON.FeatureCollection
    parks: GeoJSON.FeatureCollection
    buildings: GeoJSON.FeatureCollection
    tracts: GeoJSON.FeatureCollection
    tractLabels: GeoJSON.FeatureCollection
    streetlights: GeoJSON.FeatureCollection
    trees: GeoJSON.FeatureCollection
    crosswalks: GeoJSON.FeatureCollection
    busStops: GeoJSON.FeatureCollection
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const M_PER_DEG_LAT = 111320

export function generateCity(config: CityConfig): CityModel {
  const rng = mulberry32(config.seed)
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((config.centerLat * Math.PI) / 180)
  const toLngLat = (x: number, y: number): LngLat => [
    config.centerLng + x / mPerDegLng,
    config.centerLat + y / M_PER_DEG_LAT,
  ]

  // Street center-line coordinates with jittered spacing. Every 3rd street is
  // a wider, faster avenue.
  const nx = config.blocksX + 1
  const ny = config.blocksY + 1
  const xs: number[] = [0]
  for (let i = 1; i < nx; i++) xs.push(xs[i - 1] + 105 + rng() * 55)
  const ys: number[] = [0]
  for (let j = 1; j < ny; j++) ys.push(ys[j - 1] + 95 + rng() * 50)
  const cx = (xs[0] + xs[nx - 1]) / 2
  const cy = (ys[0] + ys[ny - 1]) / 2
  for (let i = 0; i < nx; i++) xs[i] -= cx
  for (let j = 0; j < ny; j++) ys[j] -= cy
  const isAvenueX = (i: number) => i % 3 === 0
  const isAvenueY = (j: number) => j % 3 === 0
  const halfW = (avenue: boolean) => (avenue ? 9 : 5.5)

  // Nodes
  const nodes: RoadNode[] = []
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const interior = i > 0 && i < nx - 1 && j > 0 && j < ny - 1
      nodes.push({
        id: j * nx + i,
        i,
        j,
        x: xs[i],
        y: ys[j],
        hasLight: interior,
        lightOffset: Math.floor(rng() * 30),
      })
    }
  }
  const nodeId = (i: number, j: number) => j * nx + i

  // Directed edges along the grid
  const edges: RoadEdge[] = []
  const outgoing: number[][] = nodes.map(() => [])
  const edgeKey = new Map<string, number>()
  const addEdge = (from: number, to: number, axis: "h" | "v", sign: 1 | -1, avenue: boolean) => {
    const a = nodes[from]
    const b = nodes[to]
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    const e: RoadEdge = {
      id: edges.length,
      from,
      to,
      axis,
      sign,
      length,
      lanes: avenue ? 2 : 1,
      speedLimit: avenue ? 15 : 10.5,
      avenue,
    }
    edges.push(e)
    outgoing[from].push(e.id)
    edgeKey.set(`${from}-${to}`, e.id)
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const av = isAvenueY(j)
      addEdge(nodeId(i, j), nodeId(i + 1, j), "h", 1, av)
      addEdge(nodeId(i + 1, j), nodeId(i, j), "h", -1, av)
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const av = isAvenueX(i)
      addEdge(nodeId(i, j), nodeId(i, j + 1), "v", 1, av)
      addEdge(nodeId(i, j + 1), nodeId(i, j), "v", -1, av)
    }
  }
  const reverseEdge = edges.map((e) => edgeKey.get(`${e.to}-${e.from}`)!)

  // ---- Static geometry ----
  const roadFeatures: GeoJSON.Feature[] = []
  for (let j = 0; j < ny; j++) {
    roadFeatures.push({
      type: "Feature",
      properties: { avenue: isAvenueY(j) ? 1 : 0 },
      geometry: { type: "LineString", coordinates: [toLngLat(xs[0], ys[j]), toLngLat(xs[nx - 1], ys[j])] },
    })
  }
  for (let i = 0; i < nx; i++) {
    roadFeatures.push({
      type: "Feature",
      properties: { avenue: isAvenueX(i) ? 1 : 0 },
      geometry: { type: "LineString", coordinates: [toLngLat(xs[i], ys[0]), toLngLat(xs[i], ys[ny - 1])] },
    })
  }

  const rect = (x0: number, y0: number, x1: number, y1: number): GeoJSON.Polygon => ({
    type: "Polygon",
    coordinates: [[toLngLat(x0, y0), toLngLat(x1, y0), toLngLat(x1, y1), toLngLat(x0, y1), toLngLat(x0, y0)]],
  })

  // Blocks, parks, buildings, trees
  const blockFeatures: GeoJSON.Feature[] = []
  const parkFeatures: GeoJSON.Feature[] = []
  const buildingFeatures: GeoJSON.Feature[] = []
  const treeFeatures: GeoJSON.Feature[] = []
  const maxR = Math.hypot(xs[nx - 1], ys[ny - 1])
  let beacon = { x: 0, y: 0, height: 0 }

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const x0 = xs[i] + halfW(isAvenueX(i)) + 3
      const x1 = xs[i + 1] - halfW(isAvenueX(i + 1)) - 3
      const y0 = ys[j] + halfW(isAvenueY(j)) + 3
      const y1 = ys[j + 1] - halfW(isAvenueY(j + 1)) - 3
      const isPark = rng() < 0.11
      const blockFeature: GeoJSON.Feature = {
        type: "Feature",
        properties: { park: isPark ? 1 : 0, bi: i, bj: j },
        geometry: rect(x0, y0, x1, y1),
      }
      if (isPark) {
        parkFeatures.push(blockFeature)
        const nTrees = 6 + Math.floor(rng() * 8)
        for (let t = 0; t < nTrees; t++) {
          treeFeatures.push({
            type: "Feature",
            properties: { r: 2 + rng() * 3 },
            geometry: { type: "Point", coordinates: toLngLat(x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)) },
          })
        }
        continue
      }
      blockFeatures.push(blockFeature)

      // Subdivide the block into building lots
      const lotsX = Math.max(1, Math.round((x1 - x0) / 42))
      const lotsY = Math.max(1, Math.round((y1 - y0) / 42))
      const bcx = (x0 + x1) / 2
      const bcy = (y0 + y1) / 2
      const falloff = 1 - Math.hypot(bcx, bcy) / (maxR * 0.72)
      for (let lj = 0; lj < lotsY; lj++) {
        for (let li = 0; li < lotsX; li++) {
          if (rng() < 0.12) continue // vacant lot / parking
          const lx0 = x0 + ((x1 - x0) * li) / lotsX + 3
          const lx1 = x0 + ((x1 - x0) * (li + 1)) / lotsX - 3
          const ly0 = y0 + ((y1 - y0) * lj) / lotsY + 3
          const ly1 = y0 + ((y1 - y0) * (lj + 1)) / lotsY - 3
          if (lx1 - lx0 < 8 || ly1 - ly0 < 8) continue
          const base = 8 + rng() * 14
          const tower = Math.max(0, falloff) ** 2 * (30 + rng() * 130)
          const height = Math.round(base + (rng() < 0.5 ? tower : tower * 0.3))
          if (height > beacon.height) beacon = { x: (lx0 + lx1) / 2, y: (ly0 + ly1) / 2, height }
          buildingFeatures.push({
            type: "Feature",
            properties: { height, minHeight: 0, glow: rng() },
            geometry: rect(lx0, ly0, lx1, ly1),
          })
        }
      }
    }
  }

  // Census-style tracts: partition the block grid into contiguous rectangular
  // groups with synthetic demographic data.
  const tractFeatures: GeoJSON.Feature[] = []
  const tractLabelFeatures: GeoJSON.Feature[] = []
  const splitsX = [0, Math.floor((nx - 1) / 3), Math.floor((2 * (nx - 1)) / 3), nx - 1]
  const splitsY = [0, Math.floor((ny - 1) / 2), ny - 1]
  let tractNum = 0
  for (let tj = 0; tj < splitsY.length - 1; tj++) {
    for (let ti = 0; ti < splitsX.length - 1; ti++) {
      tractNum++
      const x0 = xs[splitsX[ti]]
      const x1 = xs[splitsX[ti + 1]]
      const y0 = ys[splitsY[tj]]
      const y1 = ys[splitsY[tj + 1]]
      const areaKm2 = ((x1 - x0) * (y1 - y0)) / 1e6
      const population = Math.round(1800 + rng() * 6500)
      const density = Math.round(population / areaKm2)
      const medianIncome = Math.round(32000 + rng() * 88000)
      const tractId = `${9500 + tractNum}.0${tractNum}`
      tractFeatures.push({
        type: "Feature",
        properties: { tractId, population, density, medianIncome, areaKm2: +areaKm2.toFixed(3) },
        geometry: rect(x0, y0, x1, y1),
      })
      tractLabelFeatures.push({
        type: "Feature",
        properties: { tractId, density },
        geometry: { type: "Point", coordinates: toLngLat((x0 + x1) / 2, (y0 + y1) / 2) },
      })
    }
  }

  // Streetlights along every street, alternating sides
  const streetlightFeatures: GeoJSON.Feature[] = []
  let lightFlip = false
  const addLights = (ax: number, ay: number, bx: number, by: number, avenue: boolean) => {
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.floor(len / 45)
    const px = -(by - ay) / len
    const py = (bx - ax) / len
    for (let k = 1; k < n; k++) {
      lightFlip = !lightFlip
      const side = lightFlip ? 1 : -1
      const off = (halfW(avenue) + 1.5) * side
      const x = ax + ((bx - ax) * k) / n + px * off
      const y = ay + ((by - ay) * k) / n + py * off
      streetlightFeatures.push({
        type: "Feature",
        properties: { th: rng() }, // stagger threshold for dusk turn-on
        geometry: { type: "Point", coordinates: toLngLat(x, y) },
      })
    }
  }
  for (let j = 0; j < ny; j++) addLights(xs[0], ys[j], xs[nx - 1], ys[j], isAvenueY(j))
  for (let i = 0; i < nx; i++) addLights(xs[i], ys[0], xs[i], ys[ny - 1], isAvenueX(i))

  // Bus stops on avenue edges: buses pull up and dwell here. Marker sits on
  // the curb to the right of the direction of travel.
  const busStops = new Map<number, number>()
  const busStopFeatures: GeoJSON.Feature[] = []
  for (const e of edges) {
    if (!e.avenue || e.length < 100 || rng() > 0.45) continue
    const s = e.length * (0.4 + rng() * 0.25)
    busStops.set(e.id, s)
    const a = nodes[e.from]
    const b = nodes[e.to]
    const hx = (b.x - a.x) / e.length
    const hy = (b.y - a.y) / e.length
    const off = halfW(true) + 1.5
    busStopFeatures.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: toLngLat(a.x + hx * s + hy * off, a.y + hy * s - hx * off) },
    })
  }

  // Crosswalk stripes at signalized intersections
  const crosswalkFeatures: GeoJSON.Feature[] = []
  for (const n of nodes) {
    if (!n.hasLight) continue
    const wx = halfW(isAvenueX(n.i))
    const wy = halfW(isAvenueY(n.j))
    crosswalkFeatures.push(
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [toLngLat(n.x - wx - 2, n.y - wy - 2), toLngLat(n.x + wx + 2, n.y - wy - 2)] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [toLngLat(n.x - wx - 2, n.y + wy + 2), toLngLat(n.x + wx + 2, n.y + wy + 2)] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [toLngLat(n.x - wx - 2, n.y - wy - 2), toLngLat(n.x - wx - 2, n.y + wy + 2)] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [toLngLat(n.x + wx + 2, n.y - wy - 2), toLngLat(n.x + wx + 2, n.y + wy + 2)] } },
    )
  }

  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features })

  return {
    config,
    nodes,
    edges,
    outgoing,
    reverseEdge,
    busStops,
    toLngLat,
    nodePos: (id: number) => ({ x: nodes[id].x, y: nodes[id].y }),
    beacon,
    geo: {
      roads: fc(roadFeatures),
      blocks: fc(blockFeatures),
      parks: fc(parkFeatures),
      buildings: fc(buildingFeatures),
      tracts: fc(tractFeatures),
      tractLabels: fc(tractLabelFeatures),
      streetlights: fc(streetlightFeatures),
      trees: fc(treeFeatures),
      crosswalks: fc(crosswalkFeatures),
      busStops: fc(busStopFeatures),
    },
  }
}
