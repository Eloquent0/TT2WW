console.log("✅ app.js loaded");

document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ DOMContentLoaded fired");
  console.log("wavFileInput =", document.getElementById("wavFileInput"));
  console.log("durationSec  =", document.getElementById("durationSec"));
});

// =============================
// TT2WW — Word → dB Translation Machine (Audio File Input)
// =============================

// ---------- Optional Supabase (guarded so it cannot break the app) ----------
const SUPABASE_URL = "https://wtgglxxwtulnosftvflj.supabase.co";
const SUPABASE_ANON_KEY = "PASTE_REAL_ANON_PUBLIC_KEY_HERE"; // should look like a long eyJ... token

let supabase = null;
try {
  if (window.supabase && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY.startsWith("eyJ")) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("✅ Supabase initialized");
  } else {
    console.warn("⚠️ Supabase disabled: missing library or anon key not set.");
  }
} catch (e) {
  console.warn("⚠️ Supabase init failed:", e.message);
}

// ---------- State ----------
let currentRows = [];
let dbTimeline = [];
let audioBuffer = null;
let audioContext = null;
let currentAudioFile = null;

// ---------- Utils ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function tokenize(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}

function amplitudeToDb(amplitude) {
  return amplitude <= 0 ? -80 : 20 * Math.log10(amplitude);
}

function getAudioAmplitudeAtTime(time) {
  if (!audioBuffer) return 0;

  const sampleRate = audioBuffer.sampleRate;
  const sampleIndex = Math.floor(time * sampleRate);
  if (sampleIndex < 0 || sampleIndex >= audioBuffer.length) return 0;

  // Average absolute amplitude across channels at this sample index
  let sum = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    sum += Math.abs(data[sampleIndex] || 0);
  }
  return sum / audioBuffer.numberOfChannels;
}

// ---------- Mapping: dB → size ----------
function mapDbToSize(db, minDb, maxDb, mode = "neutral", minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  let t = clamp((db - minDb) / (maxDb - minDb), 0, 1);

  if (mode === "peak") t = Math.pow(t, 2.5);
  if (mode === "silence") t = Math.pow(t, 0.4);

  return Math.round(lerp(minPx, maxPx, t));
}

// ---------- Build dB timeline from real audio ----------
function buildDbTimeline(durationSec, minDb, maxDb) {
  const step = 0.05; // 50ms sampling
  const samples = [];

  for (let t = 0; t <= durationSec + 1e-9; t += step) {
    const amp = getAudioAmplitudeAtTime(t);
    const db = clamp(amplitudeToDb(amp), minDb, maxDb);
    samples.push({ t: Number(t.toFixed(2)), db });
  }

  return samples;
}

// ---------- Deterministic word timestamps across actual duration ----------
function makeTimestamps(words, durationSec) {
  const n = words.length;
  if (n === 0) return [];

  const PAUSE_DURATION = 0.15;
  const PUNCTUATION = /[.,!?;:]$/;

  const pauseCount = words.filter(w => PUNCTUATION.test(w)).length;
  const usable = Math.max(0.1, durationSec - pauseCount * PAUSE_DURATION);
  const wordDur = usable / n;

  const rows = [];
  let t = 0;

  for (const word of words) {
    const start = t;
    const end = Math.min(durationSec, t + wordDur);
    rows.push({ word, start, end });
    t = end;

    if (PUNCTUATION.test(word)) t = Math.min(durationSec, t + PAUSE_DURATION);
    if (t >= durationSec) break;
  }

  if (rows.length) rows[rows.length - 1].end = durationSec;
  return rows;
}

// ---------- Assign dB to each word window ----------
function assignDbToWords(wordRows, dbTimeline, minDb, maxDb) {
  const SILENCE_FLOOR = -60;

  return wordRows.map(row => {
    const samples = dbTimeline.filter(s => s.t >= row.start && s.t <= row.end).filter(s => Number.isFinite(s.db));

    if (!samples.length) {
      const v = clamp(SILENCE_FLOOR, minDb, maxDb);
      return { ...row, db: v, dbMean: v, dbMax: v };
    }

    const dbMean = samples.reduce((sum, s) => sum + s.db, 0) / samples.length;
    const dbMax = Math.max(...samples.map(s => s.db));

    return {
      ...row,
      db: clamp(dbMean, minDb, maxDb),
      dbMean: clamp(dbMean, minDb, maxDb),
      dbMax: clamp(dbMax, minDb, maxDb)
    };
  });
}

// ---------- Render ----------
function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderWords(rows, minDb, maxDb, mode = "neutral") {
  const container = document.getElementById("wordOutput");
  container.innerHTML = "";

  rows.forEach((r) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = r.word + " ";

    span.style.fontSize = `${size}px`;
    span.style.lineHeight = "1.05";
    // NOTE: do NOT set span.style.color here if you want CSS to control it

    container.appendChild(span);
  });
}

function renderTable(rows, minDb, maxDb, mode = "neutral") {
  const tbody = document.querySelector("#metaTable tbody");
  tbody.innerHTML = "";

  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const dbMean = (r.dbMean ?? r.db).toFixed(1);
    const dbMax = (r.dbMax ?? r.db).toFixed(1);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(r.word)}</td>
      <td>${r.start.toFixed(2)}</td>
      <td>${r.end.toFixed(2)}</td>
      <td>${dbMean}</td>
      <td>${dbMax}</td>
      <td>${size}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- CSV ----------
