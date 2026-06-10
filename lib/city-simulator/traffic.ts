// Multi-agent traffic simulation over the generated road graph.
// Agents do simple car-following, obey signalized intersections, and pick
// turns at each node. Each frame the sim emits GeoJSON for vehicles,
// detection boxes, trails, headlight glows and traffic-light states.

import type { CityModel, RoadEdge } from "./citygen"
import { mulberry32 } from "./citygen"

export type VehicleKind = "car" | "taxi" | "bus" | "truck"

export interface Vehicle {
  id: number
  kind: VehicleKind
  edgeId: number
  lane: number
  s: number // distance along edge, meters
  speed: number // m/s
  len: number
  width: number
  color: string
  conf: number // detection confidence (random-walked for a live feel)
  trail: [number, number][]
  trailClock: number
  dwell: number // seconds remaining stopped at a bus stop
  servedStop: number // edge id of the last bus stop served (-1 = none)
}

const KIND_SPECS: Record<VehicleKind, { len: number; width: number; vmax: number; colors: string[] }> = {
  car: { len: 4.6, width: 1.9, vmax: 16, colors: ["#5ec8f2", "#e8eef5", "#9aa7b6", "#d6604d", "#7fc97f", "#c084fc"] },
  taxi: { len: 4.6, width: 1.9, vmax: 16, colors: ["#ffd23f"] },
  bus: { len: 11.5, width: 2.6, vmax: 11, colors: ["#4f86f7", "#3fb68b"] },
  truck: { len: 8.5, width: 2.5, vmax: 12, colors: ["#b0855b", "#8d99ae"] },
}

const BOX_COLORS: Record<VehicleKind, string> = {
  car: "#22d3ee",
  taxi: "#facc15",
  bus: "#a78bfa",
  truck: "#fb923c",
}

// Signal cycle: 14s NS green, 3s yellow, 14s EW green, 3s yellow = 34s
const CYCLE = 34
export type LightState = "g" | "y" | "r"

export class TrafficSim {
  city: CityModel
  vehicles: Vehicle[] = []
  simSeconds = 0
  private rng: () => number
  private nextId = 1

  constructor(city: CityModel, seed = 1234) {
    this.city = city
    this.rng = mulberry32(seed)
  }

  /** Signal state seen by traffic travelling on `axis` arriving at `nodeId`. */
  lightState(nodeId: number, axis: "h" | "v"): LightState {
    const node = this.city.nodes[nodeId]
    if (!node.hasLight) return "g"
    const t = (this.simSeconds + node.lightOffset) % CYCLE
    // First half of cycle: vertical (north/south) movement has the green.
    if (axis === "v") {
      if (t < 14) return "g"
      if (t < 17) return "y"
      return "r"
    }
    if (t < 17) return "r"
    if (t < 31) return "g"
    return "y"
  }

  setVehicleCount(n: number) {
    while (this.vehicles.length > n) this.vehicles.pop()
    let guard = 0
    while (this.vehicles.length < n && guard++ < n * 20) {
      const v = this.spawn()
      if (v) this.vehicles.push(v)
    }
  }

  private spawn(): Vehicle | null {
    const r = this.rng()
    const kind: VehicleKind = r < 0.62 ? "car" : r < 0.78 ? "taxi" : r < 0.9 ? "truck" : "bus"
    const spec = KIND_SPECS[kind]
    const edge = this.city.edges[Math.floor(this.rng() * this.city.edges.length)]
    const lane = edge.lanes > 1 && this.rng() < 0.5 ? 1 : 0
    const s = this.rng() * Math.max(1, edge.length - spec.len)
    // Reject spawns that would overlap an existing vehicle on the same lane
    for (const o of this.vehicles) {
      if (o.edgeId === edge.id && o.lane === lane && Math.abs(o.s - s) < spec.len + o.len + 4) return null
    }
    return {
      id: this.nextId++,
      kind,
      edgeId: edge.id,
      lane,
      s,
      speed: 2 + this.rng() * 6,
      len: spec.len,
      width: spec.width,
      color: spec.colors[Math.floor(this.rng() * spec.colors.length)],
      conf: 0.7 + this.rng() * 0.28,
      trail: [],
      trailClock: 0,
      dwell: 0,
      servedStop: -1,
    }
  }

