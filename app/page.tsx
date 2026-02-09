"use client";

import { useState, ChangeEvent, useEffect, ReactElement } from "react";
import * as XLSX from "xlsx";
import { motion } from "framer-motion";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";

const Map = dynamic<any>(() => import("react-leaflet").then((m) => m.MapContainer), { ssr: false });
const TileLayer = dynamic<any>(() => import("react-leaflet").then((m) => m.TileLayer), { ssr: false });
const Marker = dynamic<any>(() => import("react-leaflet").then((m) => m.Marker), { ssr: false });
const Polyline = dynamic<any>(() => import("react-leaflet").then((m) => m.Polyline), { ssr: false });
const Popup = dynamic<any>(() => import("react-leaflet").then((m) => m.Popup), { ssr: false });

// ================= TYPES =================

type RawRow = {
  Stop?: number | string;
  Sequence?: number | string;
  Latitude?: number | string;
  Longitude?: number | string;
  "Destination Address"?: string;
};

type StopGroup = {
  stop: number;
  sequences: number[];
  lat: number;
  lng: number;
  address: string[];
};

// ================= GROUP =================

function groupByStop(rows: RawRow[]): StopGroup[] {
  const map: Record<number, StopGroup> = {};

  rows.forEach((r) => {
    if (!r.Stop || !r.Sequence) return;

    const stop = Number(r.Stop);

    if (!map[stop]) {
      map[stop] = {
        stop,
        sequences: [],
        lat: Number(r.Latitude),
        lng: Number(r.Longitude),
        address: [],
      };
    }

    map[stop].sequences.push(Number(r.Sequence));
    if (r["Destination Address"]) map[stop].address.push(String(r["Destination Address"]));
  });

  return Object.values(map);
}

// ================= OSRM =================

async function fetchOptimizedTrip(stops: StopGroup[], startIndex: number) {
  if (stops.length < 2) return { ordered: stops, geometry: [] };

  const reordered = [stops[startIndex], ...stops.filter((_, i) => i !== startIndex)];

  const coords = reordered.map((s) => `${s.lng},${s.lat}`).join(";");

  const url = `https://router.project-osrm.org/trip/v1/driving/${coords}?overview=full&geometries=geojson&roundtrip=false&source=first`;

  const res = await fetch(url);
  const data = await res.json();

  const trip = data.trips?.[0];

  const geometry: LatLngExpression[] =
    trip?.geometry?.coordinates?.map((c: [number, number]) => [c[1], c[0]]) ?? [];

  // ordenar pela posição ao longo da geometria
  const orderedStops = [...reordered].sort((a, b) => {
    const indexA = geometry.findIndex(
      (g) => Math.abs((g as number[])[0] - a.lat) < 0.001 && Math.abs((g as number[])[1] - a.lng) < 0.001
    );

    const indexB = geometry.findIndex(
      (g) => Math.abs((g as number[])[0] - b.lat) < 0.001 && Math.abs((g as number[])[1] - b.lng) < 0.001
    );

    return indexA - indexB;
  });

  return { ordered: orderedStops, geometry };
}

// ================= COMPONENT =================

export default function LogisticsStopsApp(): ReactElement {
  const [stops, setStops] = useState<StopGroup[]>([]);
  const [routeStops, setRouteStops] = useState<StopGroup[]>([]);
  const [polyline, setPolyline] = useState<LatLngExpression[]>([]);
  const [startIndex, setStartIndex] = useState<number>(0);
  const [iconFactory, setIconFactory] = useState<any>(null);
  const [delivered, setDelivered] = useState<Set<number>>(new Set());

  // carregar entregas da sessão
  useEffect(() => {
    const saved = sessionStorage.getItem("deliveredStops");
    if (saved) setDelivered(new Set(JSON.parse(saved)));
  }, []);

  useEffect(() => {
    sessionStorage.setItem("deliveredStops", JSON.stringify(Array.from(delivered)));
  }, [delivered]);

  // carregar ícone numerado
  useEffect(() => {
    import("leaflet").then((L) => {
      setIconFactory(() => (index: number) =>
        L.divIcon({
          className: "",
          html: `<div style="background:#059669;color:white;border-radius:999px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;box-shadow:0 0 0 2px white;">${index}</div>`,
        })
      );
    });
  }, []);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = async (evt) => {
      const wb = XLSX.read(evt.target?.result, { type: "binary" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<RawRow>(sheet);

      const grouped = groupByStop(json);
      setStops(grouped);
      setRouteStops([]);
      setDelivered(new Set());
    };

    reader.readAsBinaryString(file);
  }

  async function calculateRoute() {
    const result = await fetchOptimizedTrip(stops, startIndex);
    setRouteStops(result.ordered);
    setPolyline(result.geometry);
  }

  function toggleDelivered(index: number) {
    const next = new Set(delivered);
    next.has(index) ? next.delete(index) : next.add(index);
    setDelivered(next);
  }

  const nextStop = routeStops.findIndex((_, i) => !delivered.has(i));

  return (
    <div className="h-screen grid grid-cols-1 lg:grid-cols-[1fr_1fr]">
      {/* MAPA */}
      <div className="h-[260px] lg:h-screen">
        {polyline.length > 0 && iconFactory && (
          <Map center={polyline[0]} zoom={12} className="h-full">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

            {routeStops.map((s, i) => (
              <Marker key={i} position={[s.lat, s.lng]} icon={iconFactory(i + 1)}>
                <Popup>
                  #{i + 1} • Stop {s.stop}
                </Popup>
              </Marker>
            ))}

            <Polyline positions={polyline} />
          </Map>
        )}
      </div>

      {/* PAINEL */}
      <div className="p-4 overflow-y-auto space-y-4">
        <motion.h1 className="text-2xl font-bold">Roteirizador</motion.h1>

        <input type="file" accept=".xlsx" onChange={handleUpload} />

        {stops.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <select value={startIndex} onChange={(e) => setStartIndex(Number(e.target.value))} className="border p-2">
              {stops.map((s, i) => (
                <option key={i} value={i}>
                  Stop {s.stop}
                </option>
              ))}
            </select>

            <button onClick={calculateRoute} className="px-3 py-2 bg-blue-600 text-white rounded">
              Calcular rota
            </button>

            {nextStop >= 0 && routeStops[nextStop] && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${routeStops[nextStop].lat},${routeStops[nextStop].lng}`}
                target="_blank"
                className="px-3 py-2 bg-emerald-600 text-white rounded"
              >
                Navegar próximo stop
              </a>
            )}
          </div>
        )}

        <div className="space-y-2">
          {routeStops.map((s, i) => (
            <div
              key={i}
              className={`border p-3 rounded flex justify-between items-center ${
                delivered.has(i) ? "bg-emerald-600" : ""
              }`}
            >
              <div>
                <strong>
                  #{i + 1} • Stop {s.stop}
                </strong>
                <div className="text-sm">{s.address.join(" | ")}</div>
              </div>

              <button
                onClick={() => toggleDelivered(i)}
                className="px-2 py-1 text-sm border rounded"
              >
                {delivered.has(i) ? "Desfazer" : "Entregue"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
