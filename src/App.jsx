import { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import BatteryPassport from "./BatteryPassport";
import { saveRecord, getVehicles } from "./sohStore";

/* --- PWA install prompt hook --- */
function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [platform, setPlatform] = useState("desktop");

  useEffect(() => {
    const ua = window.navigator.userAgent || "";
    // iPadOS 13+ reports as MacIntel but has touch points
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
    setIsIOS(iOS);
    setPlatform(iOS ? "ios" : /Android/i.test(ua) ? "android" : "desktop");

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) setInstalled(true);

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return false;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setDeferred(null);
    return outcome === "accepted";
  };

  // real install dialog available (Android Chrome / desktop Chrome-Edge)
  const canInstall = !!deferred;
  // Safari never fires beforeinstallprompt, so iOS needs written instructions
  const needsIOSHelp = isIOS && !installed;
  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);

  return { canInstall, needsIOSHelp, installed, isStandalone, platform, install };
}

/* ==================== MODEL DATABASE ==================== */
const MODEL_DB = {
  car: [
    { name: "Tata Nexon EV 40.5", capacity: 40.5, chemistry: "LFP", cooling: "Active liquid", range: 465 },
    { name: "Tata Nexon EV 30", capacity: 30, chemistry: "LFP", cooling: "Active liquid", range: 325 },
    { name: "Tata Tiago EV", capacity: 24, chemistry: "LFP", cooling: "Active liquid", range: 315 },
    { name: "Tata Punch EV", capacity: 35, chemistry: "LFP", cooling: "Active liquid", range: 421 },
    { name: "MG ZS EV", capacity: 50.3, chemistry: "NMC", cooling: "Active liquid", range: 461 },
    { name: "Mahindra XUV400", capacity: 39.4, chemistry: "NMC", cooling: "Active liquid", range: 456 },
    { name: "Hyundai Ioniq 5", capacity: 72.6, chemistry: "NMC", cooling: "Active liquid", range: 631 },
    { name: "BYD Atto 3", capacity: 60.48, chemistry: "LFP", cooling: "Active liquid", range: 521 },
    { name: "Kia EV6", capacity: 77.4, chemistry: "NMC", cooling: "Active liquid", range: 708 },
    { name: "MG Comet EV", capacity: 17.3, chemistry: "LFP", cooling: "Passive-air", range: 230 },
  ],
  scooter: [
    { name: "Ola S1 Pro Gen2", capacity: 4, chemistry: "NMC", cooling: "Passive-air", range: 195, format: "Fixed" },
    { name: "Ather 450X", capacity: 3.7, chemistry: "NMC", cooling: "Passive-air", range: 146, format: "Fixed" },
    { name: "TVS iQube S", capacity: 3.4, chemistry: "NMC", cooling: "Passive-air", range: 145, format: "Fixed" },
    { name: "Bajaj Chetak", capacity: 3, chemistry: "NMC", cooling: "Passive-air", range: 126, format: "Fixed" },
    { name: "Hero Vida V1 Pro", capacity: 3.94, chemistry: "NMC", cooling: "Passive-air", range: 165, format: "Removable" },
    { name: "Bounce Infinity E1", capacity: 2, chemistry: "LFP", cooling: "Passive-air", range: 85, format: "Swappable network" },
    { name: "Simple One", capacity: 5, chemistry: "NMC", cooling: "Passive-air", range: 212, format: "Fixed" },
    { name: "Ola S1 Air", capacity: 3, chemistry: "NMC", cooling: "Passive-air", range: 151, format: "Fixed" },
  ],
};

/* ==================== CALCULATION - PURE HEURISTIC ==================== */
/**
 * Heuristic SOH estimator - NOT certified, NOT lab measured.
 * Estimates permanent capacity loss from usage patterns.
 * SOH = 100 − age_loss − cycle_loss − DoD_penalty − fast_charge_penalty − heat_penalty − style_penalty
 * Clamp 50-100%, display as ±3-5% range.
 */
function calculateSOH(form, vehicleType) {
  const today = new Date();
  let ageYears = 1.5;
  try {
    if (form.purchaseDate) {
      const p = new Date(form.purchaseDate);
      if (!isNaN(p)) {
        ageYears = Math.max(0.1, (today - p) / (1000 * 60 * 60 * 24 * 365.25));
      }
    }
  } catch {}

  const totalKm = parseFloat(form.odometer) || 0;
  const fullRange = parseFloat(form.claimedRange) || (vehicleType === "car" ? 300 : 100);
  const equivalentCycles = fullRange > 0 ? totalKm / fullRange : 0;

  // age_loss: 1.0-1.5%/yr LFP, 1.5-2.5%/yr NMC/NCA
  let chem = form.chemistry || "Not sure";
  let ageRate = 1.8;
  if (chem === "LFP") ageRate = 1.2;
  else if (chem === "NMC" || chem === "NCA") ageRate = 2.0;
  if (form.climate === "Hot plains") ageRate += 0.4;
  else if (form.climate === "Moderate") ageRate += 0.1;
  // scooter parked in sun ages faster
  if (vehicleType === "scooter" && form.parking === "Direct sun") ageRate += 0.2;
  const ageLoss = ageYears * ageRate;

  // cycle_loss: equivalent_cycles × [0.015-0.025% car | 0.025-0.045% scooter]
  let cycleFactor = vehicleType === "car" ? 0.02 : 0.035;
  if (form.drivingStyle === "Aggressive") cycleFactor += 0.008;
  if (form.drivingStyle === "Gentle") cycleFactor = Math.max(0.01, cycleFactor - 0.005);
  if (vehicleType === "car" && form.cooling === "Passive-air") cycleFactor += 0.006;
  if (vehicleType === "scooter" && form.usageType === "Commercial-delivery") cycleFactor += 0.005;
  const cycleLoss = equivalentCycles * cycleFactor;

  // DoD_penalty: +0.3-0.5%/yr extra if 0-100% vs 20-80%
  let dodRate = 0;
  if (form.chargingHabit === "0-100%") dodRate = 0.45;
  else if (form.chargingHabit === "Mixed") dodRate = 0.2;
  let dodPenalty = dodRate * ageYears;
  if (form.idle100 === "Yes") dodPenalty += 1.2;

  // fast_charge_penalty: ~2x weighting for scooters
  const fastMapCar = { Never: 0, Occasionally: 0.6, Weekly: 1.6, "Almost every charge": 3.8 };
  const fastMapScooter = { Never: 0, Occasionally: 1.2, Weekly: 3.2, "Almost every charge": 7.2 };
  let fastBase = vehicleType === "car" ? fastMapCar[form.fastFreq] ?? 0 : fastMapScooter[form.fastFreq] ?? 0;
  if (vehicleType === "car" && form.cooling === "Passive-air" && fastBase > 0) fastBase *= 1.35;
  if (form.chargingSource === "DC fast") fastBase += vehicleType === "car" ? 0.6 : 1.2;
  if (form.chargingSource === "Public AC" && form.fastFreq === "Almost every charge") fastBase += 0.5;
  const fastPenalty = fastBase + (equivalentCycles > 150 ? (equivalentCycles - 150) * 0.003 : 0);

  // heat_penalty: climate + parking; ~2x scooters; extra if commercial
  let heat = 0;
  if (form.climate === "Hot plains") heat += vehicleType === "car" ? 2.2 : 4.2;
  else if (form.climate === "Moderate") heat += vehicleType === "car" ? 0.6 : 1.1;
  else if (form.climate === "Cold-hilly") heat += 0.15;

  if (form.parking === "Direct sun") heat += vehicleType === "car" ? 1.1 : 2.3;
  else if (form.parking === "Shaded") heat += vehicleType === "car" ? 0.4 : 0.9;

  if (form.usageType === "Commercial-delivery") heat += vehicleType === "car" ? 1.2 : 2.4;
  if (form.usageType === "Occasional" && ageYears > 2) heat += 0.4; // calendar aging while idle

  const avgDaily = parseFloat(form.avgDaily) || 0;
  if (vehicleType === "scooter" && avgDaily > 80) heat += 1.1;
  if (vehicleType === "scooter" && avgDaily > 120) heat += 0.8;

  const heatPenalty = heat;

  // style_penalty: +1-2% if aggressive
  let stylePenalty = 0;
  if (form.drivingStyle === "Aggressive") stylePenalty = vehicleType === "car" ? 1.6 : 2.1;
  else if (form.drivingStyle === "Normal") stylePenalty = 0.5;

  let soh = 100 - ageLoss - cycleLoss - dodPenalty - fastPenalty - heatPenalty - stylePenalty;
  soh = Math.max(50, Math.min(100, soh));

  // uncertainty for range ±3-5%
  let uncertainty = 3;
  if (chem === "Not sure") uncertainty += 1;
  if (vehicleType === "car" && form.cooling === "Not sure") uncertainty += 0.5;
  if (form.batteryFormat === "Swappable network") uncertainty += 1.5;
  if (totalKm === 0) uncertainty += 0.8;
  if (!form.purchaseDate) uncertainty += 0.5;
  uncertainty = Math.min(5, Math.max(2.5, uncertainty));

  const low = Math.max(50, Math.round((soh - uncertainty) * 10) / 10);
  const high = Math.min(100, Math.round((soh + uncertainty) * 10) / 10);
  const mid = Math.round(soh * 10) / 10;

  const factors = [
    {
      key: "age",
      label: `Calendar aging — ${ageYears.toFixed(1)} yr old pack`,
      plain: `Your battery is ${ageYears.toFixed(1)} years old. Even parked, chemistry degrades (${ageRate.toFixed(1)}%/yr for ${chem}).`,
      value: ageLoss,
    },
    {
      key: "cycles",
      label: `Cycle wear — ${totalKm.toLocaleString("en-IN")} km ≈ ${equivalentCycles.toFixed(0)} full charges`,
      plain: `You've done ~${equivalentCycles.toFixed(0)} full equivalent cycles. Each cycle wears cells a little (${cycleFactor.toFixed(3)}%/cycle).`,
      value: cycleLoss,
    },
    {
      key: "dod",
      label: `Depth of discharge — ${form.chargingHabit} habit${form.idle100 === "Yes" ? " + long 100% idle" : ""}`,
      plain: form.chargingHabit === "0-100%" ? "Regular 0-100% stresses cells more than 20-80%. Keeping at 100% for hours adds strain." : "Frequent full charges to 100% and leaving it there accelerates loss.",
      value: dodPenalty,
    },
    {
      key: "fast",
      label: `Fast charging — ${form.fastFreq}${form.chargingSource ? ` via ${form.chargingSource}` : ""}`,
      plain: vehicleType === "scooter"
        ? `Scooters have no active cooling. ${form.fastFreq} DC fast charging builds heat that degrades the pack ~2× faster than cars.`
        : `DC fast charging creates extra heat. ${form.fastFreq} is adding measurable wear, especially without liquid cooling.`,
      value: fastPenalty,
    },
    {
      key: "heat",
      label: `Heat exposure — ${form.climate}, ${form.parking?.toLowerCase()} parking${form.usageType === "Commercial-delivery" ? ", delivery use" : ""}`,
      plain: form.climate === "Hot plains"
        ? "Hot plains + sun parking cooks the battery. Commercial use in afternoon heat is toughest."
        : "Heat is the silent killer — parking in direct sun and hot climate raises cell temperature even when off.",
      value: heatPenalty,
    },
    {
      key: "style",
      label: `Driving style — ${form.drivingStyle}`,
      plain: "Aggressive throttle draws high C-rates, heating cells and increasing mechanical stress.",
      value: stylePenalty,
    },
  ]
    .filter((f) => f.value > 0.2)
    .sort((a, b) => b.value - a.value);

  return {
    soh: mid,
    low,
    high,
    uncertainty,
    breakdown: { ageLoss, cycleLoss, dodPenalty, fastPenalty, heatPenalty, stylePenalty, ageYears, equivalentCycles, cycleFactor, ageRate },
    factors,
    fullRange,
    totalKm,
  };
}