  step(dt: number) {
    this.simSeconds += dt

    // Index vehicles per (edge, lane) sorted by position for car-following
    const byLane = new Map<string, Vehicle[]>()
    for (const v of this.vehicles) {
      const key = `${v.edgeId}:${v.lane}`
      const arr = byLane.get(key)
      if (arr) arr.push(v)
      else byLane.set(key, [v])
    }
    for (const arr of byLane.values()) arr.sort((a, b) => a.s - b.s)

    for (const [key, arr] of byLane) {
      void key
      for (let idx = 0; idx < arr.length; idx++) {
        const v = arr[idx]
        const edge = this.city.edges[v.edgeId]
        const vmax = Math.min(KIND_SPECS[v.kind].vmax, edge.speedLimit)
        let target = vmax

        // Buses dwell at bus stops
        if (v.kind === "bus") {
          if (v.dwell > 0) {
            v.dwell -= dt
            v.speed = 0
            continue
          }
          const stopS = this.city.busStops.get(v.edgeId)
          if (stopS !== undefined && v.servedStop !== v.edgeId && v.s <= stopS) {
            const dist = stopS - v.s
            const brake = (v.speed * v.speed) / (2 * 4.5) + 2
            if (dist < brake + 12) target = Math.min(target, Math.max(0, (dist / brake) * vmax))
            if (dist < 1 && v.speed < 0.6) {
              v.dwell = 3 + this.rng() * 3
              v.servedStop = v.edgeId
              v.speed = 0
              continue
            }
          }
        }

        // Follow the leader on the same lane
        const leader = idx + 1 < arr.length ? arr[idx + 1] : null
        if (leader) {
          const gap = leader.s - leader.len / 2 - (v.s + v.len / 2)
          const desired = 3.5 + v.speed * 1.1
          if (gap < desired) target = Math.min(target, Math.max(0, leader.speed + (gap - desired) * 0.9))
          if (gap < 2) target = 0
        }

        // Obey the signal at the end of the edge
        const light = this.lightState(edge.to, edge.axis)
        const stopAt = edge.length - 9 // stop line before the intersection box
        const distToStop = stopAt - v.s
        if (light !== "g" && distToStop > -2) {
          const brakingDist = (v.speed * v.speed) / (2 * 4.5) + 3
          const runsYellow = light === "y" && distToStop < brakingDist * 0.6
          if (!runsYellow && distToStop < brakingDist + 14) {
            target = distToStop < 1.5 ? 0 : Math.min(target, Math.max(0, (distToStop / brakingDist) * vmax))
          }
        }

        // Accelerate / brake toward target speed
        if (v.speed < target) v.speed = Math.min(target, v.speed + 2.6 * dt)
        else v.speed = Math.max(target, v.speed - 6.5 * dt)
        v.s += v.speed * dt

        // Crossed the intersection: pick the next edge
        if (v.s >= edge.length) {
          const next = this.chooseNext(edge)
          v.s -= edge.length
          v.edgeId = next.id
          v.lane = Math.min(v.lane, next.lanes - 1)
          if (next.lanes > 1 && this.rng() < 0.15) v.lane = v.lane === 0 ? 1 : 0
        }

        // Detection confidence random walk
        v.conf = Math.min(0.99, Math.max(0.55, v.conf + (this.rng() - 0.5) * 0.05))

        // Trail sampling
        v.trailClock += dt
        if (v.trailClock > 0.35) {
          v.trailClock = 0
          v.trail.push(this.position(v).lngLat)
          if (v.trail.length > 26) v.trail.shift()
        }
      }
    }
  }

  private chooseNext(edge: RoadEdge): RoadEdge {
    const out = this.city.outgoing[edge.to]
    const reverse = this.city.reverseEdge[edge.id]
    const straight: RoadEdge[] = []
    const turns: RoadEdge[] = []
    for (const id of out) {
      if (id === reverse) continue
      const e = this.city.edges[id]
      if (e.axis === edge.axis && e.sign === edge.sign) straight.push(e)
      else turns.push(e)
    }
    const r = this.rng()
    if (straight.length && (r < 0.62 || turns.length === 0)) return straight[0]
    if (turns.length) return turns[Math.floor(this.rng() * turns.length)]
    return this.city.edges[reverse] // dead end: U-turn
  }

  /** World position, heading unit vector and lane-offset for a vehicle. */
  position(v: Vehicle): { x: number; y: number; hx: number; hy: number; lngLat: [number, number] } {
    const edge = this.city.edges[v.edgeId]
    const a = this.city.nodePos(edge.from)
    const b = this.city.nodePos(edge.to)
    const hx = (b.x - a.x) / edge.length
    const hy = (b.y - a.y) / edge.length
    // Right-hand traffic: offset perpendicular-right of heading
    const off = 2.6 + v.lane * 3.1
    const px = hy
    const py = -hx
    const x = a.x + hx * v.s + px * off
    const y = a.y + hy * v.s + py * off
    return { x, y, hx, hy, lngLat: this.city.toLngLat(x, y) }
  }

  // ---------- GeoJSON frame builders ----------

