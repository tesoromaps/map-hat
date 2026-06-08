"use client"

import { useState, useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Layers, Search, Database, Loader2, Plus, CreditCard, Upload, MapPin, BarChart2 } from 'lucide-react'
import { ResponsiveBar } from "@nivo/bar"
import { ResponsivePie } from "@nivo/pie"
import JSZip from "jszip"
import Tesseract from "tesseract.js"
import { DOMParser } from "xmldom"
import { kml } from "@tmcw/togeojson"

const geodeButtonClass = `
  relative overflow-hidden bg-gradient-to-br from-green-300 via-green-400 to-green-600
  text-white font-semibold py-2 px-4 rounded-lg shadow-lg
  transition-all duration-300 ease-in-out
  before:content-[''] before:absolute before:inset-0
  before:bg-gradient-to-br before:from-green-200/50 before:via-green-300/50 before:to-green-500/50
  before:opacity-0 before:transition-opacity before:duration-300
  hover:before:opacity-100 hover:shadow-green-400/50 hover:shadow-xl
  active:shadow-inner active:shadow-green-600/50
  disabled:opacity-50 disabled:cursor-not-allowed
`;

const geodeCardHeaderClass = `
  bg-gradient-to-br from-green-200 via-green-300 to-green-400
  shadow-inner shadow-green-200/50
`;

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  iconUrl: "/leaflet/marker-icon.png",
  shadowUrl: "/leaflet/marker-shadow.png",
})

interface Dataset {
  id: string
  name: string
  source: string
  description: string
  url: string
}

interface BusinessCard {
  id: string
  address: string
  lat: number
  lon: number
  imageUrl: string
}

interface MapType {
  id: string
  name: string
  description: string
}

interface CRMRecord {
  id: string
  name?: string
  company?: string
  title?: string
  email?: string
  phone?: string
  address?: string
  notes?: string
  source?: string
  imageUrl?: string
  geocodeStatus?: "geocoded" | "pending" | "failed" | "none"
}

const industries = [
  "Agriculture",
  "Real Estate",
  "Healthcare",
  "Retail",
  "Transportation",
  "Energy",
  "Education",
  "Tourism",
]

