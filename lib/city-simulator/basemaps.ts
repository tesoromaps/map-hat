// Basemap collection for the simulator. All sources are keyless raster tile
// services suitable for development/demo use; each carries its attribution.

export interface Basemap {
  id: string
  name: string
  /** XYZ tile URL templates (multiple = subdomain round-robin). null = blank. */
  tiles: string[] | null
  attribution: string
  maxzoom: number
  /** Imagery/real-world basemaps look best with the synthetic city dimmed. */
  imagery: boolean
}

const carto = (style: string) =>
  ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`)

const osm = ["a", "b", "c"].map((s) => `https://${s}.tile.openstreetmap.org/{z}/{x}/{y}.png`)

export const BASEMAPS: Basemap[] = [
  {
    id: "dark",
    name: "Dark",
    tiles: carto("dark_all"),
    attribution: "© OpenStreetMap contributors © CARTO",
    maxzoom: 20,
    imagery: false,
  },
  {
    id: "satellite",
    name: "Satellite",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, Maxar, Earthstar Geographics",
    maxzoom: 19,
    imagery: true,
  },
  {
    id: "streets",
    name: "Streets",
    tiles: osm,
    attribution: "© OpenStreetMap contributors",
    maxzoom: 19,
    imagery: true,
  },
  {
    id: "topo",
    name: "Topographic",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, USGS, NOAA",
    maxzoom: 19,
    imagery: true,
  },
  {
    id: "light",
    name: "Light",
    tiles: carto("light_all"),
    attribution: "© OpenStreetMap contributors © CARTO",
    maxzoom: 20,
    imagery: true,
  },
  {
    id: "none",
    name: "Blank",
    tiles: null,
    attribution: "",
    maxzoom: 22,
    imagery: false,
  },
]

export const DEFAULT_BASEMAP = "dark"

export function getBasemap(id: string): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]
}
