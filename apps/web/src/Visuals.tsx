import { useEffect, useRef, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RunRecord } from "./api";
import { tractToGeo } from "../../../packages/sources/src/bridge";
export function download(name: string, content: Blob) {
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Five classes, light to dark, so neighboring tracts with different values look different.
const PALETTE = ["#d4ebe5", "#a3d3c6", "#62b09f", "#2f8a76", "#155e4f"];
const short = (v: number) =>
  Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : String(+v.toFixed(1));

export function Visuals({ run, onValue }: { run: RunRecord; onValue?: (value: string) => void }) {
  const headers = run.answer?.headers ?? [],
    rows = run.answer?.rows ?? [];
  const numeric = headers
    .map((h, i) => ({ h, i }))
    .filter(
      ({ h, i }) =>
        i > 0 &&
        !/geoid|tractfips|95ci/i.test(h) &&
        rows.some((r) => r[i] != null && Number.isFinite(Number(r[i]))),
    );
  const [col, setCol] = useState(numeric[0]?.i ?? 1);
  const chart = useRef<HTMLDivElement>(null),
    mapNode = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const saved = run.answer?.tracts;
  // Answers that never placed city records saved no boundaries; use the county's boundaries shipped with the Desk.
  const [shipped, setShipped] = useState<{ geoid: string; rings: number[][][] }[]>();
  const geoidColumn = headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h));
  const county = rows.find((r) => /^\d{11}$/.test(r[geoidColumn] ?? ""))?.[geoidColumn]?.slice(0, 5);
  useEffect(() => {
    if (saved?.length || !county) return;
    fetch(`/tracts/${county}.json`)
      .then((r) => (r.ok ? r.json() : undefined))
      .then((body) => setShipped(body?.tracts))
      .catch(() => setShipped(undefined));
  }, [saved, county]);
  const shapes = saved?.length ? saved : shipped;
  const values = new Map(rows.map((r) => [r[geoidColumn], r[col] == null ? NaN : Number(r[col])]));
  const names = new Map(rows.map((r) => [r[geoidColumn], r[0]]));
  const sorted = [...values.values()].filter(Number.isFinite).sort((a, b) => a - b);
  // Quantile breaks: each class holds about a fifth of the tracts with a value.
  const breaks = sorted.length
    ? [...new Set([1, 2, 3, 4].map((q) => sorted[Math.floor((q * sorted.length) / 5)]!))]
    : [];
  const classOf = (v: number) => breaks.filter((b) => v >= b).length;
  const legend = sorted.length
    ? [sorted[0]!, ...breaks].map((from, i) => ({
        color: PALETTE[i]!,
        label: `${short(from)} to ${short(i < breaks.length ? breaks[i]! : sorted[sorted.length - 1]!)}`,
      }))
    : [];
  useEffect(() => {
    if (!mapNode.current || !shapes?.length) return;
    const map = L.map(mapNode.current, { scrollWheelZoom: false, zoomSnap: 0.25 });
    if (run.mode !== "recorded")
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
    const layer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: shapes.map((t) => ({ ...tractToGeo(t), properties: { geoid: t.geoid } })),
      },
      {
        style: (f: {
          properties: {
            geoid: string;
          };
        }) => {
          const v = values.get(f.properties.geoid);
          const known = v !== undefined && Number.isFinite(v);
          return {
            color: "#40524b",
            weight: 0.8,
            fillColor: known ? PALETTE[classOf(v)] : "#9aa49f",
            fillOpacity: known ? 0.85 : 0.25,
          };
        },
        onEachFeature: (
          f: {
            properties: {
              geoid: string;
            };
          },
          layer: {
            bindTooltip: (el: HTMLElement) => void;
            on: (event: string, fn: () => void) => void;
          },
        ) => {
          const el = document.createElement("span");
          const v = values.get(f.properties.geoid);
          el.textContent = `${names.get(f.properties.geoid) ?? f.properties.geoid}: ${
            v !== undefined && Number.isFinite(v) ? v : "no result"
          } (${headers[col]?.replace(/_/g, " ")})`;
          layer.bindTooltip(el);
          layer.on("click", () => onValue?.(f.properties.geoid));
        },
      },
    ).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [8, 8] });
    return () => map.remove();
  }, [shapes, col]);
  const png = async () => {
    const svg = chart.current?.querySelector("svg");
    if (!svg) return;
    try {
      const source = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
      const url = URL.createObjectURL(source);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 500;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 1000, 500);
      ctx.drawImage(img, 0, 0, 1000, 500);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => b && download(`${run.id}-chart.png`, b));
    } catch {
      setNotice("The chart could not be exported. Try again.");
    }
  };
  if (!numeric.length) return null;
  return (
    <section className="card">
      <h2>Compare the rows</h2>
      <label>
        Measure{" "}
        <select aria-label="Chart measure" value={col} onChange={(e) => setCol(Number(e.target.value))}>
          {numeric.map(({ h, i }) => (
            <option key={h} value={i}>
              {h.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Choose a measure to update the map and the chart. The chart shows the first{" "}
        {Math.min(rows.length, 15)} result rows in query order.
      </p>
      {shapes?.length ? (
        <>
          <div ref={mapNode} className="tract-map" role="region" aria-label="Map of census tracts" />
          <ul className="legend" aria-label="Map legend">
            {legend.map((l) => (
              <li key={l.label}>
                <span className="swatch" style={{ background: l.color }} aria-hidden="true" />
                {l.label}
              </li>
            ))}
            <li>
              <span className="swatch none" aria-hidden="true" />
              No result
            </li>
          </ul>
          <p className="muted">
            Darker means a higher {headers[col]?.replace(/_/g, " ")}; each shade holds about a fifth of the
            tracts. Boundaries: US Census TIGERweb,{" "}
            {saved?.length ? "read through Zetaris for this run." : "saved with Fieldwork."}
          </p>
        </>
      ) : null}
      <div ref={chart} className="chart" role="img" aria-label={`Bar chart of ${headers[col]}`}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            margin={{ bottom: 65, left: 0, right: 8 }}
            data={rows
              .slice(0, 15)
              .map((r) => ({ name: r[0], value: r[col] == null ? null : Number(r[col]) }))}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              interval={0}
              angle={-55}
              textAnchor="end"
              height={75}
              tick={{ fontSize: 11 }}
              tickFormatter={(value: string) => String(value).replace(/^Census Tract\s+/i, "Tract ")}
            />
            <YAxis width={60} />
            <Tooltip />
            <Bar
              dataKey="value"
              fill="#2f8a76"
              isAnimationActive={false}
              onClick={(d) => onValue?.(String(d.value))}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <button className="ghost" onClick={png}>
        Export chart PNG
      </button>
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