/* ==================== TIPS GENERATOR ==================== */
function generateTips(form, vehicleType, result) {
  const tips = [];

  if (form.fastFreq === "Weekly" || form.fastFreq === "Almost every charge") {
    if (vehicleType === "scooter") {
      tips.push({
        title: "Switch 2-3 charges/week to home AC",
        desc: "Your scooter is air-cooled — it can't shed DC fast-charge heat like a car. Home AC overnight is far gentler and will slow loss by ~30%.",
        icon: "🔌",
      });
    } else {
      tips.push({
        title: "Reserve DC fast for road trips",
        desc: "Use home AC for daily 20-80% top-ups. Fast charge only when you need the range. Keeps cell temps lower.",
        icon: "⚡",
      });
    }
  }

  if (form.chargingHabit === "0-100%") {
    tips.push({
      title: "Stay in 20-80% for daily use",
      desc: "Charge to 80% normally, 100% only before long drives. Avoid draining below 15%. This alone cuts DoD wear by ~40%.",
      icon: "🎯",
    });
  }

  if (form.idle100 === "Yes") {
    tips.push({
      title: "Don't leave at 100% for hours",
      desc: "If you charge to 100%, drive within an hour. Long idle at high voltage accelerates calendar aging, especially in heat.",
      icon: "⏱️",
    });
  }

  if (form.parking === "Direct sun") {
    tips.push({
      title: "Park shaded or covered",
      desc: `In ${form.climate?.toLowerCase() || "hot"} climate, cabin can hit 65°C. Even shaded parking cuts pack temp by 8-12°C.`,
      icon: "🌤️",
    });
  }

  if (form.climate === "Hot plains" && vehicleType === "scooter") {
    tips.push({
      title: "Charge early morning / late evening",
      desc: "Avoid charging right after riding in afternoon heat. Let pack cool 30 min, then charge when ambient is lower.",
      icon: "🌙",
    });
  }

  if (form.drivingStyle === "Aggressive") {
    tips.push({
      title: "Smooth throttle, use Eco mode",
      desc: "Hard acceleration pulls 2-3C. Gentle ramps keep cells cooler and can improve range 8-12% too.",
      icon: "🍃",
    });
  }

  if (form.usageType === "Commercial-delivery") {
    tips.push({
      title: "Mid-day partial top-ups",
      desc: "Instead of one 0-100%, do two 30-75% charges. Less heat per session, and you avoid deep discharge in traffic.",
      icon: "🛵",
    });
  }

  if (form.batteryFormat === "Removable") {
    tips.push({
      title: "Store battery indoors when not in use",
      desc: "Removable packs benefit from indoor storage — cooler and avoids sun soak.",
      icon: "🏠",
    });
  }

  if (vehicleType === "car" && form.cooling === "Passive-air") {
    tips.push({
      title: "Air-cooled pack needs extra care",
      desc: "Avoid back-to-back fast charges and 100% idle. Your pack can't actively cool, so heat lingers longer.",
      icon: "❄️",
    });
  }

  // Ensure at least 2 tips
  if (tips.length < 2) {
    tips.push({
      title: "Monthly 100% balance charge",
      desc: "Once a month, charge to 100% on AC and leave 1hr to let BMS balance cells. Helps accuracy, not just health.",
      icon: "⚖️",
    });
  }

  // deduplicate and limit to 4
  return tips.slice(0, 4);
}

/* ==================== COMPONENTS ==================== */

function Gauge({ value, low, high, vehicleType, size = 320, showRange = true }) {
  const mid = value;
  const angleFor = (v) => -120 + ((Math.max(50, Math.min(100, v)) - 50) / 50) * 240;
  const targetAngle = angleFor(mid);

  // ticks
  const ticks = [];
  for (let v = 50; v <= 100; v += 5) {
    const a = angleFor(v);
    const isMajor = v % 10 === 0;
    const r1 = 108;
    const r2 = isMajor ? 122 : 116;
    const rad = (a - 90) * (Math.PI / 180);
    ticks.push({
      v,
      isMajor,
      x1: 160 + r1 * Math.cos(rad),
      y1: 160 + r1 * Math.sin(rad),
      x2: 160 + r2 * Math.cos(rad),
      y2: 160 + r2 * Math.sin(rad),
      labelX: 160 + 135 * Math.cos(rad),
      labelY: 160 + 135 * Math.sin(rad),
    });
  }

  const polar = (cx, cy, r, ang) => {
    const rad = (ang - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const describeArc = (start, end, r) => {
    const s = polar(160, 160, r, start);
    const e = polar(160, 160, r, end);
    const large = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  };

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      {/* Bezel outer */}
      <div
        className={`absolute inset-0 rounded-full ${vehicleType === "car" ? "bezel-metal-car" : "bezel-metal-scooter"} p-[10px] shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(0,0,0,0.5),0_10px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]`}
      >
        <div className="w-full h-full rounded-full bg-[#0d1117] p-[3px] shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)]">
          <div className="w-full h-full rounded-full relative overflow-hidden bg-[radial-gradient(120%_120%_at_50%_30%,#1e293b_0%,#0f172a_35%,#080a0f_75%)] shadow-[inset_0_1px_2px_rgba(255,255,255,0.15)]">
            {/* inner texture */}
            <div className="absolute inset-0 opacity-[0.04] bg-[repeating-linear-gradient(90deg,transparent,transparent_2px,white_2px,white_3px)] mix-blend-overlay" />

            {/* SVG dial */}
            <svg viewBox="0 0 320 320" className="absolute inset-0 w-full h-full">
              <defs>
                <radialGradient id="faceGrad" cx="50%" cy="40%" r="70%">
                  <stop offset="0%" stopColor={vehicleType === "car" ? "#1e293b" : "#fdfcfb"} stopOpacity={vehicleType === "car" ? 1 : 1} />
                  <stop offset="100%" stopColor={vehicleType === "car" ? "#0f141d" : "#e7e5e0"} />
                </radialGradient>
                <filter id="needleShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.5" />
                </filter>
                <linearGradient id="needleGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f8fafc" />
                  <stop offset="100%" stopColor="#94a3b8" />
                </linearGradient>
                <radialGradient id="hubGrad" cx="40%" cy="35%" r="70%">
                  <stop offset="0%" stopColor="#e2e8f0" />
                  <stop offset="40%" stopColor="#94a3b8" />
                  <stop offset="100%" stopColor="#334155" />
                </radialGradient>
              </defs>

              {/* face bg */}
              <circle cx="160" cy="160" r="130" fill="url(#faceGrad)" />

              {/* colored zones - thick arcs */}
              <path d={describeArc(-120, -24, 100)} fill="none" stroke="#ef4444" strokeWidth="10" strokeLinecap="round" opacity="0.85" />
              <path d={describeArc(-24, 48, 100)} fill="none" stroke="#f59e0b" strokeWidth="10" strokeLinecap="round" opacity="0.9" />
              <path d={describeArc(48, 120, 100)} fill="none" stroke="#22c55e" strokeWidth="10" strokeLinecap="round" opacity="0.95" />

              {/* inner track */}
              <path d={describeArc(-120, 120, 100)} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.5" strokeDasharray="2 6" />

              {/* ticks */}
              {ticks.map((t) => (
                <g key={t.v}>
                  <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.isMajor ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)"} strokeWidth={t.isMajor ? 2 : 1} strokeLinecap="round" />
                  {t.isMajor && (
                    <text x={t.labelX} y={t.labelY} textAnchor="middle" dominantBaseline="middle" fontSize="11" fontFamily="JetBrains Mono" fill={vehicleType === "car" ? "#94a3b8" : "#57534e"} fontWeight="700">
                      {t.v}
                    </text>
                  )}
                </g>
              ))}

              {/* range arc highlight */}
              <path d={describeArc(angleFor(low), angleFor(high), 86)} fill="none" stroke={vehicleType === "car" ? "#38bdf8" : "#f59e0b"} strokeWidth="3" strokeLinecap="round" opacity="0.6" strokeDasharray="4 4" />

              {/* center hub */}
              <circle cx="160" cy="160" r="18" fill="url(#hubGrad)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
              <circle cx="160" cy="160" r="7" fill="#0f172a" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            </svg>

            {/* Needle */}
            <motion.div
              className="absolute left-1/2 top-1/2 w-0 h-0"
              initial={{ rotate: -120 }}
              animate={{ rotate: targetAngle }}
              transition={{ type: "spring", stiffness: 120, damping: 14, mass: 1.1, duration: 0.9 }}
              style={{ transformOrigin: "0 0" }}
            >
              <div
                className="absolute origin-bottom"
                style={{
                  left: 0,
                  bottom: 0,
                  width: 4,
                  height: 108,
                  marginLeft: -2,
                  marginBottom: 6,
                  background: "linear-gradient(to top, #0f172a 0%, #e2e8f0 20%, #f8fafc 55%, #94a3b8 100%)",
                  clipPath: "polygon(45% 0%, 55% 0%, 70% 100%, 30% 100%)",
                  filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.6))",
                  borderRadius: 2,
                }}
              />
              {/* needle tip cap */}
              <div className="absolute w-3 h-3 -ml-[6px] -mb-[2px] bottom-[108px] left-0 rounded-full bg-[#f8fafc] shadow-[0_1px_3px_rgba(0,0,0,0.6),inset_0_1px_1px_white]" />
            </motion.div>

            {/* glass overlay */}
            <div className="absolute inset-[8px] rounded-full pointer-events-none overflow-hidden">
              <div className="absolute inset-0 rounded-full glass-highlight" />
              <div className="absolute -top-[20%] -left-[10%] w-[120%] h-[55%] bg-gradient-to-br from-white/[0.18] via-white/[0.05] to-transparent rotate-[-12deg] blur-[0.5px] rounded-[50%]" />
              <div className="absolute top-[12%] left-[8%] w-[30%] h-[20%] bg-white/[0.08] rounded-full blur-[6px] rotate-12" />
              {/* edge reflection */}
              <div className="absolute inset-0 rounded-full border border-white/[0.08] shadow-[inset_0_1px_1px_rgba(255,255,255,0.25)]" />
            </div>

            {/* highlight arc on bezel */}
            <div className="absolute inset-0 rounded-full pointer-events-none border-t-[1.5px] border-white/20 blur-[0.3px] opacity-60" style={{ clipPath: "ellipse(60% 20% at 50% 15%)" }} />
          </div>
        </div>
      </div>

      {/* SOH readout below needle - digital display */}
      <div className="absolute left-1/2 -translate-x-1/2 top-[62%] flex flex-col items-center">
        <div
          className={`px-3 py-[3px] rounded-[6px] border backdrop-blur-md shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_2px_8px_rgba(0,0,0,0.5)] ${vehicleType === "car" ? "bg-[#0f172a]/90 border-cyan-400/20" : "bg-white/85 border-amber-500/30"}`}
        >
          <span className={`mono font-bold tracking-tight text-[13px] ${vehicleType === "car" ? "text-cyan-300" : "text-amber-700"}`}>SOH</span>
        </div>
        {showRange && (
          <div className="mt-2 flex flex-col items-center">
            <div className={`mono font-black text-[22px] tracking-tighter leading-none ${vehicleType === "car" ? "text-white" : "text-stone-800"} drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]`}>
              {Math.round(low)}–{Math.round(high)}%
            </div>
            <div className={`mono text-[10px] mt-1 px-2 py-0.5 rounded-full ${vehicleType === "car" ? "bg-white/10 text-white/60" : "bg-stone-900/10 text-stone-600"}`}>EST • ±{high - ((low + high) / 2) < 4 ? "3-4" : "4-5"}%</div>
          </div>
        )}
      </div>
    </div>
  );
}

