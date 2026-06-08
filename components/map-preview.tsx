"use client"

import { useEffect, useRef } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

interface MapPreviewProps {
  geoJSON: any
}

export default function MapPreview({ geoJSON }: MapPreviewProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!mapContainer.current || !geoJSON) return

    if (map.current) {
      // If map already exists, just update the source data
      if (map.current.getSource("geojson-data")) {
        ;(map.current.getSource("geojson-data") as maplibregl.GeoJSONSource).setData(geoJSON)
        fitMapToBounds(map.current, geoJSON)
      }
      return
    }

    // Initialize map
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
          "geojson-data": {
            type: "geojson",
            data: geoJSON,
          },
        },
        layers: [
          {
            id: "osm-tiles",
            type: "raster",
            source: "osm",
            minzoom: 0,
            maxzoom: 19,
          },
          {
            id: "geojson-polygons",
            type: "fill",
            source: "geojson-data",
            filter: ["==", "$type", "Polygon"],
            paint: {
              "fill-color": "#3388ff",
              "fill-opacity": 0.4,
            },
          },
          {
            id: "geojson-lines",
            type: "line",
            source: "geojson-data",
            filter: ["==", "$type", "LineString"],
            paint: {
              "line-color": "#3388ff",
              "line-width": 3,
            },
          },
          {
            id: "geojson-points",
            type: "circle",
            source: "geojson-data",
            filter: ["==", "$type", "Point"],
            paint: {
              "circle-radius": 6,
              "circle-color": "#3388ff",
            },
          },
        ],
      },
      center: [0, 0],
      zoom: 1,
    })

    map.current.on("load", () => {
      if (map.current) {
        fitMapToBounds(map.current, geoJSON)

        // Add popup on hover
        map.current.on("mouseenter", "geojson-points", (e) => {
          if (e.features && e.features[0] && e.features[0].properties) {
            const coordinates = (e.features[0].geometry as any).coordinates.slice()
            const properties = e.features[0].properties

            // Create HTML content for popup
            let html = '<div class="p-2">'
            for (const key in properties) {
              if (properties[key]) {
                html += `<div><strong>${key}:</strong> ${properties[key]}</div>`
              }
            }
            html += "</div>"

            new maplibregl.Popup().setLngLat(coordinates).setHTML(html).addTo(map.current)
          }
        })

        // Change cursor on hover
        map.current.on("mouseenter", "geojson-points", () => {
          if (map.current) map.current.getCanvas().style.cursor = "pointer"
        })

        map.current.on("mouseleave", "geojson-points", () => {
          if (map.current) map.current.getCanvas().style.cursor = ""
        })
      }
    })

    // Add navigation controls
    map.current.addControl(new maplibregl.NavigationControl())

    return () => {
      if (map.current) {
        map.current.remove()
        map.current = null
      }
    }
  }, [geoJSON])

  // Helper function to fit map to GeoJSON bounds
  const fitMapToBounds = (map: maplibregl.Map, geoJSON: any) => {
    if (!geoJSON || !geoJSON.features || geoJSON.features.length === 0) return

    const bounds = new maplibregl.LngLatBounds()

    // Process each feature to extend the bounds
    geoJSON.features.forEach((feature: any) => {
      if (feature.geometry) {
        if (feature.geometry.type === "Point") {
          bounds.extend(feature.geometry.coordinates)
        } else if (feature.geometry.type === "LineString") {
          feature.geometry.coordinates.forEach((coord: [number, number]) => {
            bounds.extend(coord)
          })
        } else if (feature.geometry.type === "Polygon") {
          feature.geometry.coordinates[0].forEach((coord: [number, number]) => {
            bounds.extend(coord)
          })
        } else if (feature.geometry.type === "MultiPolygon") {
          feature.geometry.coordinates.forEach((polygon: any) => {
            polygon[0].forEach((coord: [number, number]) => {
              bounds.extend(coord)
            })
          })
        }
      }
    })

    // Only fit bounds if we have coordinates
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 40,
        maxZoom: 16,
      })
    }
  }

  return <div ref={mapContainer} className="w-full h-full rounded-md overflow-hidden" />
}

