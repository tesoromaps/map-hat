"use client"

import Link from "next/link"
import dynamic from "next/dynamic"

const AiEnhancedMapComponent = dynamic(
  () => import("@/components/ai-enhanced-map-component").then((m) => m.AiEnhancedMapComponent),
  { ssr: false },
)

export default function Page() {
  return (
    <div className="relative">
      <AiEnhancedMapComponent />
      <Link
        href="/simulator"
        className="fixed bottom-4 right-4 z-50 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-xl hover:bg-cyan-500"
      >
        🏙 City Block Simulator
      </Link>
    </div>
  )
}
