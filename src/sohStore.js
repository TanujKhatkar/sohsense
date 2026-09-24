/**
 * sohStore.js — Battery Passport storage layer
 * Persists every SOH check per vehicle on-device (localStorage).
 * Data-driven core: builds a per-vehicle health history + trend for prediction.
 * No backend, no tracking — 100% on-device. Cloud sync ready (same shape as API payload).
 */

const KEY = "sohsense.passport.v1";
const VEHICLE_KEY = "sohsense.vehicles.v1";

/**
 * Storage that NEVER throws.
 * localStorage throws a SecurityError on opaque origins — e.g. when this app is
 * opened directly as a local file (file://) or when storage is disabled in
 * private mode. In that case we silently fall back to in-memory storage so the
 * SOH calculator and Battery Passport keep working for that session.
 */
const memory = new Map();
let storageMode = null; // true = real localStorage, false = memory only
function realStorage() {
  if (storageMode !== null) return storageMode ? globalThis.localStorage : null;
  try {
    const s = globalThis.localStorage;
    const probe = "__sohsense_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    storageMode = true;
    return s;
  } catch {
    storageMode = false;
    return null;
  }
}
function readRaw(key) {
  const s = realStorage();
  if (s) {
    try {
      const v = s.getItem(key);
      if (v !== null) return v;
    } catch {}
  }
  return memory.has(key) ? memory.get(key) : null;
}
function writeRaw(key, value) {
  memory.set(key, value);
  const s = realStorage();
  if (s) {
    try {
      s.setItem(key, value);
    } catch {}
  }
}
function removeRaw(key) {
  memory.delete(key);
  const s = realStorage();
  if (s) {
    try {
      s.removeItem(key);
    } catch {}
  }
}

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** All passport entries (every check ever recorded) */
export function getRecords() {
  return safeParse(readRaw(KEY), []);
}

function setRecords(records) {
  writeRaw(KEY, JSON.stringify(records));
}

/** Stable id for a vehicle from its identity fields */
export function vehicleId(form) {
  const name = (form.makeModel || "custom").toLowerCase().replace(/\s+/g, "-");
  return `${form.vehicleType || "car"}__${name}`;
}

/** List of unique vehicles with their latest reading */
export function getVehicles() {
  const records = getRecords();
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.vehicleId) || new Date(r.savedAt) > new Date(map.get(r.vehicleId).savedAt)) {
      map.set(r.vehicleId, r);
    }
  }
  return [...map.values()].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

/** Records for one vehicle, oldest → newest */
export function getVehicleHistory(id) {
  return getRecords()
    .filter((r) => r.vehicleId === id)
    .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
}

/** Save a completed check into the passport */
export function saveRecord(form, vehicleType, result) {
  const id = vehicleId({ ...form, vehicleType });
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    vehicleId: id,
    savedAt: new Date().toISOString(),
    vehicleType,
    makeModel: form.makeModel || "Custom EV",
    odometer: parseFloat(form.odometer) || 0,
    purchaseDate: form.purchaseDate || null,
    capacity: form.capacity || null,
    chemistry: form.chemistry,
    soh: result.soh,
    low: result.low,
    high: result.high,
    uncertainty: result.uncertainty,
    cycles: result.breakdown.equivalentCycles,
    ageYears: result.breakdown.ageYears,
    breakdown: {
      ageLoss: result.breakdown.ageLoss,
      cycleLoss: result.breakdown.cycleLoss,
      dodPenalty: result.breakdown.dodPenalty,
      fastPenalty: result.breakdown.fastPenalty,
      heatPenalty: result.breakdown.heatPenalty,
      stylePenalty: result.breakdown.stylePenalty,
    },
    inputs: {
      chargingHabit: form.chargingHabit,
      fastFreq: form.fastFreq,
      chargingSource: form.chargingSource,
      climate: form.climate,
      parking: form.parking,
      drivingStyle: form.drivingStyle,
      usageType: form.usageType,
      cooling: form.cooling,
      batteryFormat: form.batteryFormat,
    },
    method: "heuristic-v1",
    certified: false,
  };
  const all = getRecords();
  all.push(entry);
  setRecords(all);
  return entry;
}

export function deleteRecord(id) {
  setRecords(getRecords().filter((r) => r.id !== id));
}

export function clearAll() {
  removeRaw(KEY);
  removeRaw(VEHICLE_KEY);
}

/** true when entries survive a reload (real storage available) */
export function isPersistent() {
  return realStorage() !== null;
}

/**
 * AI/ML-style on-device prediction.
 * Fits a least-squares regression on the vehicle's SOH history against time,
 * blends it with the physics-based decay rate (loss%/year derived from the
 * latest check) using an inverse-variance weight, then projects forward.
 * Falls back to the heuristic decay rate when history is thin (<3 points).
 */
