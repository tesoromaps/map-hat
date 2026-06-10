// Browser-side geo file importer: GeoJSON, KML, KMZ, zipped shapefiles and
// loose .shp/.dbf pairs. All heavy parsers are dynamically imported so this
// never runs during SSR.

export interface ImportedLayer {
  name: string
  fc: GeoJSON.FeatureCollection
  bounds: [[number, number], [number, number]] | null
}

function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "")
}

function ext(filename: string): string {
  return (filename.split(".").pop() || "").toLowerCase()
}

function asFeatureCollection(data: unknown): GeoJSON.FeatureCollection {
  const d = data as GeoJSON.GeoJSON
  if (!d || typeof d !== "object") throw new Error("Not valid GeoJSON")
  if (d.type === "FeatureCollection") return d
  if (d.type === "Feature") return { type: "FeatureCollection", features: [d] }
  if ("coordinates" in d || d.type === "GeometryCollection") {
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: d as GeoJSON.Geometry }] }
  }
  throw new Error("Not valid GeoJSON")
}

function collectCoords(geom: GeoJSON.Geometry | null, out: [number, number][]) {
  if (!geom) return
  if (geom.type === "GeometryCollection") {
    geom.geometries.forEach((g) => collectCoords(g, out))
    return
  }
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === "number") out.push([c[0] as number, c[1] as number])
    else c.forEach(walk)
  }
  walk(geom.coordinates)
}

export function boundsOf(fc: GeoJSON.FeatureCollection): [[number, number], [number, number]] | null {
  const coords: [number, number][] = []
  fc.features.forEach((f) => collectCoords(f.geometry, coords))
  if (!coords.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of coords) {
    if (!isFinite(x) || !isFinite(y)) continue
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) return null
  return [[minX, minY], [maxX, maxY]]
}

async function parseKmlText(text: string): Promise<GeoJSON.FeatureCollection> {
  const { kml } = await import("@tmcw/togeojson")
  const dom = new DOMParser().parseFromString(text, "text/xml")
  return asFeatureCollection(kml(dom))
}

async function parseKmz(buffer: ArrayBuffer): Promise<GeoJSON.FeatureCollection> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buffer)
  const kmlEntry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".kml"))
  if (!kmlEntry) throw new Error("KMZ archive contains no .kml file")
  return parseKmlText(await kmlEntry.async("text"))
}

async function parseShpZip(buffer: ArrayBuffer): Promise<GeoJSON.FeatureCollection> {
  const shp = (await import("shpjs")).default
  const result = await shp(buffer)
  const list = Array.isArray(result) ? result : [result]
  const features = list.flatMap((fc) => fc.features)
  return { type: "FeatureCollection", features }
}

async function parseLooseShp(shpBuf: ArrayBuffer, dbfBuf?: ArrayBuffer): Promise<GeoJSON.FeatureCollection> {
  const mod = await import("shpjs")
  const geometries = mod.parseShp(shpBuf)
  const rows = dbfBuf ? mod.parseDbf(dbfBuf) : []
  const features: GeoJSON.Feature[] = geometries.map((geometry: GeoJSON.Geometry, idx: number) => ({
    type: "Feature",
    properties: (rows && rows[idx]) || {},
    geometry,
  }))
  return { type: "FeatureCollection", features }
}

/**
 * Parse a set of user-selected/dropped files into named layers.
 * Loose .shp files are paired with same-named .dbf files when present.
 */
export async function importGeoFiles(files: File[]): Promise<ImportedLayer[]> {
  const layers: ImportedLayer[] = []
  const dbfByBase = new Map<string, File>()
  for (const f of files) if (ext(f.name) === "dbf") dbfByBase.set(baseName(f.name).toLowerCase(), f)

  for (const file of files) {
    const e = ext(file.name)
    try {
      let fc: GeoJSON.FeatureCollection | null = null
      if (e === "geojson" || e === "json") {
        fc = asFeatureCollection(JSON.parse(await file.text()))
      } else if (e === "kml") {
        fc = await parseKmlText(await file.text())
      } else if (e === "kmz") {
        fc = await parseKmz(await file.arrayBuffer())
      } else if (e === "zip") {
        fc = await parseShpZip(await file.arrayBuffer())
      } else if (e === "shp") {
        const dbf = dbfByBase.get(baseName(file.name).toLowerCase())
        fc = await parseLooseShp(await file.arrayBuffer(), dbf ? await dbf.arrayBuffer() : undefined)
      } else if (e === "dbf" || e === "shx" || e === "prj" || e === "cpg") {
        continue // sidecar files handled alongside their .shp
      } else {
        throw new Error(`Unsupported file type .${e}`)
      }
      if (!fc.features.length) throw new Error("File contained no features")
      layers.push({ name: file.name, fc, bounds: boundsOf(fc) })
    } catch (err) {
      throw new Error(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return layers
}

export const ACCEPTED_EXTENSIONS = ".geojson,.json,.kml,.kmz,.zip,.shp,.dbf,.shx,.prj,.cpg"
