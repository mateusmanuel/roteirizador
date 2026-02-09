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
  "SPX TN"?: string;
};

// Agora cada linha é um endereço individual (não agrupado)
type AddressPoint = {
  stop: number;
  sequence: number;
  lat: number;
  lng: number;
  address: string;
  spx?: string;
  distanceFromPrev?: number; // metros
};

// ================= PARSE INDIVIDUAL =================

function parseRows(rows: RawRow[]): AddressPoint[] {
  return rows
    .filter((r) => r.Stop && r.Sequence && r.Latitude && r.Longitude)
    .map((r) => ({
      stop: Number(r.Stop),
      sequence: Number(r.Sequence),
      lat: Number(r.Latitude),
      lng: Number(r.Longitude),
      address: String(r["Destination Address"] ?? ""),
      spx: r["SPX TN"] ? String(r["SPX TN"]) : undefined,
    }));
}

// ================= OSRM =================

async function fetchOptimizedTrip(points: AddressPoint[], startIndex: number) {
  if (points.length < 2) return { ordered: points, geometry: [] };

  const reordered = [points[startIndex], ...points.filter((_, i) => i !== startIndex)];

  const coords = reordered.map((p) => `${p.lng},${p.lat}`).join(";");

  const url = `https://router.project-osrm.org/trip/v1/driving/${coords}?overview=full&geometries=geojson&roundtrip=false&source=first&annotations=distance`;

  const res = await fetch(url);
  const data = await res.json();

  const trip = data.trips?.[0];

  const geometry: LatLngExpression[] =
    trip?.geometry?.coordinates?.map((c: [number, number]) => [c[1], c[0]]) ?? [];

  // ordenar pela posição ao longo da geometria
  const ordered = [...reordered].sort((a, b) => {
    const idxA = geometry.findIndex(
      (g) => Math.abs((g as number[])[0] - a.lat) < 0.001 && Math.abs((g as number[])[1] - a.lng) < 0.001
    );

    const idxB = geometry.findIndex(
      (g) => Math.abs((g as number[])[0] - b.lat) < 0.001 && Math.abs((g as number[])[1] - b.lng) < 0.001
    );

    return idxA - idxB;
  });

  // calcular distâncias entre pontos consecutivos
  const legs = trip?.legs ?? [];

  ordered.forEach((p, i) => {
    if (i === 0) return;
    p.distanceFromPrev = legs[i - 1]?.distance ?? 0;
  });

  return { ordered, geometry };
}

// ================= COMPONENT =================

export default function LogisticsStopsApp(): ReactElement {
  const [points, setPoints] = useState<AddressPoint[]>([]);
  const [route, setRoute] = useState<AddressPoint[]>([]);
  const [polyline, setPolyline] = useState<LatLngExpression[]>([]);
  const [startIndex, setStartIndex] = useState<number>(0);
  const [iconFactory, setIconFactory] = useState<any>(null);
  const [delivered, setDelivered] = useState<Set<number>>(new Set());

  // persistência na sessão
  useEffect(() => {
    const saved = sessionStorage.getItem("deliveredPoints");
    if (saved) setDelivered(new Set(JSON.parse(saved)));
  }, []);

  useEffect(() => {
    sessionStorage.setItem("deliveredPoints", JSON.stringify(Array.from(delivered)));
  }, [delivered]);

  // ícones numerados
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

      const parsed = parseRows(json);
      setPoints(parsed);
      setRoute([]);
      setDelivered(new Set());
    };

    reader.readAsBinaryString(file);
  }

  async function calculateRoute() {
    const result = await fetchOptimizedTrip(points, startIndex);
    setRoute(result.ordered);
    setPolyline(result.geometry);
  }

  function toggleDelivered(index: number) {
    const next = new Set(delivered);
    next.has(index) ? next.delete(index) : next.add(index);
    setDelivered(next);
  }

  const nextStop = route.findIndex((_, i) => !delivered.has(i));

  return (
    <div className="h-screen grid grid-cols-1 lg:grid-cols-[1fr_1fr]">
      {/* MAPA */}
      <div className="h-[260px] lg:h-screen">
        {polyline.length > 0 && iconFactory && (
          <Map center={polyline[0]} zoom={15} maxZoom={20} className="h-full">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

            {route.map((p, i) => (
              <Marker key={i} position={[p.lat, p.lng]} icon={iconFactory(i + 1)}>
                <Popup>
                  #{i + 1} • Seq {p.sequence} • Stop {p.stop}
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

        {points.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <select value={startIndex} onChange={(e) => setStartIndex(Number(e.target.value))} className="border p-2">
              {points.map((p, i) => (
                <option key={i} value={i}>
                  Seq {p.sequence} • Stop {p.stop}
                </option>
              ))}
            </select>

            <button onClick={calculateRoute} className="px-3 py-2 bg-blue-600 text-white rounded">
              Calcular rota
            </button>

            {nextStop >= 0 && route[nextStop] && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${route[nextStop].lat},${route[nextStop].lng}`}
                target="_blank"
                className="px-3 py-2 bg-emerald-600 text-white rounded"
              >
                Navegar próximo endereço
              </a>
            )}
          </div>
        )}

        <div className="space-y-2">
          {route.map((p, i) => (
            <div
              key={i}
              className={`border p-3 rounded flex justify-between items-center ${
                delivered.has(i) ? "bg-emerald-500" : ""
              }`}
            >
              <div className="text-sm">
                <div className="font-semibold">
                  #{i + 1} • Seq {p.sequence} • Stop {p.stop}
                </div>

                {p.spx && <div>SPX: {p.spx}</div>}

                <div>{p.address}</div>

                {i > 0 && p.distanceFromPrev !== undefined && (
                  <div className="text-xs text-gray-500">
                    Distância do anterior: {(p.distanceFromPrev / 1000).toFixed(2)} km
                  </div>
                )}
              </div>

              <button onClick={() => toggleDelivered(i)} className="px-2 py-1 text-sm border rounded">
                {delivered.has(i) ? "Desfazer" : "Entregue"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