export function predictSOH(vehicleIdOrHistory, monthsAhead = 6) {
  const history = Array.isArray(vehicleIdOrHistory)
    ? vehicleIdOrHistory
    : getVehicleHistory(vehicleIdOrHistory);

  if (!history.length) return null;

  const latest = history[history.length - 1];
  const t0 = new Date(history[0].savedAt).getTime();
  const MONTH = 1000 * 60 * 60 * 24 * 30.44;

  // --- heuristic rate: total loss per year from the physics model ---
  const totalLoss = 100 - latest.soh;
  const ageYears = Math.max(0.25, latest.ageYears || 1);
  const heuristicRatePerYear = totalLoss / ageYears; // %SOH lost per year

  // --- regression over recorded checks (if enough spread) ---
  let regressionRatePerYear = null;
  let r2 = null;
  if (history.length >= 3) {
    const xs = history.map((h) => (new Date(h.savedAt).getTime() - t0) / MONTH); // months
    const ys = history.map((h) => h.soh);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0,
      den = 0,
      ssTot = 0,
      ssRes = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const spreadMonths = xs[n - 1] - xs[0];
    if (den > 0 && spreadMonths >= 0.5) {
      const slopePerMonth = num / den; // %SOH per month
      const intercept = my - slopePerMonth * mx;
      regressionRatePerYear = slopePerMonth * 12;
      for (let i = 0; i < n; i++) {
        const pred = intercept + slopePerMonth * xs[i];
        ssRes += (ys[i] - pred) ** 2;
        ssTot += (ys[i] - my) ** 2;
      }
      r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
      // sanity gate: ignore regression if it implies impossible or inverted decay
      if (regressionRatePerYear > 0.05 || regressionRatePerYear < -50) regressionRatePerYear = null;
    }
  }

  // --- blend (inverse-variance style weighting) ---
  let ratePerYear;
  let confidence;
  let method;
  if (regressionRatePerYear !== null && r2 !== null) {
    const wReg = Math.min(0.75, Math.max(0.2, r2)); // trust regression up to 75%
    ratePerYear = wReg * regressionRatePerYear + (1 - wReg) * heuristicRatePerYear;
    confidence = Math.round(Math.min(92, 55 + r2 * 35 + Math.min(history.length, 8) * 1.2));
    method = "regression + physics blend";
  } else {
    ratePerYear = heuristicRatePerYear;
    confidence = Math.round(Math.min(70, 42 + history.length * 6));
    method = "physics decay (history thin — add more checks)";
  }

  const months = monthsAhead;
  const projected = Math.max(50, Math.round((latest.soh - (ratePerYear / 12) * months) * 10) / 10);

  // months until it crosses 80% (common warranty / resale threshold)
  const monthsTo80 =
    latest.soh > 80 && ratePerYear > 0
      ? Math.round(((latest.soh - 80) / (ratePerYear / 12)) * 10) / 10
      : latest.soh <= 80
      ? 0
      : null;

  return {
    current: latest.soh,
    projected,
    monthsAhead: months,
    ratePerYear: Math.round(ratePerYear * 100) / 100,
    regressionRatePerYear: regressionRatePerYear === null ? null : Math.round(regressionRatePerYear * 100) / 100,
    heuristicRatePerYear: Math.round(heuristicRatePerYear * 100) / 100,
    r2: r2 === null ? null : Math.round(r2 * 1000) / 1000,
    confidence,
    method,
    monthsTo80,
    points: history.length,
    band: [Math.max(50, projected - latest.uncertainty), Math.min(100, projected + latest.uncertainty)],
  };
}

/** Export one vehicle's passport as a shareable JSON document */
export function exportPassport(vehicleId) {
  const history = getVehicleHistory(vehicleId);
  if (!history.length) return null;
  const latest = history[history.length - 1];
  return {
    schema: "sohsense.battery-passport/v1",
    generatedAt: new Date().toISOString(),
    vehicle: {
      id: vehicleId,
      type: latest.vehicleType,
      makeModel: latest.makeModel,
      capacity: latest.capacity,
      chemistry: latest.chemistry,
      odometer: latest.odometer,
      ageYears: latest.ageYears,
    },
    latestSOH: { value: latest.soh, range: [latest.low, latest.high], uncertainty: latest.uncertainty, certified: false },
    history: history.map((h) => ({
      date: h.savedAt,
      soh: h.soh,
      range: [h.low, h.high],
      odometer: h.odometer,
      cycles: Math.round(h.cycles * 10) / 10,
    })),
    prediction: predictSOH(history, 6),
    disclaimer: "Estimated from usage patterns. Not a certified or lab-measured reading.",
  };
}

export function downloadJSON(filename, data) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