function rowsToCsv(rows, minDb, maxDb, mode = "neutral") {
  const lines = ["index,word,start,end,dbMean,dbMax,font_px"];
  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const safeWord = `"${String(r.word).replaceAll('"', '""')}"`;
    const dbMean = (r.dbMean ?? r.db).toFixed(1);
    const dbMax = (r.dbMax ?? r.db).toFixed(1);
    lines.push([i + 1, safeWord, r.start.toFixed(2), r.end.toFixed(2), dbMean, dbMax, size].join(","));
  });
  return lines.join("\n");
}

function downloadTextFile(filename, content, mime = "text/plain") {
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

// ---------- Scrub ----------
function setScrubUI(durationSec) {
  const scrub = document.getElementById("scrub");
  scrub.min = "0";
  scrub.max = String(durationSec);
  scrub.value = "0";
  document.getElementById("scrubTime").textContent = "0.00s";
  document.getElementById("scrubDb").textContent = "— dB";
}

function getDbAtTime(t) {
  if (!dbTimeline.length) return NaN;
  const idx = clamp(Math.round(t / 0.05), 0, dbTimeline.length - 1);
  return dbTimeline[idx].db;
}

// ---------- Main runner ----------
async function runMachine() {
  const status = document.getElementById("status");
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const mode = document.getElementById("mapMode")?.value || "neutral";

  try {
    if (!audioBuffer) {
      status.textContent = "❌ Please upload an audio file first.";
      return;
    }
    if (!(maxDb > minDb)) {
      status.textContent = "❌ Max dB must be greater than Min dB.";
      return;
    }

    const durationSec = audioBuffer.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      status.textContent = "❌ Invalid audio duration.";
      return;
    }

    const text = document.getElementById("textInput").value;
    if (!text.trim()) {
      status.textContent = "❌ Please enter text.";
      return;
    }

    status.textContent = "🎵 Measuring dB from audio...";
    dbTimeline = buildDbTimeline(durationSec, minDb, maxDb);

    status.textContent = "📝 Tokenizing text + generating timestamps...";
    const words = tokenize(text);
    const wordRows = makeTimestamps(words, durationSec);

    status.textContent = "📊 Mapping dB to words...";
    const rows = assignDbToWords(wordRows, dbTimeline, minDb, maxDb);
    currentRows = rows;

    status.textContent = "🎨 Rendering output...";
    renderWords(rows, minDb, maxDb, mode);
    renderTable(rows, minDb, maxDb, mode);
    setScrubUI(durationSec);

    // Update duration UI field
    const durEl = document.getElementById("durationSec");
    if (durEl) durEl.value = durationSec.toFixed(2);

    status.textContent = `✅ Generated ${rows.length} words • Duration: ${durationSec.toFixed(2)}s`;
  } catch (err) {
    console.error("runMachine error:", err);
    status.textContent = `❌ Error: ${err.message}`;
  }
}

// ---------- DOM wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ DOMContentLoaded");

  const status = document.getElementById("status");
  const fileInput = document.getElementById("wavFileInput");
  const generateBtn = document.getElementById("generateBtn");
  const downloadBtn = document.getElementById("downloadCsvBtn");
  const scrub = document.getElementById("scrub");

  if (!fileInput) {
    console.error("❌ Missing #wavFileInput in HTML");
    if (status) status.textContent = "❌ Missing file input (#wavFileInput).";
    return;
  }

  // File upload: decode audio and update duration field
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    console.log("Selected file:", file.name, file.type, file.size);
    if (status) status.textContent = "Loading audio file...";

    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") await audioContext.resume();

      const arrayBuffer = await file.arrayBuffer();
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      currentAudioFile = file;

      const duration = audioBuffer.duration;
      console.log("Decoded duration:", duration);

      const durEl = document.getElementById("durationSec");
      if (durEl) durEl.value = duration.toFixed(2);

      if (status) status.textContent = `✅ Loaded: ${file.name} (${duration.toFixed(2)}s). Click Generate.`;

    } catch (err) {
      console.error("decodeAudioData failed:", err);
      if (status) status.textContent = "❌ Could not decode audio. Try WAV/MP3 and confirm file isn't corrupted.";
      audioBuffer = null;
      currentAudioFile = null;
      e.target.value = "";
    }
  });

  // Generate button
  if (generateBtn) generateBtn.addEventListener("click", runMachine);

  // Download CSV
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const minDb = Number(document.getElementById("minDb").value);
      const maxDb = Number(document.getElementById("maxDb").value);
      const mode = document.getElementById("mapMode")?.value || "neutral";

      if (!currentRows.length) {
        if (status) status.textContent = "Nothing to download yet — click Generate first.";
        return;
      }
      downloadTextFile("generated_word_db_data.csv", rowsToCsv(currentRows, minDb, maxDb, mode), "text/csv");
    });
  }

  // Scrub
  if (scrub) {
    scrub.addEventListener("input", (e) => {
      const t = Number(e.target.value);
      document.getElementById("scrubTime").textContent = `${t.toFixed(2)}s`;
      const db = getDbAtTime(t);
      document.getElementById("scrubDb").textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : `— dB`;
    });
  }

  if (status) status.textContent = "Upload an audio file to begin.";
});