export function AiEnhancedMapComponent() {
  const mapRef = useRef<L.Map | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [dataSource, setDataSource] = useState("")
  const [aiSuggestions, setAiSuggestions] = useState<Dataset[]>([])
  const [businessCards, setBusinessCards] = useState<BusinessCard[]>([])
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedIndustry, setSelectedIndustry] = useState("")
  const [industrySearch, setIndustrySearch] = useState("")
  const [mapTypeSuggestions, setMapTypeSuggestions] = useState<MapType[]>([])
  const [showDashboard, setShowDashboard] = useState(false)
  const [importedGeoJson, setImportedGeoJson] = useState(null)
  const [crmRecords, setCrmRecords] = useState<CRMRecord[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    if (!mapRef.current) {
      const fortWorth = [32.7555, -97.3308]
      mapRef.current = L.map("map").setView(fortWorth, 10)

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        className: 'map-tiles-phyto'
      }).addTo(mapRef.current)

      L.marker(fortWorth).addTo(mapRef.current)
        .bindPopup("Fort Worth, Texas")
        .openPopup()

      // Add the new layer
      const xatlasLayer = L.tileLayer('https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Median_Household_Income/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community'
      })
      xatlasLayer.addTo(mapRef.current)
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [])

  const handleSearch = async () => {
    setLoading(true)
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`)
      const data = await response.json()
      if (data && data.length > 0) {
        const { lat, lon } = data[0]
        mapRef.current?.setView([parseFloat(lat), parseFloat(lon)], 13)
        L.marker([parseFloat(lat), parseFloat(lon)]).addTo(mapRef.current!)
          .bindPopup(data[0].display_name)
          .openPopup()
      } else {
        alert("Location not found")
      }
    } catch (error) {
      console.error("Error during geocoding:", error)
      alert("Error during search. Please try again.")
    }
    setLoading(false)
  }

  const handleDataIntegration = () => {
    console.log(`Integrating data from: ${dataSource}`)
    alert(`Data from ${dataSource} has been integrated into the map.`)
  }

  const handleAiSuggestions = async () => {
    setLoading(true)
    setAiSuggestions([])

    try {
      // Simulating API calls to different GIS sites
      const arcgisResults = await simulateApiCall("www.arcgis.com")
      const hubArcgisResults = await simulateApiCall("hub.arcgis.com")
      const geoseerResults = await simulateApiCall("geoseer.net")

      const allResults = [...arcgisResults, ...hubArcgisResults, ...geoseerResults]
      setAiSuggestions(allResults)
    } catch (error) {
      console.error("Error fetching AI suggestions:", error)
      alert("Error fetching AI suggestions. Please try again.")
    }

    setLoading(false)
  }

  const simulateApiCall = async (source: string): Promise<Dataset[]> => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const mockData: Dataset[] = [
      {
        id: `${source}-1`,
        name: `${source} Dataset 1`,
        source: source,
        description: `A sample dataset from ${source}`,
        url: `https://${source}/dataset1`
      },
      {
        id: `${source}-2`,
        name: `${source} Dataset 2`,
        source: source,
        description: `Another sample dataset from ${source}`,
        url: `https://${source}/dataset2`
      }
    ]
    return mockData
  }

  const extractCrmFieldsFromText = (text: string, source: string): CRMRecord => {
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
    const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/)
    const companyMatch = lines.find(line => /\b(inc|llc|corp|company|co|solutions|services|group|studio|llp|partners)\b/i.test(line))
    const titleMatch = lines.find(line => /\b(manager|director|engineer|consultant|owner|founder|ceo|cto|cfo|vp|president|architect|analyst)\b/i.test(line))

    const isAddressLike = (line: string) => {
      return [
        /\d+\s+.+/.test(line),
        /\b(street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|square|sq|pkwy|parkway|suite|ste)\b/i.test(line),
        /,\s*\w+/.test(line),
      ].some(Boolean)
    }

    const addressMatch = lines.find(line => isAddressLike(line) && !line.includes("@") && !(phoneMatch?.[0] && line.includes(phoneMatch[0])))
    const addressFallback = lines
      .filter(line => line !== lines[0] && line !== companyMatch && line !== titleMatch)
      .find(line => !line.includes("@") && !(phoneMatch?.[0] && line.includes(phoneMatch[0])))

    const nameCandidate = lines[0] && !lines[0].includes("@") ? lines[0] : ""
    const notes = lines
      .filter(line => line !== nameCandidate && line !== companyMatch && line !== titleMatch && line !== addressMatch)
      .filter(line => line !== emailMatch?.[0] && line !== phoneMatch?.[0])
      .join(" | ")

    return {
      id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: nameCandidate,
      company: companyMatch || "",
      title: titleMatch || "",
      email: emailMatch?.[0] || "",
      phone: phoneMatch?.[0] || "",
      address: addressMatch || addressFallback || "",
      notes: notes || "Extracted from uploaded image",
      source,
      geocodeStatus: "none",
    }
  }

  const updateCrmRecordStatus = (recordId: string, status: CRMRecord["geocodeStatus"]) => {
    setCrmRecords((prev) => prev.map((record) => record.id === recordId ? { ...record, geocodeStatus: status } : record))
  }

  const geocodeAddress = async (address: string) => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`
      )
      const results = await response.json()
      if (results && results.length > 0) {
        return {
          lat: parseFloat(results[0].lat),
          lon: parseFloat(results[0].lon),
        }
      }
    } catch (error) {
      console.error("Geocoding error:", error)
    }
    return null
  }

  const parseGeoJsonFeaturesToRecords = (geoJson: any, source: string): CRMRecord[] => {
    const getRecord = (properties: any, index: number): CRMRecord => {
      const address = [
        properties.address,
        properties.street,
        properties.city,
        properties.region,
        properties.state,
        properties.postalCode,
      ]
        .filter(Boolean)
        .join(", ")

      return {
        id: properties.id || `${source}-${index}`,
        name: properties.name || properties.Name || properties.contactName || properties.person || "",
        company: properties.organization || properties.company || properties.org || "",
        title: properties.title || properties.role || properties.position || "",
        email: properties.email || properties.Email || properties.contactEmail || "",
        phone: properties.phone || properties.telephone || properties.mobile || properties.contactPhone || "",
        address,
        notes: properties.description || properties.notes || "Imported from GeoJSON",
        source,
      }
    }

    if (geoJson?.type === "FeatureCollection" && Array.isArray(geoJson.features)) {
      return geoJson.features.map((feature: any, index: number) => getRecord(feature.properties || {}, index))
    }

    if (geoJson?.type === "Feature") {
      return [getRecord(geoJson.properties || {}, 0)]
    }

    if (geoJson?.properties) {
      return [getRecord(geoJson.properties, 0)]
    }

    return []
  }

  const addLayerToMap = (dataset: Dataset) => {
    console.log(`Adding ${dataset.name} from ${dataset.source} to the map`)
    alert(`Layer "${dataset.name}" has been added to the map. URL: ${dataset.url}`)
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    setUploadError(null)

    const fileName = file.name.toLowerCase()
    const ext = fileName.split(".").pop() || ""
    const geoExtensions = ["kml", "kmz", "geojson", "json"]
    const imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "webp"]

    try {
      if (geoExtensions.includes(ext)) {
        let geoJsonData: any

        if (ext === "kmz") {
          const zip = new JSZip()
          const zipContent = await zip.loadAsync(file)
          const kmlFile = Object.values(zipContent.files).find(f => f.name.endsWith(".kml"))
          if (!kmlFile) throw new Error("No KML file found in KMZ")
          const kmlContent = await kmlFile.async("text")
          const parser = new DOMParser()
          const kmlDoc = parser.parseFromString(kmlContent, "text/xml")
          geoJsonData = kml(kmlDoc)
        } else if (ext === "kml") {
          const kmlContent = await file.text()
          const parser = new DOMParser()
          const kmlDoc = parser.parseFromString(kmlContent, "text/xml")
          geoJsonData = kml(kmlDoc)
        } else {
          const jsonText = await file.text()
          geoJsonData = JSON.parse(jsonText)
        }

        setImportedGeoJson(geoJsonData)
        const records = parseGeoJsonFeaturesToRecords(geoJsonData, file.name)
        if (records.length > 0) {
          setCrmRecords((prev) => [...prev, ...records])
          alert("Imported geographic data and created CRM records from properties.")
        } else {
          setUploadError("Imported geographic data did not contain CRM-style properties.")
          alert("Imported geographic data did not contain CRM-style properties.")
        }
      } else if (imageExtensions.includes(ext) || file.type.startsWith("image/")) {
        const result = await Tesseract.recognize(file, "eng", {
          logger: (m) => console.log(m),
        })
        const extractedText = result.data.text || ""
        const previewUrl = URL.createObjectURL(file)
        const initialRecord = {
          ...extractCrmFieldsFromText(extractedText, file.name),
          imageUrl: previewUrl,
          geocodeStatus: extractedText ? "pending" : "none",
        }
        setCrmRecords((prev) => [...prev, initialRecord])

        if (initialRecord.address) {
          updateCrmRecordStatus(initialRecord.id, "pending")
          const coordinates = await geocodeAddress(initialRecord.address)
          if (coordinates) {
            const card: BusinessCard = {
              id: initialRecord.id,
              address: initialRecord.address,
              lat: coordinates.lat,
              lon: coordinates.lon,
              imageUrl: previewUrl,
            }
            setBusinessCards((prev) => [...prev, card])
            addBusinessCardToMap(card)
            updateCrmRecordStatus(initialRecord.id, "geocoded")
          } else {
            updateCrmRecordStatus(initialRecord.id, "failed")
            console.warn("Could not geocode uploaded address:", initialRecord.address)
            alert("OCR succeeded, but the address could not be geocoded.")
          }
        } else {
          updateCrmRecordStatus(initialRecord.id, "none")
        }

        alert("OCR completed and a CRM record was created from the uploaded image.")
      } else {
        const message = "Unsupported file type. Upload KML/KMZ/GeoJSON files or an image for OCR."
        setUploadError(message)
        alert(message)
      }
    } catch (error) {
      console.error("Error processing file:", error)
      setUploadError("Error processing file. Please try again.")
      alert("Error processing file. Please try again.")
    } finally {
      setLoading(false)
      if (event.target) {
        event.target.value = ""
      }
    }
  }

  const addBusinessCardToMap = (card: BusinessCard) => {
    if (mapRef.current) {
      const icon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div style="background-image: url('${card.imageUrl}'); width: 50px; height: 30px; background-size: cover; border: 2px solid #fff; border-radius: 4px;"></div>`,
        iconSize: [50, 30],
        iconAnchor: [25, 15]
      })

      L.marker([card.lat, card.lon], { icon })
        .addTo(mapRef.current)
        .bindPopup(`<strong>${card.address}</strong><br><img src="${card.imageUrl}" alt="Business Card" style="width: 200px; height: auto;">`)

      mapRef.current.setView([card.lat, card.lon], 13)
    }
  }

  const handleMapTypeRecommendation = async () => {
    setLoading(true)
    try {
      // Simulate API call for map type recommendations
      await new Promise(resolve => setTimeout(resolve, 1500))
      const industry = selectedIndustry || industrySearch
      const suggestions: MapType[] = [
        { id: "1", name: `${industry} Density Map`, description: `Shows the concentration of ${industry.toLowerCase()} activities or facilities in different areas.` },
        { id: "2", name: `${industry} Growth Trend Map`, description: `Visualizes the expansion or contraction of ${industry.toLowerCase()} over time in various regions.` },
        { id: "3", name: `${industry} Resource Distribution Map`, description: `Displays the distribution of key resources or infrastructure related to ${industry.toLowerCase()}.` },
        { id: "4", name: `${industry} Market Potential Map`, description: `Highlights areas with high potential for ${industry.toLowerCase()} based on demographic and economic factors.` },
      ]
      setMapTypeSuggestions(suggestions)
    } catch (error) {
      console.error("Error fetching map type suggestions:", error)
      alert("Error fetching map type suggestions. Please try again.")
    }
    setLoading(false)
  }

  const addMapTypeToMap = (mapType: MapType) => {
    console.log(`Adding ${mapType.name} to the map`)
    alert(`Map type "${mapType.name}" has been added to the map.`)
    // In a real application, this would involve adding a new layer or changing the map visualization
  }

  const handleShowDashboard = () => {
    setShowDashboard(true)
  }

  // Simulated data for the dashboard
  const incomeData = [
    { income: "0-25k", value: 15 },
    { income: "25k-50k", value: 30 },
    { income: "50k-75k", value: 25 },
    { income: "75k-100k", value: 20 },
    { income: "100k+", value: 10 },
  ]

  const ethnicityData = [
    { id: "White", value: 60 },
    { id: "Black", value: 15 },
    { id: "Hispanic", value: 18 },
    { id: "Asian", value: 5 },
    { id: "Other", value: 2 },
  ]

  useEffect(() => {
    if (importedGeoJson && mapRef.current) {
      const layer = L.geoJSON(importedGeoJson)
      const bounds = layer.getBounds()

      if (bounds.isValid()) {
        layer.addTo(mapRef.current)
        mapRef.current.fitBounds(bounds)
      } else {
        console.warn("Imported GeoJSON has no valid bounds:", importedGeoJson)
        alert("Imported GeoJSON does not contain valid geographic features to display on the map.")
      }
    }
  }, [importedGeoJson])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex flex-grow">
        <div id="map" className="w-1/2 h-full" role="application" aria-label="Interactive map"></div>
        <div className="w-1/2 p-4 bg-green-50 overflow-y-auto">
          <Tabs defaultValue="search">
            <TabsList className="grid w-full grid-cols-6 bg-green-100">
              <TabsTrigger value="search" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><Search className="w-4 h-4 mr-2" />Search</TabsTrigger>
              <TabsTrigger value="data" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><Database className="w-4 h-4 mr-2" />Data</TabsTrigger>
              <TabsTrigger value="ai" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><Layers className="w-4 h-4 mr-2" />AI Tools</TabsTrigger>
              <TabsTrigger value="card" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><CreditCard className="w-4 h-4 mr-2" />Card</TabsTrigger>
              <TabsTrigger value="maptype" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><MapPin className="w-4 h-4 mr-2" />Map Type</TabsTrigger>
              <TabsTrigger value="dashboard" className="data-[state=active]:bg-green-500 data-[state=active]:text-white"><BarChart2 className="w-4 h-4 mr-2" />Dashboard</TabsTrigger>
            </TabsList>
            <TabsContent value="search">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">Search Location</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <Label htmlFor="search">Enter location:</Label>
                    <Input
                      id="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="e.g., Downtown Fort Worth"
                    />
                    <Button onClick={handleSearch} disabled={loading} className={geodeButtonClass}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                      {loading ? "Searching..." : "Search"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="data">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">Integrate Data</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <Label htmlFor="dataSource">Data source URL or file:</Label>
                    <Input
                      id="dataSource"
                      value={dataSource}
                      onChange={(e) => setDataSource(e.target.value)}
                      placeholder="e.g., https://data.gov/api/v1/data.json"
                    />
                    <Button onClick={handleDataIntegration} className={geodeButtonClass}>
                      <Database className="mr-2 h-4 w-4" />
                      Integrate
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="ai">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">AI Suggestions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <Button onClick={handleAiSuggestions} disabled={loading} className={geodeButtonClass}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
                      {loading ? "Fetching Layers..." : "Get Layer Suggestions"}
                    </Button>
                    {aiSuggestions.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-semibold">Suggested Map Layers:</h3>
                        <ul className="space-y-2">
                          {aiSuggestions.map((dataset) => (
                            <li key={dataset.id} className="bg-green-100 p-2 rounded-md">
                              <h4 className="font-semibold">{dataset.name}</h4>
                              <p className="text-sm text-green-700">{dataset.description}</p>
                              <p className="text-xs text-green-600 mt-1">Source: {dataset.source}</p>
                              <Button variant="outline" size="sm" className={geodeButtonClass} onClick={() => addLayerToMap(dataset)}>
                                <Plus className="mr-2 h-4 w-4" />
                                Add to Map
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="card">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">Business Card Mapping</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept=".kml,.kmz,.geojson,.json,image/*"
                      onChange={handleFileUpload}
                    />
                    <Button onClick={() => fileInputRef.current?.click()} disabled={loading} className={geodeButtonClass}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                      {loading ? "Processing..." : "Upload File for OCR / Geo Data"}
                    </Button>
                    <p className="text-xs text-green-600 mt-2">
                      Supported: KML/KMZ/GeoJSON for map import, or images for OCR-based CRM extraction.
                    </p>
                    {uploadError && (
                      <p className="text-sm text-red-700">{uploadError}</p>
                    )}
                    {crmRecords.length > 0 && (
                      <div className="space-y-4">
                        <div>
                          <h3 className="text-sm font-semibold">Imported CRM Records:</h3>
                          <div className="overflow-x-auto rounded-lg border border-green-200 bg-white">
                            <table className="min-w-full text-left text-sm">
                              <thead className="bg-green-100 text-green-800">
                                <tr>
                                  <th className="px-2 py-2">Name</th>
                                  <th className="px-2 py-2">Company</th>
                                  <th className="px-2 py-2">Title</th>
                                  <th className="px-2 py-2">Email</th>
                                  <th className="px-2 py-2">Phone</th>
                                  <th className="px-2 py-2">Address</th>
                                  <th className="px-2 py-2">Source</th>
                                  <th className="px-2 py-2">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {crmRecords.map((record) => (
                                  <tr key={record.id} className="border-t border-green-200">
                                    <td className="px-2 py-2 align-top">{record.name || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.company || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.title || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.email || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.phone || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.address || "-"}</td>
                                    <td className="px-2 py-2 align-top">{record.source || "-"}</td>
                                    <td className="px-2 py-2 align-top">
                                      {record.geocodeStatus === "pending" ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-1 text-xs font-semibold text-yellow-900">
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                          Geocoding
                                        </span>
                                      ) : record.geocodeStatus === "geocoded" ? (
                                        <span className="inline-flex rounded-full bg-green-100 px-2 py-1 text-xs font-semibold text-green-900">
                                          Geocoded
                                        </span>
                                      ) : record.geocodeStatus === "failed" ? (
                                        <span className="inline-flex rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-900">
                                          Needs geocode
                                        </span>
                                      ) : (
                                        <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                                          No address
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        {crmRecords.some(record => record.imageUrl) && (
                          <div className="rounded-lg border border-green-200 bg-white p-3">
                            <h4 className="text-sm font-semibold">Uploaded Image Preview</h4>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              {crmRecords.filter(record => record.imageUrl).map((record) => (
                                <div key={`preview-${record.id}`} className="overflow-hidden rounded-lg border border-green-100 bg-green-50 p-2">
                                  <img src={record.imageUrl} alt={`Preview ${record.name || record.source}`} className="w-full max-h-[32rem] object-contain" />
                                  <p className="mt-2 text-xs text-green-700">{record.name || record.address || "OCR result"}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {businessCards.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-semibold">Mapped Business Cards:</h3>
                        <ul className="space-y-2">
                          {businessCards.map((card) => (
                            <li key={card.id} className="bg-green-100 p-2 rounded-md">
                              <p className="text-sm">{card.address}</p>
                              <img src={card.imageUrl} alt="Business Card" className="mt-2 w-full h-auto" />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="maptype">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">Map Type Recommender</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="industry-select">Select Industry:</Label>
                      <Select onValueChange={setSelectedIndustry}>
                        <SelectTrigger id="industry-select">
                          <SelectValue placeholder="Choose an industry" />
                        </SelectTrigger>
                        <SelectContent>
                          {industries.map((industry) => (
                            <SelectItem key={industry} value={industry.toLowerCase()}>
                              {industry}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="industry-search">Or search for an industry:</Label>
                      <Input
                        id="industry-search"
                        value={industrySearch}
                        onChange={(e) => setIndustrySearch(e.target.value)}
                        placeholder="e.g., Technology"
                      />
                    </div>
                    <Button onClick={handleMapTypeRecommendation} disabled={loading || (!selectedIndustry && !industrySearch)} className={geodeButtonClass}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MapPin className="mr-2 h-4 w-4" />}
                      {loading ? "Generating..." : "Get Map Type Suggestions"}
                    </Button>
                    {mapTypeSuggestions.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-semibold">Suggested Map Types:</h3>
                        <ul className="space-y-2">
                          {mapTypeSuggestions.map((mapType) => (
                            <li key={mapType.id} className="bg-green-100 p-2 rounded-md">
                              <h4 className="font-semibold">{mapType.name}</h4>
                              <p className="text-sm text-green-700">{mapType.description}</p>
                              <Button variant="outline" size="sm" className={`mt-2 ${geodeButtonClass} text-sm`} onClick={() => addMapTypeToMap(mapType)}>
                                <Plus className="mr-2 h-4 w-4" />
                                Quick Add
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="dashboard">
              <Card className="border-green-200">
                <CardHeader className={geodeCardHeaderClass}>
                  <CardTitle className="text-green-800">Income Analysis Dashboard</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <Button onClick={handleShowDashboard} className={geodeButtonClass}>
                      Generate Dashboard
                    </Button>
                    {showDashboard && (
                      <div className="space-y-8">
                        <div className="h-80">
                          <h3 className="text-lg font-semibold mb-2">Income Distribution</h3>
                          <ResponsiveBar
                            data={incomeData}
                            keys={["value"]}
                            indexBy="income"
                            margin={{ top: 50, right: 130, bottom: 50, left: 60 }}
                            padding={0.3}
                            valueScale={{ type: "linear" }}
                            colors={{ scheme: "greens" }}
                            axisBottom={{
                              tickSize: 5,
                              tickPadding: 5,
                              tickRotation: 0,
                              legend: "Income Range",
                              legendPosition: "middle",
                              legendOffset: 32
                            }}
                            axisLeft={{
                              tickSize: 5,
                              tickPadding: 5,
                              tickRotation: 0,
                              legend: "Percentage",
                              legendPosition: "middle",
                              legendOffset: -40
                            }}
                            labelSkipWidth={12}
                            labelSkipHeight={12}
                            labelTextColor={{ from: "color", modifiers: [["darker", 1.6]] }}
                            legends={[
                              {
                                dataFrom: "keys",
                                anchor: "bottom-right",
                                direction: "column",
                                justify: false,
                                translateX: 120,
                                translateY: 0,
                                itemsSpacing: 2,
                                itemWidth: 100,
                                itemHeight: 20,
                                itemDirection: "left-to-right",
                                itemOpacity: 0.85,
                                symbolSize: 20,
                                effects: [
                                  {
                                    on: "hover",
                                    style: {
                                      itemOpacity: 1
                                    }
                                  }
                                ]
                              }
                            ]}
                          />
                        </div>
                        <div className="h-80">
                          <h3 className="text-lg font-semibold mb-2">Ethnicity Distribution</h3>
                          <ResponsivePie
                            data={ethnicityData}
                            margin={{ top: 40, right: 80, bottom: 80, left: 80 }}
                            innerRadius={0.5}
                            padAngle={0.7}
                            cornerRadius={3}
                            activeOuterRadiusOffset={8}
                            borderWidth={1}
                            borderColor={{ from: "color", modifiers: [["darker", 0.2]] }}
                            arcLinkLabelsSkipAngle={10}
                            arcLinkLabelsTextColor="#333333"
                            arcLinkLabelsThickness={2}
                            arcLinkLabelsColor={{ from: "color" }}
                            arcLabelsSkipAngle={10}
                            arcLabelsTextColor={{ from: "color", modifiers: [["darker", 2]] }}
                            colors={{ scheme: "greens" }}
                            legends={[
                              {
                                anchor: "bottom",
                                direction: "row",
                                justify: false,
                                translateX: 0,
                                translateY: 56,
                                itemsSpacing: 0,
                                itemWidth: 100,
                                itemHeight: 18,
                                itemTextColor: "#999",
                                itemDirection: "left-to-right",
                                itemOpacity: 1,
                                symbolSize: 18,
                                symbolShape: "circle",
                                effects: [
                                  {
                                    on: "hover",
                                    style: {
                                      itemTextColor: "#000"
                                    }
                                  }
                                ]
                              }
                            ]}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}