// Forward geocoding via the public OpenStreetMap Nominatim service. Runs in the
// browser; subject to Nominatim's usage policy (≤1 req/s, light use).

export interface GeocodeResult {
  name: string
  lng: number
  lat: number
  /** [west, south, east, north] when the provider supplies a bounding box. */
  bbox: [number, number, number, number] | null
  kind: string
}

interface NominatimRow {
  display_name: string
  lon: string
  lat: string
  type?: string
  addresstype?: string
  boundingbox?: [string, string, string, string] // [south, north, west, east]
}

export async function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=6&q=${encodeURIComponent(q)}`
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  const rows = (await res.json()) as NominatimRow[]
  return rows.map((r) => {
    const bb = r.boundingbox
    return {
      name: r.display_name,
      lng: parseFloat(r.lon),
      lat: parseFloat(r.lat),
      bbox: bb ? [parseFloat(bb[2]), parseFloat(bb[0]), parseFloat(bb[3]), parseFloat(bb[1])] : null,
      kind: r.addresstype || r.type || "place",
    }
  })
}