function BatteryIcon({ percent, vehicleType }) {
  const fill = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative">
      <div
        className={`relative w-[92px] h-[46px] rounded-[10px] p-[4px] border-2 shadow-[inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-2px_4px_rgba(0,0,0,0.4),0_4px_12px_rgba(0,0,0,0.3)] ${vehicleType === "car" ? "bg-[#151b26] border-[#2a3446]" : "bg-white border-stone-300"}`}
      >
        {/* terminal */}
        <div className={`absolute -right-[10px] top-1/2 -translate-y-1/2 w-[8px] h-[18px] rounded-r-[4px] border-y-2 border-r-2 ${vehicleType === "car" ? "bg-[#1e293b] border-[#2a3446]" : "bg-stone-200 border-stone-300"}`} />
        {/* inner track */}
        <div className={`w-full h-full rounded-[6px] overflow-hidden relative ${vehicleType === "car" ? "bg-[#0a0e16]" : "bg-stone-100"} shadow-[inset_0_2px_6px_rgba(0,0,0,0.5)]`}>
          {/* segmented fill */}
          <motion.div className="absolute left-0 top-0 bottom-0 flex gap-[2px] p-[2px]" initial={{ width: "0%" }} animate={{ width: `${fill}%` }} transition={{ type: "spring", stiffness: 90, damping: 18 }}>
            <div className={`flex-1 rounded-[3px] relative overflow-hidden ${fill > 80 ? "bg-gradient-to-b from-emerald-300 to-emerald-600" : fill > 60 ? "bg-gradient-to-b from-amber-300 to-amber-500" : "bg-gradient-to-b from-red-400 to-red-600"} shadow-[inset_0_1px_1px_rgba(255,255,255,0.6)]`}>
              <div className="absolute inset-0 bg-gradient-to-b from-white/40 to-transparent h-[45%]" />
              {/* liquid shimmer */}
              <motion.div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent" animate={{ x: ["-100%", "200%"] }} transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }} />
            </div>
          </motion.div>
          {/* segments lines */}
          <div className="absolute inset-0 flex">
            {[...Array(4)].map((_, i) => (
              <div key={i} className={`flex-1 border-r ${vehicleType === "car" ? "border-white/[0.06]" : "border-black/10"} last:border-0`} />
            ))}
          </div>
        </div>
        {/* glossy top edge */}
        <div className="absolute top-[4px] left-[4px] right-[4px] h-[45%] bg-gradient-to-b from-white/25 to-transparent rounded-t-[6px] pointer-events-none" />
      </div>
      <div className={`mono text-[10px] mt-1.5 text-center font-bold tracking-wide ${vehicleType === "car" ? "text-white/50" : "text-stone-500"}`}>{Math.round(fill)}% CAP</div>
    </div>
  );
}

function RockerSwitch({ value, onChange, vehicleType }) {
  return (
    <div className={`relative flex p-1.5 rounded-full w-[260px] ${vehicleType === "car" ? "bg-[#0e131c] border border-[#1f2937] shadow-[inset_0_2px_8px_rgba(0,0,0,0.8),0_1px_1px_rgba(255,255,255,0.06)]" : "bg-[#e8e6e1] border border-stone-300 shadow-[inset_0_2px_6px_rgba(0,0,0,0.15),0_1px_1px_rgba(255,255,255,0.8)]"}`}>
      {/* sliding knob */}
      <motion.div
        className={`absolute top-1.5 bottom-1.5 w-[calc(50%-6px)] rounded-full shadow-[0_2px_8px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.8),inset_0_-1px_2px_rgba(0,0,0,0.2)] ${vehicleType === "car" ? "bg-gradient-to-b from-[#2a3446] to-[#151b26] border border-[#3a455c]" : "bg-gradient-to-b from-white to-[#d6d3cd] border border-stone-300"}`}
        animate={{ x: value === "car" ? 0 : 124 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
      >
        <div className="absolute inset-0 rounded-full opacity-40 bg-[radial-gradient(60%_60%_at_50%_20%,white,transparent)]" />
      </motion.div>
      <button onClick={() => onChange("car")} className={`relative z-10 flex-1 py-2.5 rounded-full flex items-center justify-center gap-2 text-[13px] font-bold tracking-wide transition-colors ${value === "car" ? (vehicleType === "car" ? "text-cyan-300" : "text-stone-900") : "text-white/40"}`}>
        <span className="text-[16px]">🚗</span> CAR
      </button>
      <button onClick={() => onChange("scooter")} className={`relative z-10 flex-1 py-2.5 rounded-full flex items-center justify-center gap-2 text-[13px] font-bold tracking-wide transition-colors ${value === "scooter" ? (vehicleType === "car" ? "text-amber-300" : "text-stone-900") : vehicleType === "car" ? "text-white/40" : "text-stone-500"}`}>
        <span className="text-[16px]">🛵</span> SCOOTER
      </button>
    </div>
  );
}

function SkeuButton({ children, onClick, variant = "primary", vehicleType, className = "", disabled, type = "button" }) {
  const base = "relative px-6 py-3.5 rounded-full font-bold text-[14px] tracking-wide transition-all select-none";
  const primaryCar = "bg-gradient-to-b from-cyan-400 to-cyan-600 text-[#001a22] shadow-[0_4px_14px_rgba(34,211,238,0.35),inset_0_1px_1px_rgba(255,255,255,0.8),inset_0_-1px_2px_rgba(0,0,0,0.2)] border border-cyan-300";
  const primaryScooter = "bg-gradient-to-b from-amber-400 to-orange-500 text-[#2a1500] shadow-[0_4px_14px_rgba(245,158,11,0.35),inset_0_1px_1px_rgba(255,255,255,0.8),inset_0_-1px_2px_rgba(0,0,0,0.2)] border border-amber-300";
  const secondaryCar = "bg-[#1a2332] text-white/80 border border-[#2a3446] shadow-[0_2px_8px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.08)]";
  const secondaryScooter = "bg-white text-stone-700 border border-stone-300 shadow-[0_2px_8px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,1)]";

  const style = variant === "primary" ? (vehicleType === "car" ? primaryCar : primaryScooter) : vehicleType === "car" ? secondaryCar : secondaryScooter;

  return (
    <motion.button
      type={type}
      disabled={disabled}
      whileTap={{ scale: 0.97 }}
      whileHover={{ y: -1 }}
      onClick={onClick}
      className={`${base} ${style} ${className} ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      style={{ transformOrigin: "center" }}
    >
      <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>
      <span className="absolute inset-0 rounded-full bg-gradient-to-b from-white/20 to-transparent pointer-events-none h-[50%]" />
    </motion.button>
  );
}

function FieldCard({ children, label, hint, vehicleType, className = "" }) {
  return (
    <div className={`${className}`}>
      {label && (
        <div className="flex items-baseline justify-between mb-2">
          <label className={`text-[11px] font-bold tracking-widest uppercase ${vehicleType === "car" ? "text-white/50" : "text-stone-500"}`}>{label}</label>
          {hint && <span className={`text-[10px] mono ${vehicleType === "car" ? "text-white/30" : "text-stone-400"}`}>{hint}</span>}
        </div>
      )}
      <div
        className={`rounded-[16px] p-[1px] ${vehicleType === "car" ? "bg-gradient-to-b from-white/[0.08] to-transparent shadow-[0_2px_12px_rgba(0,0,0,0.3),inset_0_1px_1px_rgba(255,255,255,0.06)]" : "bg-gradient-to-b from-black/10 to-transparent shadow-[0_2px_12px_rgba(0,0,0,0.06)]"}`}
      >
        <div className={`rounded-[15px] ${vehicleType === "car" ? "bg-[#121820] border border-[#1e2937]" : "bg-white border border-stone-200"} shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),inset_0_-1px_3px_rgba(0,0,0,0.08)]`}>{children}</div>
      </div>
    </div>
  );
}

function PillSelect({ options, value, onChange, vehicleType }) {
  return (
    <div className="flex flex-wrap gap-2 p-2">
      {options.map((opt) => {
        const active = value === opt;
        return (
          <motion.button
            key={opt}
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => onChange(opt)}
            className={`px-3.5 py-2 rounded-full text-[12.5px] font-semibold tracking-wide border transition-all ${active ? (vehicleType === "car" ? "bg-cyan-500/15 text-cyan-300 border-cyan-400/40 shadow-[0_0_12px_rgba(34,211,238,0.25),inset_0_1px_1px_rgba(255,255,255,0.2)]" : "bg-amber-500/15 text-amber-800 border-amber-500/40 shadow-[0_0_10px_rgba(245,158,11,0.2)]") : vehicleType === "car" ? "bg-[#0e141e] text-white/45 border-white/10 hover:text-white/70 hover:border-white/20" : "bg-stone-50 text-stone-500 border-stone-200 hover:text-stone-700"}`}
          >
            {opt}
          </motion.button>
        );
      })}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, vehicleType, type = "text", suffix }) {
  return (
    <div className="relative flex items-center">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-transparent px-4 py-3.5 text-[14px] font-medium outline-none placeholder:text-[13px] ${vehicleType === "car" ? "text-white placeholder:text-white/30" : "text-stone-800 placeholder:text-stone-400"}`}
      />
      {suffix && <span className={`pr-4 mono text-[11px] font-bold ${vehicleType === "car" ? "text-white/30" : "text-stone-400"}`}>{suffix}</span>}
    </div>
  );
}

