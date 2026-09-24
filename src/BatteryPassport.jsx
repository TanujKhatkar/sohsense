import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getVehicles,
  getVehicleHistory,
  predictSOH,
  exportPassport,
  downloadJSON,
  deleteRecord,
  clearAll,
} from "./sohStore";

/* --- Small SVG trend chart: SOH over time + projected dashed tail --- */
function TrendChart({ history, prediction, isCar, height = 130 }) {
  const w = 520;
  const h = height;
  const pad = { l: 34, r: 16, t: 14, b: 22 };

  const points = history.map((d) => ({
    t: new Date(d.savedAt).getTime(),
    y: d.soh,
    date: d.savedAt,
  }));

  if (!points.length) return null;

  const projected = prediction
    ? {
        t: new Date(points[points.length - 1].t + prediction.monthsAhead * 30.44 * 24 * 3600 * 1000).getTime(),
        y: prediction.projected,
      }
    : null;

  const allT = [...points.map((p) => p.t), ...(projected ? [projected.t] : [])];
  const tMin = Math.min(...allT);
  const tMax = Math.max(...allT);
  const tSpan = tMax - tMin || 1;

  const yAll = [...points.map((p) => p.y), ...(projected ? [projected.y] : [])];
  const yMin = Math.max(50, Math.floor((Math.min(...yAll) - 4) / 5) * 5);
  const yMax = Math.min(100, Math.ceil((Math.max(...yAll) + 4) / 5) * 5);
  const ySpan = yMax - yMin || 1;

  const X = (t) => pad.l + ((t - tMin) / tSpan) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - yMin) / ySpan) * (h - pad.t - pad.b);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${X(p.t).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${X(points[points.length - 1].t).toFixed(1)} ${h - pad.b} L ${X(points[0].t).toFixed(1)} ${h - pad.b} Z`;

  const accent = isCar ? "#38BDF8" : "#F59E0B";
  const gridColor = isCar ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
  const textColor = isCar ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";

  const ticksY = [yMin, Math.round((yMin + yMax) / 2), yMax];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.28" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>

      {ticksY.map((tv) => (
        <g key={tv}>
          <line x1={pad.l} y1={Y(tv)} x2={w - pad.r} y2={Y(tv)} stroke={gridColor} strokeWidth="1" />
          <text x={pad.l - 7} y={Y(tv) + 3} textAnchor="end" fontSize="9" fontFamily="JetBrains Mono, monospace" fill={textColor}>
            {tv}
          </text>
        </g>
      ))}

      <path d={areaPath} fill="url(#trendFill)" />
      <path d={linePath} fill="none" stroke={accent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

      {projected && (
        <>
          <line
            x1={X(points[points.length - 1].t)}
            y1={Y(points[points.length - 1].y)}
            x2={X(projected.t)}
            y2={Y(projected.y)}
            stroke={accent}
            strokeWidth="2"
            strokeDasharray="5 4"
            opacity="0.75"
          />
          <circle cx={X(projected.t)} cy={Y(projected.y)} r="3.5" fill="none" stroke={accent} strokeWidth="2" opacity="0.85" />
          <text x={X(projected.t)} y={Y(projected.y) - 8} textAnchor="middle" fontSize="9" fontFamily="JetBrains Mono, monospace" fill={textColor}>
            {prediction.projected}%
          </text>
        </>
      )}

      {points.map((p, i) => (
        <circle key={i} cx={X(p.t)} cy={Y(p.y)} r={i === points.length - 1 ? 4.5 : 3} fill={accent} stroke={isCar ? "#0F141D" : "#fff"} strokeWidth="1.6" />
      ))}
    </svg>
  );
}

export default function BatteryPassport({ vehicleType, onClose, refreshKey = 0 }) {
  const isCar = vehicleType === "car";
  const [vehicles, setVehicles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const v = getVehicles();
    setVehicles(v);
    if (v.length && !selected) setSelected(v[0].vehicleId);
  }, [refreshKey, tick]);

  const history = useMemo(() => (selected ? getVehicleHistory(selected) : []), [selected, refreshKey, tick]);
  const prediction = useMemo(() => (selected ? predictSOH(selected, 6) : null), [selected, refreshKey, tick]);

  const latest = history[history.length - 1];

  const card = `rounded-[22px] border ${isCar ? "bg-[#121821] border-white/[0.07]" : "bg-white border-stone-200"}`;
  const label = `mono text-[10px] tracking-widest uppercase ${isCar ? "text-white/35" : "text-stone-400"}`;
  const strong = isCar ? "text-white" : "text-stone-900";
  const muted = isCar ? "text-white/50" : "text-stone-600";
  const mono = (extra = "") => `mono ${extra} ${isCar ? "text-white" : "text-stone-800"}`;

  const handleExport = () => {
    const doc = exportPassport(selected);
    if (doc) {
      const name = (latest?.makeModel || "ev").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      downloadJSON(`sohsense-passport-${name}.json`, doc);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-6"
    >
      {/* header row */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onClose}
          className={`px-4 py-2 rounded-full text-[12px] font-bold border flex items-center gap-2 ${
            isCar ? "bg-white/5 border-white/10 text-white/60 hover:text-white" : "bg-white border-stone-200 text-stone-600 hover:text-stone-900"
          }`}
        >
          ← Back
        </button>
        <div>
          <div className={`text-[18px] font-black tracking-tight ${strong}`}>Battery Passport</div>
          <div className={`mono text-[10px] ${muted}`}>On-device health record • {vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"}</div>
        </div>
        <div
          className={`ml-auto mono text-[10px] px-3 py-1.5 rounded-full border ${
            isCar ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300" : "bg-emerald-50 border-emerald-200 text-emerald-800"
          }`}
        >
          🔒 100% ON-DEVICE • NO BACKEND
        </div>
      </div>

      {vehicles.length === 0 ? (
        <div className={`${card} p-8 text-center space-y-3`}>
          <div className="text-[34px]">🪪</div>
          <div className={`text-[15px] font-bold ${strong}`}>No saved checks yet</div>
          <div className={`text-[12.5px] max-w-[46ch] mx-auto ${muted}`}>
            Run a check and tap <b>“Save to Passport”</b> on the results screen. Every check is stored with its date, SOH range and usage
            profile — so you can track degradation over months and prove battery health at resale.
          </div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-6 items-start">
          {/* vehicle list */}
          <div className={`${card} p-4 space-y-2`}>
            <div className={label}>Saved vehicles</div>
            {vehicles.map((v) => {
              const active = v.vehicleId === selected;
              return (
                <button
                  key={v.vehicleId}
                  onClick={() => setSelected(v.vehicleId)}
                  className={`w-full text-left rounded-[14px] p-3 border transition-all ${
                    active
                      ? isCar
                        ? "bg-cyan-500/10 border-cyan-400/30"
                        : "bg-amber-500/10 border-amber-500/30"
                      : isCar
                      ? "bg-white/[0.03] border-white/[0.06] hover:border-white/15"
                      : "bg-stone-50 border-stone-200 hover:border-stone-300"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className={`text-[12.5px] font-bold truncate ${strong}`}>{v.makeModel}</div>
                    <div className={`mono text-[13px] font-black ${isCar ? "text-cyan-300" : "text-amber-700"}`}>{Math.round(v.soh)}%</div>
                  </div>
                  <div className={`mono text-[10px] mt-1 ${muted}`}>
                    {Math.round(v.odometer).toLocaleString("en-IN")} km •{" "}
                    {getVehicleHistory(v.vehicleId).length} check{getVehicleHistory(v.vehicleId).length === 1 ? "" : "s"} •{" "}
                    {new Date(v.savedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                  </div>
                </button>
              );
            })}
            <button
              onClick={() => {
                if (confirm("Delete all passport data from this device?")) {
                  clearAll();
                  setVehicles([]);
                  setSelected(null);
                }
              }}
              className={`w-full mt-2 py-2 rounded-[12px] text-[11px] font-bold border ${
                isCar ? "bg-red-500/10 border-red-500/20 text-red-300" : "bg-red-50 border-red-200 text-red-700"
              }`}
            >
              Clear all passport data
            </button>
          </div>

          {/* detail */}
          <div className="space-y-5">
            {/* prediction card */}
            {prediction && (
              <div className={`${card} p-5`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className={label}>Predicted SOH — {prediction.monthsAhead} months ahead</div>
                    <div className="flex items-baseline gap-3 mt-2">
                      <div className={`mono text-[30px] font-black tracking-tighter leading-none ${strong}`}>
                        {prediction.projected}%
                      </div>
                      <div className={`mono text-[12px] ${muted}`}>
                        from {prediction.current}% today
                      </div>
                    </div>
                  </div>
                  <div className={`mono text-[10px] text-right px-3 py-2 rounded-[12px] border ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/45" : "bg-stone-50 border-stone-200 text-stone-500"}`}>
                    <div>likelihood score</div>
                    <div className={`text-[15px] font-black ${strong}`}>{prediction.confidence}%</div>
                    <div className={isCar ? "text-white/30" : "text-stone-400"}>{prediction.method}</div>
                  </div>
                </div>

                <div className="mt-4">
                  <TrendChart history={history} prediction={prediction} isCar={isCar} />
                </div>

                <div className={`mt-3 grid grid-cols-2 md:grid-cols-3 gap-2 mono text-[10px]`}>
                  <div className={`rounded-[12px] p-2.5 border ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/50" : "bg-stone-50 border-stone-200 text-stone-600"}`}>
                    <div className={isCar ? "text-white/30" : "text-stone-400"}>Decay rate</div>
                    <div className={`text-[13px] font-bold ${strong}`}>{prediction.ratePerYear}% / yr</div>
                  </div>
                  <div className={`rounded-[12px] p-2.5 border ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/50" : "bg-stone-50 border-stone-200 text-stone-600"}`}>
                    <div className={isCar ? "text-white/30" : "text-stone-400"}>To 80% threshold</div>
                    <div className={`text-[13px] font-bold ${strong}`}>
                      {prediction.monthsTo80 === null ? "—" : prediction.monthsTo80 === 0 ? "Passed" : `${prediction.monthsTo80} mo`}
                    </div>
                  </div>
                  <div className={`rounded-[12px] p-2.5 border ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/50" : "bg-stone-50 border-stone-200 text-stone-600"}`}>
                    <div className={isCar ? "text-white/30" : "text-stone-400"}>Data points</div>
                    <div className={`text-[13px] font-bold ${strong}`}>{prediction.points}</div>
                  </div>
                </div>

                {prediction.points < 3 && (
                  <div className={`mt-3 text-[11px] leading-[1.5] p-3 rounded-[12px] border ${isCar ? "bg-amber-500/10 border-amber-500/20 text-amber-200/80" : "bg-amber-50 border-amber-200 text-amber-900/80"}`}>
                    ⓘ Prediction is running on the physics decay rate. Add more checks over the coming months — with 3+ records the
                    model switches to a regression + physics blend for a tighter projection.
                  </div>
                )}
              </div>
            )}

            {/* history table */}
            <div className={`${card} p-5`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className={label}>Health history — {latest?.makeModel}</div>
                <div className="flex gap-2">
                  <button
                    onClick={handleExport}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold border ${
                      isCar ? "bg-white/5 border-white/10 text-white/70 hover:text-white" : "bg-white border-stone-200 text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    ⬇ Export passport (JSON)
                  </button>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {[...history].reverse().map((r, i) => (
                  <div
                    key={r.id}
                    className={`flex items-center gap-3 rounded-[12px] p-3 border ${
                      isCar ? "bg-white/[0.03] border-white/[0.06]" : "bg-stone-50 border-stone-200"
                    }`}
                  >
                    <div className={`mono text-[10px] w-[74px] ${muted}`}>
                      {new Date(r.savedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                    </div>
                    <div className={`mono text-[13px] font-black w-[74px] ${strong}`}>
                      {Math.round(r.low)}–{Math.round(r.high)}%
                    </div>
                    <div className={`mono text-[10px] flex-1 ${muted}`}>
                      {Math.round(r.odometer).toLocaleString("en-IN")} km • {Math.round(r.cycles)} cycles • {r.inputs.chargingHabit} • {r.inputs.parking}
                    </div>
                    <button
                      onClick={() => {
                        if (confirm("Delete this record?")) {
                          deleteRecord(r.id);
                          setTick((t) => t + 1);
                        }
                      }}
                      className={`mono text-[10px] px-2 py-1 rounded-full border ${
                        isCar ? "border-white/10 text-white/35 hover:text-red-300" : "border-stone-200 text-stone-400 hover:text-red-600"
                      }`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <div className={`mt-4 mono text-[10px] leading-[1.5] p-3 rounded-[12px] border ${isCar ? "bg-white/[0.02] border-white/5 text-white/30" : "bg-stone-50 border-stone-200 text-stone-500"}`}>
                Every entry is an estimate from usage patterns — not a certified or lab-measured reading. Passport stays on this device
                until you export or clear it.
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
