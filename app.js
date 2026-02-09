// =============================
// Word → dB Translation Machine (Mock Data Prototype)
// =============================

let currentRows = [];
let dbTimeline = []; // sampled timeline for scrub preview
let durationGlobal = 30;

// ---------- Seeded RNG (repeatable) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }

// dB → font size mapping
function dbToFontPx(db, minDb, maxDb, minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  const t = (db - minDb) / (maxDb - minDb);
  return Math.round(lerp(minPx, maxPx, clamp(t, 0, 1)));
}

// Tokenize text into words
function tokenize(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}

// ---------- Presets ----------
function getPreset(presetName){
  // knobs: pauseChance, pauseMin, pauseMax, dbSmooth, spikeChance, spikeStrength
  // plus a general "density" affect by word duration jitter.
  const presets = {
    neutral: {
      pauseChance: 0.12,
      pauseMin: 0.15,
      pauseMax: 0.55,
      durJitter: 0.35,
      dbSmooth: 0.70,
      spikeChance: 0.08,
      spikeStrength: 0.75
    },
    peak: {
      pauseChance: 0.08,
      pauseMin: 0.10,
      pauseMax: 0.35,
      durJitter: 0.45,
      dbSmooth: 0.55,
      spikeChance: 0.18,
      spikeStrength: 1.00
    },
    silence: {
      pauseChance: 0.22,
      pauseMin: 0.30,
      pauseMax: 0.95,
      durJitter: 0.25,
      dbSmooth: 0.78,
      spikeChance: 0.05,
      spikeStrength: 0.55
    }
  };
  return presets[presetName] || presets.neutral;
}

// ---------- Mock timestamps across fixed duration ----------
function makeTimestamps(words, durationSec, rng, preset) {
  const n = words.length;
  if (n === 0) return [];

  const base = durationSec / n;
  let t = 0;

  const rows = [];
  for (let i = 0; i < n; i++){
    const jitter = (rng() - 0.5) * base * preset.durJitter;
    const dur = Math.max(0.12, base + jitter);

    const addPause = rng() < preset.pauseChance;
    const pause = addPause ? lerp(preset.pauseMin, preset.pauseMax, rng()) : 0;

    const start = t;
    const end = Math.min(durationSec, t + dur);
    t = end + pause;

    rows.push({ word: words[i], start, end });
    if (t >= durationSec) break;
  }

  // Ensure last word ends at duration
  if (rows.length > 0) rows[rows.length - 1].end = durationSec;

  // Fix any reversed windows
  for (const r of rows){
    if (r.end < r.start) r.end = r.start;
  }
  return rows;
}

// ---------- Mock dB per word ----------
function makeDbPerWord(rows, minDb, maxDb, rng, preset) {
  let prev = lerp(minDb, maxDb, 0.45);

  return rows.map(r => {
    // base target + smoothing (feels like speech)
    const target = lerp(minDb, maxDb, rng());
    let db = clamp(prev * preset.dbSmooth + target * (1 - preset.dbSmooth), minDb, maxDb);

    // occasional spikes (Peak preset exaggerates)
    if (rng() < preset.spikeChance){
      const spike = lerp(0.25, 1.0, rng()) * preset.spikeStrength; // 0..1
      const spikeDb = lerp(db, maxDb, spike);
      db = clamp(spikeDb, minDb, maxDb);
    }

    prev = db;
    return { ...r, db };
  });
}

// ---------- Build a simple timeline for scrub preview ----------
function buildDbTimeline(rows, durationSec, minDb, maxDb) {
  // sample every 0.05s (matches scrub step)
  const step = 0.05;
  const samples = [];
  let i = 0;

  for (let t = 0; t <= durationSec + 1e-9; t += step){
    // advance row index if needed
    while (i < rows.length && t > rows[i].end) i++;
    let db = NaN;

    if (i < rows.length && t >= rows[i].start && t <= rows[i].end) db = rows[i].db;

    // treat outside words as silence floor (minDb)
    if (Number.isNaN(db)) db = minDb;

    samples.push({ t: Number(t.toFixed(2)), db });
  }

  return samples;
}

// ---------- Render ----------
function renderWords(rows, minDb, maxDb) {
  const container = document.getElementById("wordOutput");
  container.innerHTML = "";

  rows.forEach((r, idx) => {
    const size = dbToFontPx(r.db, minDb, maxDb);
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = r.word;

    span.style.fontSize = `${size}px`;
    span.style.lineHeight = "1.05";

    // Hover tooltip
    span.title = `#${idx+1}\n${r.start.toFixed(2)}–${r.end.toFixed(2)}s\n${r.db.toFixed(1)} dB\n${size}px`;

    container.appendChild(span);
    container.appendChild(document.createTextNode(" "));
  });
}