/* ==================== MAIN APP ==================== */

export default function App() {
  const [vehicleType, setVehicleType] = useState("car");
  const [page, setPage] = useState("landing"); // landing | form | results | passport
  const [step, setStep] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [passportKey, setPassportKey] = useState(0);
  const [savedMsg, setSavedMsg] = useState("");
  const [passportCount, setPassportCount] = useState(0);
  const { canInstall, installed, isStandalone, platform, install } = useInstallPrompt();
  const [installHelp, setInstallHelp] = useState(false);
  const [helpTab, setHelpTab] = useState(null);
  // true when this exact file was downloaded and opened locally (file://)
  const isLocalFile =
    typeof window !== "undefined" &&
    (window.location?.protocol === "file:" || window.location?.protocol === "blob:");

  const [form, setForm] = useState({
    makeModel: "",
    capacity: "",
    chemistry: "Not sure",
    purchaseDate: "",
    odometer: "",
    claimedRange: "",
    chargingHabit: "Mixed",
    fastFreq: "Occasionally",
    chargingSource: "Mixed",
    climate: "Moderate",
    parking: "Covered",
    drivingStyle: "Normal",
    usageType: "Personal",
    cooling: "Not sure",
    idle100: "No",
    batteryFormat: "Fixed",
    avgDaily: "",
  });

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // auto-fill from model db when makeModel matches
  useEffect(() => {
    const list = MODEL_DB[vehicleType];
    const found = list.find((m) => m.name.toLowerCase() === form.makeModel.toLowerCase());
    if (found) {
      setForm((f) => ({
        ...f,
        capacity: found.capacity.toString(),
        chemistry: found.chemistry,
        claimedRange: found.range.toString(),
        cooling: found.cooling || f.cooling,
        batteryFormat: found.format || f.batteryFormat,
      }));
    }
  }, [form.makeModel, vehicleType]);

  const result = useMemo(() => calculateSOH(form, vehicleType), [form, vehicleType]);
  const tips = useMemo(() => generateTips(form, vehicleType, result), [form, vehicleType, result]);

  const suggestions = useMemo(() => {
    if (!form.makeModel) return [];
    const q = form.makeModel.toLowerCase();
    return MODEL_DB[vehicleType].filter((m) => m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [form.makeModel, vehicleType]);

  const handleCalculate = () => {
    setCalibrating(true);
    setTimeout(() => {
      setCalibrating(false);
      setPage("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 1400);
  };

  // count saved passport vehicles for the header badge
  useEffect(() => {
    setPassportCount(getVehicles().length);
  }, [passportKey, page]);

  const handleSave = () => {
    saveRecord({ ...form, vehicleType }, vehicleType, result);
    setPassportKey((k) => k + 1);
    setSavedMsg("Saved to Battery Passport ✓");
    setTimeout(() => setSavedMsg(""), 2600);
  };

  const isCar = vehicleType === "car";

  return (
    <div className={`min-h-screen w-full overflow-x-hidden antialiased selection:bg-cyan-500/30 ${isCar ? "bg-[#080a0f] text-white" : "bg-[#f5f3ef] text-stone-800"} transition-colors duration-500`}>
      {/* background textures */}
      <div className="fixed inset-0 pointer-events-none">
        {isCar ? (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_-10%,rgba(56,189,248,0.18),transparent_60%),radial-gradient(80%_60%_at_90%_20%,rgba(99,102,241,0.12),transparent),radial-gradient(60%_40%_at_10%_80%,rgba(34,211,238,0.08),transparent)]" />
            <div className="absolute inset-0 opacity-[0.03] bg-[url('data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E')]" />
            <div className="absolute inset-0 opacity-[0.015] bg-[repeating-linear-gradient(0deg,transparent,transparent_1px,white_1px,white_2px)]" />
          </>
        ) : (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(100%_70%_at_50%_0%,rgba(245,158,11,0.12),transparent_60%),radial-gradient(60%_50%_at_90%_30%,rgba(251,146,60,0.08),transparent)]" />
            <div className="absolute inset-0 opacity-[0.04] bg-[url('data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E')]" />
          </>
        )}
      </div>

      {/* Header */}
      <header className={`sticky top-0 z-40 backdrop-blur-xl border-b ${isCar ? "bg-[#080a0f]/70 border-white/[0.06]" : "bg-[#f5f3ef]/80 border-stone-200"}`}>
        <div className="mx-auto max-w-[1180px] px-5 md:px-8 h-[64px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center border shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)] ${isCar ? "bg-gradient-to-b from-slate-700 to-slate-900 border-slate-600" : "bg-white border-stone-300"}`}>
              <div className={`w-5 h-5 rounded-[4px] ${isCar ? "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]" : "bg-amber-500"}`} />
            </div>
            <div>
              <div className={`font-bold tracking-tight leading-none text-[15px] ${isCar ? "text-white" : "text-stone-900"}`}>EV Battery Health</div>
              <div className={`mono text-[10px] tracking-widest ${isCar ? "text-white/40" : "text-stone-500"}`}>SOH ESTIMATOR • INDIA</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`hidden xl:flex items-center gap-2 mono text-[10px] px-3 py-1.5 rounded-full border ${isCar ? "bg-amber-500/10 text-amber-300 border-amber-500/20" : "bg-amber-100 text-amber-800 border-amber-200"}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> ESTIMATE ONLY
            </div>

            {!installed && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={async () => {
                  // native install dialog if the browser offers it, else show the guide
                  if (canInstall) {
                    const accepted = await install();
                    if (!accepted) setInstallHelp(true);
                  } else {
                    setInstallHelp(true);
                  }
                }}
                className={`relative flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-bold border ${isCar ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                📥 Get<span className="hidden sm:inline"> the</span> app
              </motion.button>
            )}

            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => { setPage(page === "passport" ? "landing" : "passport"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={`relative flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-bold border ${page === "passport" ? (isCar ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "bg-amber-500/20 border-amber-500/40 text-amber-900") : isCar ? "bg-white/[0.06] border-white/10 text-white/70" : "bg-white border-stone-200 text-stone-600"}`}
            >
              🪪 <span className="hidden sm:inline">Passport</span>
              {passportCount > 0 && (
                <span className={`mono text-[9px] px-1.5 py-0.5 rounded-full ${isCar ? "bg-cyan-400 text-black" : "bg-amber-500 text-white"}`}>{passportCount}</span>
              )}
            </motion.button>

            <RockerSwitch value={vehicleType} onChange={setVehicleType} vehicleType={vehicleType} />
          </div>
        </div>
      </header>

      {/* ---------- Get SOHSense: install as app, or download the offline file ---------- */}
      <AnimatePresence>
        {installHelp && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setInstallHelp(false)}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-6"
          >
            <motion.div
              initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className={`w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border p-6 pb-8 sm:pb-6 ${isCar ? "bg-[#0E1117] border-white/10 text-white" : "bg-white border-stone-200 text-stone-900"}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-bold text-xl tracking-tight">Get SOHSense</div>
                  <div className={`mono text-[10px] tracking-widest mt-1 ${isCar ? "text-white/40" : "text-stone-500"}`}>
                    INSTALL AS AN APP • OR DOWNLOAD THE FILE
                  </div>
                </div>
                <button
                  onClick={() => setInstallHelp(false)}
                  className={`shrink-0 w-8 h-8 rounded-full border text-sm ${isCar ? "border-white/15 text-white/60" : "border-stone-200 text-stone-500"}`}
                >✕</button>
              </div>

              {isLocalFile ? (
                <div className={`mt-5 rounded-2xl border p-4 text-sm leading-relaxed ${isCar ? "bg-emerald-500/[0.07] border-emerald-500/25 text-emerald-100" : "bg-emerald-50 border-emerald-200 text-emerald-900"}`}>
                  <div className="font-bold">You are already running the offline app ✅</div>
                  <div className={`text-xs mt-1.5 ${isCar ? "text-emerald-200/70" : "text-emerald-800/80"}`}>
                    This is the downloaded single file. Keep it on your device or share it on WhatsApp —
                    it opens and calculates SOH with no internet at all. To get a home-screen icon instead,
                    visit <b>batteryhealth.netlify.app</b> in your browser and install it from there.
                  </div>
                </div>
              ) : (
              <>
              {/* ---- OPTION 1: install as a real app ---- */}
              <div className={`mt-5 rounded-2xl border p-4 ${isCar ? "bg-white/[0.03] border-white/10" : "bg-stone-50 border-stone-200"}`}>
                <div className="flex items-center gap-2">
                  <span className={`font-bold text-sm ${isCar ? "text-white" : "text-stone-900"}`}>1. Install as an app</span>
                  <span className={`mono text-[9px] px-2 py-0.5 rounded-full ${isCar ? "bg-emerald-500/15 text-emerald-300" : "bg-emerald-100 text-emerald-800"}`}>
                    RECOMMENDED
                  </span>
                </div>

                {canInstall ? (
                  <>
                    <div className={`text-xs mt-1.5 ${isCar ? "text-white/50" : "text-stone-500"}`}>
                      Your browser supports one-tap install. Adds a home-screen icon and works offline.
                    </div>
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={async () => { const ok = await install(); if (ok) setInstallHelp(false); }}
                      className="mt-3 w-full py-3 rounded-xl font-bold text-sm bg-emerald-500 text-black"
                    >
                      📲 Install SOHSense now
                    </motion.button>
                  </>
                ) : (
                  <>
                    {/* platform tabs — so you can guide a judge on any device */}
                    <div className="mt-3 flex gap-2">
                      {[["android", "Android"], ["ios", "iPhone"], ["desktop", "Desktop"]].map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => setHelpTab(id)}
                          className={`flex-1 py-2 rounded-lg mono text-[10px] font-bold border ${
                            (helpTab || platform) === id
                              ? (isCar ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200" : "bg-emerald-100 border-emerald-300 text-emerald-900")
                              : (isCar ? "border-white/10 text-white/40" : "border-stone-200 text-stone-500")
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-4 space-y-3">
                      {(helpTab || platform) === "ios" && [
                        { n: "1", t: "Tap the Share button", d: "The square with an arrow up — bottom bar in Safari." },
                        { n: "2", t: 'Scroll and tap "Add to Home Screen"', d: "It is in the share options list." },
                        { n: "3", t: "Tap Add", d: "SOHSense icon appears on your home screen, opens fullscreen, offline." },
                      ].map((x) => (
                        <div key={x.n} className="flex gap-3">
                          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mono text-[10px] font-bold ${isCar ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-emerald-50 text-emerald-800 border border-emerald-200"}`}>{x.n}</div>
                          <div>
                            <div className="text-sm font-semibold">{x.t}</div>
                            <div className={`text-xs mt-0.5 ${isCar ? "text-white/50" : "text-stone-500"}`}>{x.d}</div>
                          </div>
                        </div>
                      ))}

                      {(helpTab || platform) === "android" && [
                        { n: "1", t: "Open the ⋮ menu in Chrome", d: "Top-right corner of the browser." },
                        { n: "2", t: 'Tap "Install app"', d: 'If you see "Add to Home screen" instead, that works too.' },
                        { n: "3", t: "Confirm", d: "SOHSense icon appears on your home screen and works offline." },
                      ].map((x) => (
                        <div key={x.n} className="flex gap-3">
                          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mono text-[10px] font-bold ${isCar ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-emerald-50 text-emerald-800 border border-emerald-200"}`}>{x.n}</div>
                          <div>
                            <div className="text-sm font-semibold">{x.t}</div>
                            <div className={`text-xs mt-0.5 ${isCar ? "text-white/50" : "text-stone-500"}`}>{x.d}</div>
                          </div>
                        </div>
                      ))}

                      {(helpTab || platform) === "desktop" && [
                        { n: "1", t: "Look at the address bar", d: "A small install icon (⊕ or a monitor with an arrow) appears on the right side." },
                        { n: "2", t: "Click it, then click Install", d: "In Edge, use ⋯ menu → Apps → Install this site as an app." },
                        { n: "3", t: "Done", d: "SOHSense opens in its own window and works offline." },
                      ].map((x) => (
                        <div key={x.n} className="flex gap-3">
                          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mono text-[10px] font-bold ${isCar ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-emerald-50 text-emerald-800 border border-emerald-200"}`}>{x.n}</div>
                          <div>
                            <div className="text-sm font-semibold">{x.t}</div>
                            <div className={`text-xs mt-0.5 ${isCar ? "text-white/50" : "text-stone-500"}`}>{x.d}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {(helpTab || platform) === "ios" && (
                      <div className={`mt-4 rounded-xl border p-3 text-[11px] leading-relaxed ${isCar ? "bg-amber-500/10 border-amber-500/20 text-amber-200" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
                        Must be <b>Safari</b> — Chrome on iPhone cannot add apps to the home screen.
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ---- OPTION 2: download the offline file ---- */}
              <div className={`mt-4 rounded-2xl border p-4 ${isCar ? "bg-white/[0.03] border-white/10" : "bg-stone-50 border-stone-200"}`}>
                <div className={`font-bold text-sm ${isCar ? "text-white" : "text-stone-900"}`}>2. Download the offline file</div>
                <div className={`text-xs mt-1.5 ${isCar ? "text-white/50" : "text-stone-500"}`}>
                  One single file, 624 KB. No install, no internet, no account —
                  double-click it and SOHSense runs in any browser, even in airplane mode.
                </div>
                <a
                  href="/SOHSense-Offline-App.html"
                  download="SOHSense-Offline-App.html"
                  className={`mt-3 w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm border-2 ${isCar ? "border-cyan-500/40 text-cyan-200 bg-cyan-500/10" : "border-amber-400 text-amber-900 bg-amber-50"}`}
                >
                  ⬇ Download SOHSense (offline app)
                </a>
              </div>

              </>
              )}

              <div className={`mt-4 text-[11px] leading-relaxed ${isCar ? "text-white/35" : "text-stone-500"}`}>
                Everything runs on your device. No login, no backend — your Battery Passport never leaves your phone.
                SOHSense is <b>SOH only</b>: it estimates permanent capacity loss, not current charge (SOC).
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative mx-auto max-w-[1180px] px-5 md:px-8 py-8 md:py-12">
        {/* Landing */}
        <AnimatePresence mode="wait">
          {page === "landing" && (
            <motion.div key="landing" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className="grid lg:grid-cols-[1.1fr_0.9fr] gap-8 items-start">
              {/* Left copy */}
              <div className="space-y-6">
                <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide border ${isCar ? "bg-white/[0.06] border-white/10 text-white/60" : "bg-white border-stone-200 text-stone-600"}`}>
                  <span className={`w-2 h-2 rounded-full ${isCar ? "bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]" : "bg-emerald-500"}`} /> LIVE • NO HARDWARE NEEDED
                </div>

                <h1 className={`text-[42px] md:text-[56px] font-black leading-[0.9] tracking-[-0.03em] ${isCar ? "text-white" : "text-stone-900"}`}>
                  Your EV shows
                  <span className={`inline-block mx-3 px-3 py-1 rounded-[12px] text-[28px] md:text-[36px] -rotate-1 border ${isCar ? "bg-white/[0.06] border-white/10 text-white/70" : "bg-stone-900 text-white border-stone-800"}`}>how full</span>
                  <br />
                  but not
                  <span className={`inline-block ml-3 px-4 py-1 rounded-full bg-gradient-to-b ${isCar ? "from-cyan-400 to-cyan-600 text-[#002026] shadow-[0_6px_20px_rgba(34,211,238,0.35)]" : "from-amber-400 to-orange-500 text-[#2a1500] shadow-[0_6px_20px_rgba(245,158,11,0.35)]"} -rotate-1`}>how healthy.</span>
                </h1>

                <p className={`text-[18px] leading-[1.5] max-w-[56ch] ${isCar ? "text-white/60" : "text-stone-600"}`}>
                  <span className={isCar ? "text-white font-semibold" : "text-stone-900 font-semibold"}>SOC</span> is current charge. <span className={isCar ? "text-white font-semibold" : "text-stone-900 font-semibold"}>SOH</span> is permanent capacity loss since new — like iPhone Battery Health, but for your {isCar ? "car" : "scooter"}. We estimate it from your real usage, because no EV in India shows it on the dash.
                </p>

                <div className={`rounded-[20px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/10 to-transparent" : "bg-gradient-to-b from-black/10 to-transparent"}`}>
                  <div className={`rounded-[19px] p-5 flex gap-4 ${isCar ? "bg-[#121821] border border-white/[0.06]" : "bg-white border border-stone-200"}`}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isCar ? "bg-amber-500/15 text-amber-300 border border-amber-500/20" : "bg-amber-100 text-amber-700 border border-amber-200"}`}>⚠️</div>
                    <div className={`text-[13px] leading-[1.5] ${isCar ? "text-white/60" : "text-stone-600"}`}>
                      <span className={`font-bold ${isCar ? "text-white" : "text-stone-900"}`}>Heads up:</span> This is a heuristic estimate from patterns you enter — not a certified lab or BMS reading. Always treat as a range, never a warranty claim. We’re honest about that throughout.
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 pt-2">
                  <SkeuButton vehicleType={vehicleType} onClick={() => setPage("form")}>
                    Check your battery health <span className="ml-1">→</span>
                  </SkeuButton>
                  <div className={`mono text-[11px] leading-[1.4] max-w-[24ch] py-2 ${isCar ? "text-white/30" : "text-stone-500"}`}>Takes ~2 min • Works for cars & scooters • No login</div>
                </div>

                {/* download / install CTA — always visible on the landing page */}
                {!installed && (
                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setInstallHelp(true)}
                    className={`mt-1 w-full flex items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-left ${isCar ? "bg-emerald-500/[0.07] border-emerald-500/25" : "bg-emerald-50 border-emerald-200"}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0 ${isCar ? "bg-emerald-500/15 border border-emerald-500/25" : "bg-emerald-100 border border-emerald-200"}`}>📥</span>
                      <div>
                        <div className={`text-[13px] font-bold ${isCar ? "text-emerald-200" : "text-emerald-900"}`}>
                          Download SOHSense as an app
                        </div>
                        <div className={`text-[11px] mt-0.5 ${isCar ? "text-white/45" : "text-stone-500"}`}>
                          Free • Install on phone or laptop • Works offline, no internet needed
                        </div>
                      </div>
                    </div>
                    <span className={`mono text-[10px] shrink-0 ${isCar ? "text-emerald-300" : "text-emerald-800"}`}>GET →</span>
                  </motion.button>
                )}

                {/* mini trust row */}
                <div className="flex flex-wrap gap-2 pt-4">
                  {[
                    "🇮🇳 Built for Indian climate & models",
                    "🔋 LFP / NMC / NCA aware",
                    `🛞 ${MODEL_DB.car.length + MODEL_DB.scooter.length} models in lookup`,
                  ].map((t) => (
                    <span key={t} className={`text-[11px] px-3 py-1.5 rounded-full border ${isCar ? "bg-white/[0.04] border-white/[0.06] text-white/40" : "bg-white border-stone-200 text-stone-500"}`}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              {/* Right - hero gauge demo */}
              <div className="relative lg:sticky lg:top-[92px]">
                <div className={`rounded-[32px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/15 to-white/5 shadow-[0_20px_60px_rgba(0,0,0,0.5)]" : "bg-gradient-to-b from-black/10 to-black/5 shadow-[0_20px_60px_rgba(0,0,0,0.08)]"}`}>
                  <div className={`rounded-[31px] p-6 md:p-8 relative overflow-hidden ${isCar ? "bg-[#0f141d] border border-white/[0.06]" : "bg-[#fdfcfa] border border-stone-200"}`}>
                    {/* carbon fiber subtle for car */}
                    {isCar && <div className="absolute inset-0 opacity-[0.04] bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,white_10px,white_11px)] pointer-events-none" />}

                    <div className="flex items-center justify-between mb-6">
                      <div className={`mono text-[11px] tracking-widest font-bold ${isCar ? "text-white/30" : "text-stone-400"}`}>LIVE PREVIEW • {vehicleType.toUpperCase()}</div>
                      <BatteryIcon percent={82} vehicleType={vehicleType} />
                    </div>

                    <div className="flex justify-center py-2">
                      <Gauge value={84} low={80} high={87} vehicleType={vehicleType} size={300} />
                    </div>

                    <div className={`mt-6 grid grid-cols-3 gap-3 mono text-[11px] ${isCar ? "text-white/40" : "text-stone-500"}`}>
                      <div className={`rounded-[12px] p-3 border ${isCar ? "bg-white/[0.03] border-white/[0.06]" : "bg-stone-50 border-stone-200"}`}>
                        <div className={`text-[10px] uppercase tracking-wide ${isCar ? "text-white/30" : "text-stone-400"}`}>Age loss</div>
                        <div className={`text-[14px] font-bold mt-1 ${isCar ? "text-white" : "text-stone-800"}`}>-3.2%</div>
                      </div>
                      <div className={`rounded-[12px] p-3 border ${isCar ? "bg-white/[0.03] border-white/[0.06]" : "bg-stone-50 border-stone-200"}`}>
                        <div className={`text-[10px] uppercase ${isCar ? "text-white/30" : "text-stone-400"}`}>Cycles</div>
                        <div className={`text-[14px] font-bold mt-1 ${isCar ? "text-white" : "text-stone-800"}`}>-2.8%</div>
                      </div>
                      <div className={`rounded-[12px] p-3 border ${isCar ? "bg-white/[0.03] border-white/[0.06]" : "bg-stone-50 border-stone-200"}`}>
                        <div className={`text-[10px] uppercase ${isCar ? "text-white/30" : "text-stone-400"}`}>Heat</div>
                        <div className={`text-[14px] font-bold mt-1 ${isCar ? "text-white" : "text-stone-800"}`}>-1.9%</div>
                      </div>
                    </div>

                    <div className={`mt-4 text-[11px] mono text-center py-2 rounded-full border ${isCar ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-300/70" : "bg-amber-500/10 border-amber-500/20 text-amber-800/70"}`}>SOC tells you now • SOH tells you forever</div>
                  </div>
                </div>

                {/* floating badge */}
                <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.6 }} className={`absolute -bottom-4 -left-3 md:-left-6 px-4 py-2 rounded-full text-[12px] font-bold shadow-[0_8px_20px_rgba(0,0,0,0.2)] border ${isCar ? "bg-[#1a2332] text-white border-white/10" : "bg-stone-900 text-white border-stone-800"}`}>
                  ✨ No OBD needed — manual entry
                </motion.div>
              </div>
            </motion.div>
          )}

          {/* FORM */}
          {page === "form" && (
            <motion.div key="form" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="grid lg:grid-cols-[1.05fr_0.85fr] gap-8 items-start">
              {/* Left form */}
              <div>
                {/* progress - instrument cluster style */}
                <div className={`flex items-center gap-3 mb-8 p-2 rounded-full w-fit border ${isCar ? "bg-[#0e131c] border-white/10 shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" : "bg-white border-stone-200 shadow-sm"}`}>
                  {["Vehicle & Specs", "Charging", "Environment"].map((label, i) => {
                    const active = i === step;
                    const done = i < step;
                    return (
                      <button
                        key={label}
                        onClick={() => setStep(i)}
                        className={`relative px-4 py-2 rounded-full text-[12px] font-bold tracking-wide flex items-center gap-2 transition-all ${active ? (isCar ? "bg-white text-black shadow-[0_2px_8px_rgba(255,255,255,0.25)]" : "bg-stone-900 text-white shadow") : done ? (isCar ? "bg-white/10 text-white/70" : "bg-stone-100 text-stone-700") : isCar ? "text-white/30" : "text-stone-400"}`}
                      >
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border ${active ? "bg-black text-white border-black" : done ? "bg-emerald-500 text-white border-emerald-500" : isCar ? "border-white/20" : "border-stone-300"}`}>{done ? "✓" : i + 1}</span>
                        {label}
                      </button>
                    );
                  })}
                </div>

                <AnimatePresence mode="wait">
                  <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
                    {step === 0 && (
                      <div className="space-y-5">
                        <h2 className={`text-[28px] font-black tracking-tight ${isCar ? "text-white" : "text-stone-900"}`}>Tell us about your {isCar ? "car" : "scooter"}</h2>

                        <FieldCard label="Make & Model" hint="type to auto-fill" vehicleType={vehicleType}>
                          <div className="relative">
                            <TextInput value={form.makeModel} onChange={(v) => { update("makeModel", v); setShowSuggestions(true); }} placeholder={isCar ? "e.g. Tata Nexon EV 40.5" : "e.g. Ather 450X"} vehicleType={vehicleType} />
                            {showSuggestions && suggestions.length > 0 && (
                              <div className={`absolute z-20 top-full mt-2 w-full rounded-[14px] overflow-hidden border shadow-[0_12px_32px_rgba(0,0,0,0.25)] ${isCar ? "bg-[#151b26] border-white/10" : "bg-white border-stone-200"}`}>
                                {suggestions.map((s) => (
                                  <button key={s.name} type="button" onClick={() => { update("makeModel", s.name); setShowSuggestions(false); }} className={`w-full text-left px-4 py-3 text-[13px] flex justify-between items-center hover:bg-white/5 ${isCar ? "text-white/80 border-b border-white/5 last:border-0" : "text-stone-700 border-b border-stone-100"}`}>
                                    <span className="font-semibold">{s.name}</span>
                                    <span className={`mono text-[11px] px-2 py-1 rounded-full ${isCar ? "bg-white/10 text-white/50" : "bg-stone-100 text-stone-500"}`}>{s.capacity} kWh • {s.range} km</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </FieldCard>

                        <div className="grid grid-cols-2 gap-4">
                          <FieldCard label="Battery capacity" vehicleType={vehicleType}>
                            <TextInput value={form.capacity} onChange={(v) => update("capacity", v)} placeholder="e.g. 40.5" vehicleType={vehicleType} suffix="kWh" />
                          </FieldCard>
                          <FieldCard label="Chemistry" vehicleType={vehicleType}>
                            <PillSelect options={["LFP", "NMC", "NCA", "Not sure"]} value={form.chemistry} onChange={(v) => update("chemistry", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <FieldCard label="Purchase date" vehicleType={vehicleType}>
                            <TextInput type="date" value={form.purchaseDate} onChange={(v) => update("purchaseDate", v)} placeholder="" vehicleType={vehicleType} />
                          </FieldCard>
                          <FieldCard label="Odometer" vehicleType={vehicleType}>
                            <TextInput value={form.odometer} onChange={(v) => update("odometer", v)} placeholder="e.g. 24000" vehicleType={vehicleType} suffix="km" />
                          </FieldCard>
                        </div>

                        <FieldCard label="Claimed full-charge range (as new)" hint="ARAI / company claimed" vehicleType={vehicleType}>
                          <TextInput value={form.claimedRange} onChange={(v) => update("claimedRange", v)} placeholder={isCar ? "e.g. 465" : "e.g. 146"} vehicleType={vehicleType} suffix="km" />
                        </FieldCard>
                      </div>
                    )}

                    {step === 1 && (
                      <div className="space-y-5">
                        <h2 className={`text-[28px] font-black tracking-tight ${isCar ? "text-white" : "text-stone-900"}`}>How do you charge?</h2>

                        <FieldCard label="Charging habit" vehicleType={vehicleType}>
                          <PillSelect options={["20-80%", "0-100%", "Mixed"]} value={form.chargingHabit} onChange={(v) => update("chargingHabit", v)} vehicleType={vehicleType} />
                        </FieldCard>

                        <div className="grid md:grid-cols-2 gap-4">
                          <FieldCard label="Fast-charging frequency" vehicleType={vehicleType}>
                            <PillSelect options={["Never", "Occasionally", "Weekly", "Almost every charge"]} value={form.fastFreq} onChange={(v) => update("fastFreq", v)} vehicleType={vehicleType} />
                          </FieldCard>
                          <FieldCard label="Primary charging source" vehicleType={vehicleType}>
                            <PillSelect options={["Home AC", "Public AC", "DC fast", "Mixed"]} value={form.chargingSource} onChange={(v) => update("chargingSource", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        </div>

                        {isCar ? (
                          <FieldCard label="Cooling system" vehicleType={vehicleType}>
                            <PillSelect options={["Active liquid", "Passive-air", "Not sure"]} value={form.cooling} onChange={(v) => update("cooling", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        ) : (
                          <FieldCard label="Battery format" vehicleType={vehicleType}>
                            <PillSelect options={["Fixed", "Removable", "Swappable network"]} value={form.batteryFormat} onChange={(v) => update("batteryFormat", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        )}

                        {isCar && (
                          <FieldCard label="Long idle periods at 100% charge?" vehicleType={vehicleType}>
                            <PillSelect options={["Yes", "No"]} value={form.idle100} onChange={(v) => update("idle100", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        )}
                      </div>
                    )}

                    {step === 2 && (
                      <div className="space-y-5">
                        <h2 className={`text-[28px] font-black tracking-tight ${isCar ? "text-white" : "text-stone-900"}`}>Where & how you ride</h2>

                        <div className="grid md:grid-cols-2 gap-4">
                          <FieldCard label="Climate zone" vehicleType={vehicleType}>
                            <PillSelect options={["Hot plains", "Moderate", "Cold-hilly"]} value={form.climate} onChange={(v) => update("climate", v)} vehicleType={vehicleType} />
                          </FieldCard>
                          <FieldCard label="Parking" vehicleType={vehicleType}>
                            <PillSelect options={["Covered", "Shaded", "Direct sun"]} value={form.parking} onChange={(v) => update("parking", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        </div>

                        <div className="grid md:grid-cols-2 gap-4">
                          <FieldCard label="Driving style" vehicleType={vehicleType}>
                            <PillSelect options={["Gentle", "Normal", "Aggressive"]} value={form.drivingStyle} onChange={(v) => update("drivingStyle", v)} vehicleType={vehicleType} />
                          </FieldCard>
                          <FieldCard label="Usage type" vehicleType={vehicleType}>
                            <PillSelect options={["Personal", "Commercial-delivery", "Occasional"]} value={form.usageType} onChange={(v) => update("usageType", v)} vehicleType={vehicleType} />
                          </FieldCard>
                        </div>

                        {!isCar ? (
                          <div className="grid md:grid-cols-2 gap-4">
                            <FieldCard label="Average daily distance" vehicleType={vehicleType}>
                              <TextInput value={form.avgDaily} onChange={(v) => update("avgDaily", v)} placeholder="e.g. 35" vehicleType={vehicleType} suffix="km/day" />
                            </FieldCard>
                            <FieldCard label="Long idle at 100%?" vehicleType={vehicleType}>
                              <PillSelect options={["Yes", "No"]} value={form.idle100} onChange={(v) => update("idle100", v)} vehicleType={vehicleType} />
                            </FieldCard>
                          </div>
                        ) : null}

                        <div className={`rounded-[16px] p-4 flex gap-3 border ${isCar ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-200/80" : "bg-amber-50 border-amber-200 text-amber-900/80"}`}>
                          <span className="text-[18px]">💡</span>
                          <span className="text-[12.5px] leading-[1.5]">All fields affect heat. In India, <b>Hot plains + Direct sun + Delivery</b> is the harshest combo — especially for air-cooled scooters.</span>
                        </div>
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>

                <div className="flex items-center gap-3 mt-8">
                  {step > 0 && <SkeuButton variant="secondary" vehicleType={vehicleType} onClick={() => setStep((s) => s - 1)}>← Back</SkeuButton>}
                  {step < 2 ? (
                    <SkeuButton vehicleType={vehicleType} onClick={() => setStep((s) => s + 1)}>Continue →</SkeuButton>
                  ) : (
                    <SkeuButton vehicleType={vehicleType} onClick={handleCalculate}>Calculate SOH →</SkeuButton>
                  )}
                  <button onClick={() => setPage("landing")} className={`ml-auto mono text-[11px] ${isCar ? "text-white/30 hover:text-white/60" : "text-stone-500 hover:text-stone-800"}`}>Cancel</button>
                </div>
              </div>

              {/* Right - live gauge */}
              <div className="lg:sticky lg:top-[92px] space-y-4">
                <div className={`rounded-[28px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/10 to-transparent" : "bg-gradient-to-b from-black/10 to-transparent"}`}>
                  <div className={`rounded-[27px] p-6 relative overflow-hidden ${isCar ? "bg-[#0f141d] border border-white/5" : "bg-white border border-stone-200"}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div className={`mono text-[11px] font-bold tracking-widest ${isCar ? "text-white/30" : "text-stone-400"}`}>LIVE ESTIMATE</div>
                      <div className={`mono text-[10px] px-2 py-1 rounded-full border ${isCar ? "bg-white/5 border-white/10 text-white/40" : "bg-stone-50 border-stone-200 text-stone-500"}`}>{form.odometer || 0} km • {result.breakdown.equivalentCycles.toFixed(0)} cycles</div>
                    </div>
                    <div className="flex justify-center">
                      <Gauge value={result.soh} low={result.low} high={result.high} vehicleType={vehicleType} size={280} />
                    </div>
                    <div className="mt-6 space-y-2">
                      {result.factors.slice(0, 3).map((f) => (
                        <div key={f.key} className={`flex justify-between items-center text-[11px] mono px-3 py-2 rounded-full border ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/50" : "bg-stone-50 border-stone-200 text-stone-600"}`}>
                          <span className="truncate pr-3">{f.label}</span>
                          <span className={`font-bold ${isCar ? "text-white" : "text-stone-800"}`}>-{f.value.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={`rounded-[16px] p-3 flex gap-2 text-[11px] leading-[1.4] border ${isCar ? "bg-[#121821] border-white/5 text-white/40" : "bg-amber-50 border-amber-200 text-stone-600"}`}>
                  <span>🔒</span> No data leaves your device. All calculation happens in your browser. No backend, no tracking.
                </div>
              </div>
            </motion.div>
          )}

          {/* RESULTS */}
          {page === "results" && (
            <motion.div key="results" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
              {/* calibrating overlay */}
              <AnimatePresence>
                {calibrating && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#080a0f]/80 backdrop-blur-xl flex flex-col items-center justify-center">
                    <div className="relative w-[220px] h-[220px] flex items-center justify-center">
                      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }} className="absolute inset-0 rounded-full border-2 border-cyan-400/20 border-t-cyan-400" />
                      <div className="w-[180px] h-[180px] rounded-full border border-white/10 flex items-center justify-center">
                        <Gauge value={result.soh} low={result.low} high={result.high} vehicleType={vehicleType} size={160} showRange={false} />
                      </div>
                    </div>
                    <div className="mt-8 text-center">
                      <div className="mono text-[13px] tracking-widest text-cyan-300 font-bold animate-pulse">CALIBRATING DIAL…</div>
                      <div className="mono text-[11px] text-white/40 mt-2">Estimating from usage patterns • Not certified</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex flex-wrap items-center gap-3 mb-8">
                <button onClick={() => setPage("form")} className={`px-4 py-2 rounded-full text-[12px] font-bold border flex items-center gap-2 ${isCar ? "bg-white/5 border-white/10 text-white/60 hover:text-white" : "bg-white border-stone-200 text-stone-600 hover:text-stone-900"}`}>← Edit inputs</button>
                <div className={`mono text-[11px] px-3 py-1.5 rounded-full border ${isCar ? "bg-white/5 border-white/10 text-white/40" : "bg-white border-stone-200 text-stone-500"}`}>{form.makeModel || "Custom EV"} • {form.odometer || 0} km • {result.breakdown.ageYears.toFixed(1)} yr</div>
                <div className={`ml-auto mono text-[10px] px-3 py-1 rounded-full border ${isCar ? "bg-amber-500/10 border-amber-500/20 text-amber-300" : "bg-amber-100 border-amber-200 text-amber-800"}`}>ESTIMATED • NOT CERTIFIED</div>
              </div>

              <div className="grid lg:grid-cols-[1.05fr_0.9fr] gap-8 items-start">
                {/* gauge + breakdown */}
                <div className="space-y-6">
                  <div className={`rounded-[32px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/15 to-white/5 shadow-[0_20px_60px_rgba(0,0,0,0.5)]" : "bg-gradient-to-b from-black/10 to-transparent shadow-[0_20px_60px_rgba(0,0,0,0.08)]"}`}>
                    <div className={`rounded-[31px] p-8 relative overflow-hidden ${isCar ? "bg-[#0f141d]" : "bg-[#fdfcfa]"} border ${isCar ? "border-white/[0.06]" : "border-stone-200"}`}>
                      {isCar && <div className="absolute inset-0 opacity-[0.03] bg-[repeating-linear-gradient(45deg,transparent,transparent_12px,white_12px,white_13px)] pointer-events-none" />}

                      <div className="flex flex-wrap items-start justify-between gap-4 mb-2">
                        <div>
                          <div className={`mono text-[11px] tracking-widest font-bold ${isCar ? "text-white/30" : "text-stone-400"}`}>STATE OF HEALTH</div>
                          <div className={`text-[13px] mt-1 max-w-[32ch] ${isCar ? "text-white/50" : "text-stone-500"}`}>How much total capacity has been permanently lost since new.</div>
                        </div>
                        <BatteryIcon percent={result.soh} vehicleType={vehicleType} />
                      </div>

                      <div className="flex flex-col items-center py-6">
                        <Gauge value={result.soh} low={result.low} high={result.high} vehicleType={vehicleType} size={360} />
                        <div className="mt-6 text-center">
                          <div className={`mono text-[12px] tracking-widest ${isCar ? "text-white/30" : "text-stone-400"}`}>ESTIMATED SOH RANGE</div>
                          <div className={`mono font-black text-[48px] tracking-tighter leading-none mt-2 ${isCar ? "text-white" : "text-stone-900"}`}>{Math.round(result.low)}–{Math.round(result.high)}%</div>
                          <div className={`mt-3 inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12px] font-bold border ${result.soh >= 85 ? (isCar ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-emerald-100 text-emerald-800 border-emerald-200") : result.soh >= 70 ? (isCar ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-amber-100 text-amber-800 border-amber-200") : isCar ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-red-100 text-red-800 border-red-200"}`}>
                            <span className={`w-2 h-2 rounded-full ${result.soh >= 85 ? "bg-emerald-400" : result.soh >= 70 ? "bg-amber-400" : "bg-red-400"}`} />
                            {result.soh >= 85 ? "Healthy — within normal wear" : result.soh >= 70 ? "Moderate wear — check tips" : "High wear — consider checkup"}
                          </div>
                          <div className={`mono text-[11px] mt-3 max-w-[40ch] ${isCar ? "text-white/30" : "text-stone-500"}`}>Clamped 50-100% • ±{result.uncertainty.toFixed(1)}% uncertainty • Based on {result.breakdown.equivalentCycles.toFixed(0)} cycles over {result.breakdown.ageYears.toFixed(1)} yr</div>
                        </div>
                      </div>

                      {/* breakdown bars */}
                      <div className="grid grid-cols-1 gap-2.5 mt-2">
                        {Object.entries(result.breakdown)
                          .filter(([k]) => ["ageLoss", "cycleLoss", "dodPenalty", "fastPenalty", "heatPenalty", "stylePenalty"].includes(k))
                          .map(([k, v]) => {
                            const labels = { ageLoss: "Calendar age", cycleLoss: "Cycle wear", dodPenalty: "DoD / 100% idle", fastPenalty: "Fast charge", heatPenalty: "Heat exposure", stylePenalty: "Driving style" };
                            const pct = Math.min(100, (v / 8) * 100);
                            return (
                              <div key={k} className="flex items-center gap-3">
                                <div className={`mono text-[10px] w-[90px] text-right ${isCar ? "text-white/40" : "text-stone-500"}`}>{labels[k]}</div>
                                <div className={`flex-1 h-2 rounded-full overflow-hidden ${isCar ? "bg-white/5" : "bg-stone-100"} border ${isCar ? "border-white/5" : "border-stone-200"}`}>
                                  <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, delay: 0.2 }} className={`h-full rounded-full ${k === "heatPenalty" ? "bg-gradient-to-r from-orange-400 to-red-500" : k === "fastPenalty" ? "bg-gradient-to-r from-amber-400 to-orange-500" : k === "cycleLoss" ? "bg-gradient-to-r from-cyan-400 to-blue-500" : "bg-gradient-to-r from-slate-400 to-slate-600"}`} />
                                </div>
                                <div className={`mono text-[11px] w-[44px] font-bold ${isCar ? "text-white/70" : "text-stone-700"}`}>-{v.toFixed(1)}%</div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  </div>

                  {form.batteryFormat === "Swappable network" && (
                    <div className={`rounded-[16px] p-4 flex gap-3 border ${isCar ? "bg-amber-500/10 border-amber-500/20 text-amber-200" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
                      <span className="text-[20px]">🔄</span>
                      <div className="text-[12.5px] leading-[1.5]">
                        <b>Swappable battery notice:</b> Your age & km may not reflect this specific physical pack. Swapping stations rotate packs — this estimate assumes one pack. Real SOH depends on the pack you currently have. Ask station for pack health if available.
                      </div>
                    </div>
                  )}

                  <div className={`rounded-[16px] p-4 flex gap-3 border ${isCar ? "bg-white/[0.04] border-white/[0.06] text-white/50" : "bg-white border-stone-200 text-stone-600"}`}>
                    <span className="text-[16px]">⚠️</span>
                    <span className="text-[11px] mono leading-[1.5]">Estimated from usage patterns. Not a certified or lab-measured reading. For warranty or resale, get a dealer BMS diagnostic. Formula is heuristic: SOH = 100 − age − cycles − DoD − fast − heat − style, clamped 50-100%.</span>
                  </div>
                </div>

                {/* factors + tips */}
                <div className="space-y-6">
                  <div className={`rounded-[24px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/10 to-transparent" : "bg-gradient-to-b from-black/10 to-transparent"}`}>
                    <div className={`rounded-[23px] p-6 ${isCar ? "bg-[#121821] border border-white/[0.06]" : "bg-white border border-stone-200"}`}>
                      <h3 className={`font-black text-[16px] tracking-tight flex items-center gap-2 ${isCar ? "text-white" : "text-stone-900"}`}>
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] ${isCar ? "bg-red-500/20 text-red-300" : "bg-red-100 text-red-700"}`}>!</span> Top factors dragging SOH down
                      </h3>
                      <div className="mt-5 space-y-4">
                        {result.factors.slice(0, 3).map((f, i) => (
                          <div key={f.key} className={`rounded-[14px] p-4 border ${isCar ? "bg-white/[0.03] border-white/[0.06]" : "bg-stone-50 border-stone-200"}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 ${isCar ? "bg-white text-black" : "bg-stone-900 text-white"}`}>{i + 1}</div>
                              <div className="flex-1">
                                <div className={`text-[13px] font-bold leading-[1.3] ${isCar ? "text-white" : "text-stone-900"}`}>{f.label}</div>
                                <div className={`text-[12px] leading-[1.5] mt-1.5 ${isCar ? "text-white/50" : "text-stone-600"}`}>{f.plain}</div>
                              </div>
                              <div className={`mono text-[12px] font-bold px-2.5 py-1 rounded-full border ${isCar ? "bg-red-500/15 text-red-300 border-red-500/20" : "bg-red-50 text-red-700 border-red-200"}`}>-{f.value.toFixed(1)}%</div>
                            </div>
                          </div>
                        ))}
                        {result.factors.length === 0 && <div className={`text-[13px] ${isCar ? "text-white/50" : "text-stone-600"}`}>No major degradation factors — your usage looks gentle! Keep it up.</div>}
                      </div>
                    </div>
                  </div>

                  <div className={`rounded-[24px] p-[1px] ${isCar ? "bg-gradient-to-b from-white/10 to-transparent" : "bg-gradient-to-b from-black/10 to-transparent"}`}>
                    <div className={`rounded-[23px] p-6 ${isCar ? "bg-[#0f141d] border border-white/[0.06]" : "bg-[#fdfcfa] border border-stone-200"}`}>
                      <h3 className={`font-black text-[16px] tracking-tight flex items-center gap-2 ${isCar ? "text-white" : "text-stone-900"}`}>
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] ${isCar ? "bg-emerald-500/20 text-emerald-300" : "bg-emerald-100 text-emerald-700"}`}>✓</span> Tailored tips for your {isCar ? "car" : "scooter"}
                      </h3>
                      <div className="mt-5 space-y-3">
                        {tips.map((t, i) => (
                          <div key={i} className={`rounded-[14px] p-4 flex gap-3 border ${isCar ? "bg-[#121821] border-white/[0.06] hover:border-white/10" : "bg-white border-stone-200 hover:border-stone-300"} transition-colors`}>
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[16px] shrink-0 border ${isCar ? "bg-white/[0.06] border-white/10" : "bg-stone-50 border-stone-200"}`}>{t.icon}</div>
                            <div>
                              <div className={`text-[13px] font-bold ${isCar ? "text-white" : "text-stone-900"}`}>{t.title}</div>
                              <div className={`text-[12px] leading-[1.5] mt-1 ${isCar ? "text-white/50" : "text-stone-600"}`}>{t.desc}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <SkeuButton vehicleType={vehicleType} onClick={handleSave}>🪪 Save to Passport</SkeuButton>
                    <SkeuButton variant="secondary" vehicleType={vehicleType} onClick={() => { setPage("passport"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                      Open Passport
                    </SkeuButton>
                    <SkeuButton variant="secondary" vehicleType={vehicleType} onClick={() => { setPage("form"); setStep(0); window.scrollTo({ top: 0, behavior: "smooth" }); }}>↺ Re-check</SkeuButton>
                  </div>

                  <AnimatePresence>
                    {savedMsg && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className={`mono text-[11px] font-bold px-4 py-2.5 rounded-full border text-center ${isCar ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}
                      >
                        {savedMsg} — this check is now part of the vehicle's health record
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className={`rounded-[14px] p-3.5 flex gap-3 border text-[11px] leading-[1.5] ${isCar ? "bg-white/[0.03] border-white/[0.06] text-white/45" : "bg-stone-50 border-stone-200 text-stone-600"}`}>
                    <span>🪪</span>
                    <span>
                      <b>Battery Passport:</b> save each check to build a per-vehicle health record on this device. With 3+ records the app
                      switches to a <b>regression + physics blend</b> to project future SOH. Export the passport as a JSON document to show
                      at resale.
                    </span>
                  </div>

                  <div className={`mono text-[10px] leading-[1.5] p-3 rounded-[12px] border ${isCar ? "bg-white/[0.02] border-white/5 text-white/25" : "bg-stone-50 border-stone-200 text-stone-400"}`}>
                    Calculation: heuristic, not certified. Age {result.breakdown.ageRate.toFixed(1)}%/yr ({form.chemistry}), cycles {result.breakdown.cycleFactor.toFixed(3)}%/cycle ({vehicleType}), clamped 50-100%, range ±{result.uncertainty.toFixed(1)}%. Indian climate weighting applied. No OBD/BMS access.
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* BATTERY PASSPORT — data-driven history + prediction */}
          {page === "passport" && (
            <BatteryPassport
              key="passport"
              vehicleType={vehicleType}
              refreshKey={passportKey}
              onClose={() => setPage("landing")}
            />
          )}
        </AnimatePresence>
      </main>

      {/* footer disclaimer */}
      <footer className={`relative border-t mt-12 py-6 ${isCar ? "border-white/5 bg-[#080a0f]/50" : "border-stone-200 bg-white/60"}`}>
        <div className="mx-auto max-w-[1180px] px-5 md:px-8 flex flex-wrap gap-4 items-center justify-between">
          <div className={`mono text-[11px] leading-[1.5] max-w-[60ch] ${isCar ? "text-white/25" : "text-stone-500"}`}>
            EV Battery Health is an independent estimator. Not affiliated with Tata, MG, Ola, Ather, etc. Estimates are from usage patterns you enter — not a certified or lab-measured reading. For warranty, service, or resale decisions, get a proper BMS diagnostic at authorized service.
          </div>
          <div className={`mono text-[10px] px-3 py-1 rounded-full border ${isCar ? "bg-white/5 border-white/10 text-white/30" : "bg-stone-100 border-stone-200 text-stone-500"}`}>v1.0 • heuristic • India</div>
        </div>
      </footer>

      {/* custom date input fix */}
      <style>{`
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(${isCar ? 1 : 0}); opacity: 0.6; }
      `}</style>
    </div>
  );
}