  buildVehicleFrame(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = []
    for (const v of this.vehicles) {
      const p = this.position(v)
      const hl = v.len / 2
      const hw = v.width / 2
      const px = p.hy
      const py = -p.hx
      const c = (dx: number, dy: number) => this.city.toLngLat(p.x + p.hx * dx + px * dy, p.y + p.hy * dx + py * dy)
      features.push({
        type: "Feature",
        properties: { id: v.id, kind: v.kind, color: v.color },
        geometry: { type: "Polygon", coordinates: [[c(hl, hw), c(hl, -hw), c(-hl, -hw), c(-hl, hw), c(hl, hw)]] },
      })
    }
    return { type: "FeatureCollection", features }
  }

  buildDetectionFrame(): { boxes: GeoJSON.FeatureCollection; labels: GeoJSON.FeatureCollection } {
    const boxes: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const v of this.vehicles) {
      const p = this.position(v)
      const hl = v.len / 2 + 1.1
      const hw = v.width / 2 + 1.1
      const px = p.hy
      const py = -p.hx
      const c = (dx: number, dy: number) => this.city.toLngLat(p.x + p.hx * dx + px * dy, p.y + p.hy * dx + py * dy)
      const color = BOX_COLORS[v.kind]
      boxes.push({
        type: "Feature",
        properties: { color },
        geometry: { type: "LineString", coordinates: [c(hl, hw), c(hl, -hw), c(-hl, -hw), c(-hl, hw), c(hl, hw)] },
      })
      labels.push({
        type: "Feature",
        properties: { color, label: `${v.kind} ${v.conf.toFixed(2)} #${v.id}` },
        geometry: { type: "Point", coordinates: c(hl + 1, 0) },
      })
    }
    return {
      boxes: { type: "FeatureCollection", features: boxes },
      labels: { type: "FeatureCollection", features: labels },
    }
  }

  buildTrailFrame(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = []
    for (const v of this.vehicles) {
      if (v.trail.length < 2) continue
      features.push({
        type: "Feature",
        properties: { color: BOX_COLORS[v.kind] },
        geometry: { type: "LineString", coordinates: [...v.trail, this.position(v).lngLat] },
      })
    }
    return { type: "FeatureCollection", features }
  }

  /** Headlight glow points just ahead of each vehicle (drawn at night). */
  buildHeadlightFrame(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = []
    for (const v of this.vehicles) {
      const p = this.position(v)
      const d = v.len / 2 + 2.5
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: this.city.toLngLat(p.x + p.hx * d, p.y + p.hy * d) },
      })
    }
    return { type: "FeatureCollection", features }
  }

  /** One point per approach at every signalized intersection, colored by state. */
  buildTrafficLightFrame(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = []
    const colorOf: Record<LightState, string> = { g: "#2bd96f", y: "#ffce3a", r: "#ff4a4a" }
    for (const node of this.city.nodes) {
      if (!node.hasLight) continue
      const sv = this.lightState(node.id, "v")
      const sh = this.lightState(node.id, "h")
      // Place lights at the corner of each approach (right-hand side of incoming traffic)
      const lights: Array<{ dx: number; dy: number; st: LightState }> = [
        { dx: 7, dy: -7, st: sv }, // northbound approach, SE corner
        { dx: -7, dy: 7, st: sv }, // southbound approach, NW corner
        { dx: -7, dy: -7, st: sh }, // eastbound approach, SW corner
        { dx: 7, dy: 7, st: sh }, // westbound approach, NE corner
      ]
      for (const l of lights) {
        features.push({
          type: "Feature",
          properties: { color: colorOf[l.st] },
          geometry: { type: "Point", coordinates: this.city.toLngLat(node.x + l.dx, node.y + l.dy) },
        })
      }
    }
    return { type: "FeatureCollection", features }
  }

  averageSpeedKmh(): number {
    if (!this.vehicles.length) return 0
    const sum = this.vehicles.reduce((acc, v) => acc + v.speed, 0)
    return (sum / this.vehicles.length) * 3.6
  }

  countsByKind(): Record<VehicleKind, number> {
    const counts: Record<VehicleKind, number> = { car: 0, taxi: 0, bus: 0, truck: 0 }
    for (const v of this.vehicles) counts[v.kind]++
    return counts
  }
}

// ---------------------------------------------------------------------------
// Pedestrians: walk the sidewalks along the road graph, wait at signalized
// corners until cross-traffic has the red, then continue.

export interface Pedestrian {
  id: number
  edgeId: number
  s: number
  side: 1 | -1 // which sidewalk relative to the direction of travel
  speed: number
  waiting: boolean
  pendingEdge: number // edge to enter once the crossing is safe
  conf: number
  color: string
}

