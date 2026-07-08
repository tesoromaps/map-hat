import dynamic from "next/dynamic"

const CityBlockSimulator = dynamic(
  () => import("@/components/city-simulator/city-block-simulator").then((m) => m.CityBlockSimulator),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen w-full items-center justify-center bg-slate-950 font-mono text-sm text-cyan-300">
        Booting city block simulator…
      </div>
    ),
  },
)

export const metadata = {
  title: "City Block Simulator",
  description: "Multi-agent traffic simulation with live detection, tracts, day/night cycle and geo data import",
}

export default function SimulatorPage() {
  return <CityBlockSimulator />
}
