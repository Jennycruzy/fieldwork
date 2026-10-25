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
export function Visuals({ run, onValue }: {
    run: RunRecord;
    onValue?: (value: string) => void;
}) {
    const headers = run.answer?.headers ?? [], rows = run.answer?.rows ?? [];
    const numeric = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => i > 0 && !/geoid|tractfips|95ci/i.test(h) && rows.some((r) => r[i] != null && Number.isFinite(Number(r[i]))));
    const [col, setCol] = useState(numeric[0]?.i ?? 1);
    const chart = useRef<HTMLDivElement>(null), mapNode = useRef<HTMLDivElement>(null);
    const [notice, setNotice] = useState("");
    const shapes = run.answer?.tracts;
    useEffect(() => {
        if (!mapNode.current || !shapes?.length)
            return;
        const geoid = headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h));
        const values = new Map(rows.map((r) => [r[geoid], r[col] == null ? NaN : Number(r[col])]));
        const finite = [...values.values()].filter(Number.isFinite);
        const max = Math.max(...finite, 1), min = Math.min(...finite, 0);
        const map = L.map(mapNode.current, { scrollWheelZoom: false });
        if (run.mode !== "recorded") L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
        const layer = L.geoJSON({ type: "FeatureCollection", features: shapes.map((t) => ({ ...tractToGeo(t), properties: { geoid: t.geoid } })) }, { style: (f: {
                properties: {
                    geoid: string;
                };
            }) => { const v = values.get(f.properties.geoid); return { color: "#365468", weight: 1, fillColor: v === undefined || !Number.isFinite(v) ? "#999" : "#147d92", fillOpacity: v === undefined || !Number.isFinite(v) ? 0.15 : 0.2 + 0.65 * (v - min) / (max - min || 1) }; }, onEachFeature: (f: {
                properties: {
                    geoid: string;
                };
            }, layer: {
                bindTooltip: (el: HTMLElement) => void; on: (event:string, fn:()=>void)=>void;
            }) => { const el = document.createElement("span"); const v = values.get(f.properties.geoid); el.textContent = `${f.properties.geoid}: ${Number.isFinite(v) ? v : "No result"} (${headers[col]})`; layer.bindTooltip(el); layer.on("click",()=>onValue?.(f.properties.geoid)); } }).addTo(map);
        map.fitBounds(layer.getBounds());
        return () => map.remove();
    }, [shapes, col]);
    const png = async () => {
        const svg = chart.current?.querySelector("svg");
        if (!svg)
            return;
        try {
            const source = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
            const url = URL.createObjectURL(source);
            const img = new Image();
            await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; img.src = url; });
            const canvas = document.createElement("canvas");
            canvas.width = 1000;
            canvas.height = 500;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, 1000, 500);
            ctx.drawImage(img, 0, 0, 1000, 500);
            URL.revokeObjectURL(url);
            canvas.toBlob((b) => b && download(`${run.id}-chart.png`, b));
        }
        catch {
            setNotice("The chart could not be exported. Try again.");
        }
    };
    if (!numeric.length)
        return null;
    return <section className="card"><h2>Compare the rows</h2><label>Measure <select aria-label="Chart measure" value={col} onChange={(e) => setCol(Number(e.target.value))}>{numeric.map(({ h, i }) => <option key={h} value={i}>{h.replace(/_/g, " ")}</option>)}</select></label><p className="muted">Chart shows the first {Math.min(rows.length, 15)} result rows in query order. Choose a measure to update the chart and map.</p><div ref={chart} className="chart" role="img" aria-label={`Bar chart of ${headers[col]}`}><ResponsiveContainer width="100%" height={320}><BarChart margin={{bottom:65,left:0,right:8}} data={rows.slice(0, 15).map((r) => ({ name: r[0], value: r[col] == null ? null : Number(r[col]) }))}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="name" interval={0} angle={-55} textAnchor="end" height={75} tick={{fontSize:11}} tickFormatter={(value:string)=>String(value).replace(/^Census Tract\s+/i,"Tract ")}/><YAxis width={60}/><Tooltip /><Bar dataKey="value" fill="#147d92" isAnimationActive={false} onClick={(d)=>onValue?.(String(d.value))}/></BarChart></ResponsiveContainer></div><button onClick={png}>Export chart PNG</button>{notice && <p role="alert">{notice}</p>}{shapes?.length ? <><h2>Neighborhoods (census tracts)</h2><div ref={mapNode} className="tract-map" role="region" aria-label="Map of census tracts"/><p className="muted">Darker shading means a higher {headers[col]?.replace(/_/g, " ")}. Gray means no result. Boundaries: US Census TIGERweb, read through Zetaris.</p></> : <p className="muted">This earlier recording has no saved boundaries. Re-run live to include a map.</p>}</section>;
}
