// Ambient declarations for dependencies that ship without TypeScript types.
declare module "xmldom"

declare module "shpjs" {
  function shp(input: ArrayBuffer | string | object): Promise<GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[]>
  export function parseShp(buffer: ArrayBuffer, projection?: string): GeoJSON.Geometry[]
  export function parseDbf(buffer: ArrayBuffer, cpg?: ArrayBuffer): Record<string, unknown>[]
  export function combine(arr: [GeoJSON.Geometry[], Record<string, unknown>[]]): GeoJSON.FeatureCollection
  export default shp
}
declare module "shp-write"
declare module "file-saver"