function renderTable(rows, minDb, maxDb) {
  const tbody = document.querySelector("#metaTable tbody");
  tbody.innerHTML = "";

  rows.forEach((r, i) => {
    const size = dbToFontPx(r.db, minDb, maxDb);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(r.word)}</td>
      <td>${r.start.toFixed(2)}</td>
      <td>${r.end.toFixed(2)}</td>
      <td>${r.db.toFixed(1)}</td>
      <td>${size}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str){
  return str
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---------- CSV Download ----------
function rowsToCsv(rows, minDb, maxDb) {
  const header = ["index","word","start","end","db","font_px"];
  const lines = [header.join(",")];

  rows.forEach((r, i) => {
    const size = dbToFontPx(r.db, minDb, maxDb);
    const safeWord = `"${String(r.word).replaceAll('"','""')}"`;
    lines.push([i+1, safeWord, r.start.toFixed(2), r.end.toFixed(2), r.db.toFixed(1), size].join(","));
  });

  return lines.join("\n");
}

function downloadTextFile(filename, content, mime="text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Scrub UI ----------
function setScrubUI(durationSec){
  const scrub = document.getElementById("scrub");
  scrub.min = "0";
  scrub.max = String(durationSec);
  scrub.value = "0";
  document.getElementById("scrubTime").textContent = "0.00s";
  document.getElementById("scrubDb").textContent = "— dB";
}

function getDbAtTime(t){
  // dbTimeline sampled every 0.05; find nearest by index
  if (!dbTimeline.length) return NaN;
  const idx = clamp(Math.round(t / 0.05), 0, dbTimeline.length - 1);
  return dbTimeline[idx].db;
}

// ---------- Main Generate ----------
function generate(){
  const status = document.getElementById("status");
  const text = document.getElementById("textInput").value;

  const durationSec = Number(document.getElementById("durationSec").value);
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const presetName = document.getElementById("preset").value;
  const seed = Number(document.getElementById("seed").value) || 0;

  durationGlobal = durationSec;

  if (!text.trim()){
    status.textContent = "Please enter text.";
    return;
  }
  if (!(maxDb > minDb)){
    status.textContent = "Max dB must be greater than Min dB.";
    return;
  }
  if (durationSec <= 0){
    status.textContent = "Duration must be > 0.";
    return;
  }

  const preset = getPreset(presetName);
  const rng = mulberry32(seed);

  const words = tokenize(text);
  const tRows = makeTimestamps(words, durationSec, rng, preset);
  const rows = makeDbPerWord(tRows, minDb, maxDb, rng, preset);

  currentRows = rows;
  dbTimeline = buildDbTimeline(rows, durationSec, minDb, maxDb);

  renderWords(rows, minDb, maxDb);
  renderTable(rows, minDb, maxDb);
  setScrubUI(durationSec);

  status.textContent = `Generated ${rows.length} words • Preset: ${presetName} • Seed: ${seed}`;
}

// ---------- Wire up events ----------
document.getElementById("generateBtn").addEventListener("click", generate);

document.getElementById("newSeedBtn").addEventListener("click", () => {
  const newSeed = Math.floor(Math.random() * 1e9);
  document.getElementById("seed").value = String(newSeed);
  document.getElementById("status").textContent = `Seed set to ${newSeed}. Click Generate.`;
});

document.getElementById("downloadCsvBtn").addEventListener("click", () => {
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);

  if (!currentRows.length){
    document.getElementById("status").textContent = "Nothing to download yet — click Generate first.";
    return;
  }
  const csv = rowsToCsv(currentRows, minDb, maxDb);
  downloadTextFile("generated_word_db_data.csv", csv, "text/csv");
});

document.getElementById("scrub").addEventListener("input", (e) => {
  const t = Number(e.target.value);
  document.getElementById("scrubTime").textContent = `${t.toFixed(2)}s`;

  const db = getDbAtTime(t);
  if (Number.isFinite(db)){
    document.getElementById("scrubDb").textContent = `${db.toFixed(1)} dB`;
  } else {
    document.getElementById("scrubDb").textContent = `— dB`;
  }
});

// Auto-generate once on load
generate();