const PED_COLORS = ["#f9a8d4", "#fcd34d", "#a5b4fc", "#86efac", "#fdba74", "#e2e8f0"]
const PED_BOX_COLOR = "#f472b6"

export class PedestrianSim {
  peds: Pedestrian[] = []
  private rng: () => number
  private nextId = 1

  constructor(private sim: TrafficSim, seed = 7) {
    this.rng = mulberry32(seed)
  }

  setCount(n: number) {
    while (this.peds.length > n) this.peds.pop()
    const edges = this.sim.city.edges
    while (this.peds.length < n) {
      const edge = edges[Math.floor(this.rng() * edges.length)]
      this.peds.push({
        id: this.nextId++,
        edgeId: edge.id,
        s: this.rng() * edge.length,
        side: this.rng() < 0.5 ? 1 : -1,
        speed: 1.1 + this.rng() * 0.7,
        waiting: false,
        pendingEdge: -1,
        conf: 0.6 + this.rng() * 0.35,
        color: PED_COLORS[Math.floor(this.rng() * PED_COLORS.length)],
      })
    }
  }

  step(dt: number) {
    const city = this.sim.city
    for (const p of this.peds) {
      p.conf = Math.min(0.99, Math.max(0.45, p.conf + (this.rng() - 0.5) * 0.05))
      const edge = city.edges[p.edgeId]
      if (p.waiting) {
        // Crossing the perpendicular street: safe once its traffic has the red
        const crossAxis = edge.axis === "h" ? "v" : "h"
        if (this.sim.lightState(edge.to, crossAxis) === "r") {
          p.edgeId = p.pendingEdge
          p.s = 0
          p.waiting = false
        }
        continue
      }
      p.s += p.speed * dt
      if (p.s < edge.length) continue

      // Reached the corner: pick where to go next
      const next = this.chooseNext(edge)
      const node = city.nodes[edge.to]
      const goesStraight = next.axis === edge.axis && next.sign === edge.sign
      if (node.hasLight && goesStraight) {
        const crossAxis = edge.axis === "h" ? "v" : "h"
        if (this.sim.lightState(edge.to, crossAxis) !== "r") {
          p.s = edge.length
          p.waiting = true
          p.pendingEdge = next.id
          continue
        }
      }
      p.s -= edge.length
      p.edgeId = next.id
    }
  }

  private chooseNext(edge: RoadEdge): RoadEdge {
    const city = this.sim.city
    const reverse = city.reverseEdge[edge.id]
    const options = city.outgoing[edge.to].filter((id) => id !== reverse)
    if (!options.length) return city.edges[reverse]
    return city.edges[options[Math.floor(this.rng() * options.length)]]
  }

  position(p: Pedestrian): { x: number; y: number; hx: number; hy: number; lngLat: [number, number] } {
    const city = this.sim.city
    const edge = city.edges[p.edgeId]
    const a = city.nodePos(edge.from)
    const b = city.nodePos(edge.to)
    const hx = (b.x - a.x) / edge.length
    const hy = (b.y - a.y) / edge.length
    const off = ((edge.avenue ? 9 : 5.5) + 2.2) * p.side
    const x = a.x + hx * p.s + hy * off
    const y = a.y + hy * p.s - hx * off
    return { x, y, hx, hy, lngLat: city.toLngLat(x, y) }
  }

  buildPedFrame(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = []
    for (const p of this.peds) {
      features.push({
        type: "Feature",
        properties: { color: p.color },
        geometry: { type: "Point", coordinates: this.position(p).lngLat },
      })
    }
    return { type: "FeatureCollection", features }
  }

  /** Person-class detection boxes/labels, same shape as the vehicle frames. */
  buildDetectionFrame(): { boxes: GeoJSON.Feature[]; labels: GeoJSON.Feature[] } {
    const boxes: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const p of this.peds) {
      const pos = this.position(p)
      const hl = 0.9
      const hw = 0.8
      const px = pos.hy
      const py = -pos.hx
      const c = (dx: number, dy: number) =>
        this.sim.city.toLngLat(pos.x + pos.hx * dx + px * dy, pos.y + pos.hy * dx + py * dy)
      boxes.push({
        type: "Feature",
        properties: { color: PED_BOX_COLOR },
        geometry: { type: "LineString", coordinates: [c(hl, hw), c(hl, -hw), c(-hl, -hw), c(-hl, hw), c(hl, hw)] },
      })
      labels.push({
        type: "Feature",
        properties: { color: PED_BOX_COLOR, label: `person ${p.conf.toFixed(2)} #P${p.id}` },
        geometry: { type: "Point", coordinates: c(hl + 0.8, 0) },
      })
    }
    return { boxes, labels }
  }
}
