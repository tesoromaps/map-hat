// Day/night cycle: interpolated color palette keyed by hour of day (0-24).

export interface Palette {
  bg: string
  road: string
  roadAvenue: string
  block: string
  park: string
  building: string
  buildingTop: string
  tractLine: string
  text: string
  textHalo: string
  lightColor: string // maplibre light color for extrusions
  lightIntensity: number
  night: number // 0 = full day, 1 = full night
}

interface Keyframe {
  h: number
  bg: string
  road: string
  roadAvenue: string
  block: string
  park: string
  building: string
  buildingTop: string
  lightColor: string
  lightIntensity: number
  night: number
}

const KEYFRAMES: Keyframe[] = [
  { h: 0.0, bg: "#0a0e1a", road: "#1c2230", roadAvenue: "#232b3d", block: "#10141f", park: "#0e1a16", building: "#161c2c", buildingTop: "#1d2538", lightColor: "#3a4a7a", lightIntensity: 0.12, night: 1 },
  { h: 4.5, bg: "#0a0e1a", road: "#1c2230", roadAvenue: "#232b3d", block: "#10141f", park: "#0e1a16", building: "#161c2c", buildingTop: "#1d2538", lightColor: "#3a4a7a", lightIntensity: 0.12, night: 1 },
  { h: 6.0, bg: "#3a3050", road: "#3d3a4e", roadAvenue: "#474357", block: "#2e2940", park: "#27402f", building: "#3a3550", buildingTop: "#544a68", lightColor: "#c98a5a", lightIntensity: 0.3, night: 0.6 },
  { h: 7.5, bg: "#c9a87a", road: "#6e6a70", roadAvenue: "#7a757a", block: "#b39a78", park: "#6f9e5e", building: "#a89880", buildingTop: "#d4bd96", lightColor: "#ffd9a0", lightIntensity: 0.45, night: 0.15 },
  { h: 10.0, bg: "#dfe7e2", road: "#9aa0a8", roadAvenue: "#a8aeb6", block: "#cfd6cd", park: "#88c272", building: "#c8cdd2", buildingTop: "#e6eaee", lightColor: "#ffffff", lightIntensity: 0.55, night: 0 },
  { h: 15.5, bg: "#dfe7e2", road: "#9aa0a8", roadAvenue: "#a8aeb6", block: "#cfd6cd", park: "#88c272", building: "#c8cdd2", buildingTop: "#e6eaee", lightColor: "#fff6e0", lightIntensity: 0.55, night: 0 },
  { h: 18.0, bg: "#e0a25e", road: "#7d7268", roadAvenue: "#8a7e72", block: "#c09467", park: "#739a52", building: "#b08d6a", buildingTop: "#e8b27a", lightColor: "#ff9d5c", lightIntensity: 0.4, night: 0.2 },
  { h: 19.5, bg: "#46355c", road: "#403c52", roadAvenue: "#4a455c", block: "#352e48", park: "#2c4534", building: "#403a58", buildingTop: "#5c4f72", lightColor: "#b06a8a", lightIntensity: 0.25, night: 0.65 },
  { h: 21.0, bg: "#0a0e1a", road: "#1c2230", roadAvenue: "#232b3d", block: "#10141f", park: "#0e1a16", building: "#161c2c", buildingTop: "#1d2538", lightColor: "#3a4a7a", lightIntensity: 0.12, night: 1 },
  { h: 24.0, bg: "#0a0e1a", road: "#1c2230", roadAvenue: "#232b3d", block: "#10141f", park: "#0e1a16", building: "#161c2c", buildingTop: "#1d2538", lightColor: "#3a4a7a", lightIntensity: 0.12, night: 1 },
]

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t))
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

export function paletteForHour(hour: number): Palette {
  const h = ((hour % 24) + 24) % 24
  let k0 = KEYFRAMES[0]
  let k1 = KEYFRAMES[KEYFRAMES.length - 1]
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (h >= KEYFRAMES[i].h && h <= KEYFRAMES[i + 1].h) {
      k0 = KEYFRAMES[i]
      k1 = KEYFRAMES[i + 1]
      break
    }
  }
  const span = k1.h - k0.h || 1
  const t = (h - k0.h) / span
  const night = k0.night + (k1.night - k0.night) * t
  return {
    bg: lerpHex(k0.bg, k1.bg, t),
    road: lerpHex(k0.road, k1.road, t),
    roadAvenue: lerpHex(k0.roadAvenue, k1.roadAvenue, t),
    block: lerpHex(k0.block, k1.block, t),
    park: lerpHex(k0.park, k1.park, t),
    building: lerpHex(k0.building, k1.building, t),
    buildingTop: lerpHex(k0.buildingTop, k1.buildingTop, t),
    tractLine: night > 0.5 ? "#7dd3fc" : "#0369a1",
    text: night > 0.5 ? "#e2e8f0" : "#1e293b",
    textHalo: night > 0.5 ? "#0a0e1a" : "#f8fafc",
    lightColor: lerpHex(k0.lightColor, k1.lightColor, t),
    lightIntensity: k0.lightIntensity + (k1.lightIntensity - k0.lightIntensity) * t,
    night,
  }
}

export function formatClock(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const hh = Math.floor(h)
  const mm = Math.floor((h - hh) * 60)
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
}

export function dayPhase(hour: number): { label: string; icon: string } {
  const h = ((hour % 24) + 24) % 24
  if (h < 5) return { label: "Night", icon: "🌙" }
  if (h < 7.5) return { label: "Dawn", icon: "🌅" }
  if (h < 17) return { label: "Day", icon: "☀️" }
  if (h < 20) return { label: "Dusk", icon: "🌇" }
  return { label: "Night", icon: "🌙" }
}
