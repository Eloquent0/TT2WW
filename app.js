// =============================
// Word → dB Translation Machine (WAV File Input)
// =============================

let currentRows = [];
let dbTimeline = []; // sampled timeline for scrub preview
let durationGlobal = 30;
let audioBuffer = null;
let audioContext = null;

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

// ---------- WAV File Processing ----------
async function loadWavFile(file) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  return audioBuffer;
}

function getAudioAmplitudeAtTime(time) {
  if (!audioBuffer) return 0;
  
  const sampleRate = audioBuffer.sampleRate;
  const sampleIndex = Math.floor(time * sampleRate);
  
  if (sampleIndex >= audioBuffer.length) return 0;
  
  // Get amplitude from all channels (average)
  let sum = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    sum += Math.abs(channelData[sampleIndex] || 0);
  }
  
  return sum / audioBuffer.numberOfChannels;
}

function amplitudeToDb(amplitude) {
  if (amplitude <= 0) return -80;
  return 20 * Math.log10(amplitude);
}

function getDbAtWordTime(startTime, endTime) {
  if (!audioBuffer) return -40;
  
  const sampleCount = 10; // Sample 10 points within the word timeframe
  let maxAmplitude = 0;
  
  for (let i = 0; i < sampleCount; i++) {
    const t = startTime + (endTime - startTime) * (i / sampleCount);
    const amp = getAudioAmplitudeAtTime(t);
    maxAmplitude = Math.max(maxAmplitude, amp);
  }
  
  return amplitudeToDb(maxAmplitude);
}

// ---------- Distribute words evenly across duration ----------
function makeTimestamps(words, durationSec) {
  const n = words.length;
  if (n === 0) return [];

  const wordDuration = durationSec / n;
  const rows = [];
  
  for (let i = 0; i < n; i++) {
    const start = i * wordDuration;
    const end = (i + 1) * wordDuration;
    rows.push({ word: words[i], start, end });
  }
  
  return rows;
}

// ---------- Calculate dB from audio for each word ----------
function makeDbPerWord(rows, minDb, maxDb) {
  return rows.map(r => {
    const db = getDbAtWordTime(r.start, r.end);
    const clampedDb = clamp(db, minDb, maxDb);
    return { ...r, db: clampedDb };
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

  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);

  if (!audioBuffer) {
    status.textContent = "Please upload a WAV file first.";
    return;
  }

  const durationSec = audioBuffer.duration;
  durationGlobal = durationSec;

  if (!text.trim()){
    status.textContent = "Please enter text.";
    return;
  }
  if (!(maxDb > minDb)){
    status.textContent = "Max dB must be greater than Min dB.";
    return;
  }

  const words = tokenize(text);
  const tRows = makeTimestamps(words, durationSec);
  const rows = makeDbPerWord(tRows, minDb, maxDb);

  currentRows = rows;
  dbTimeline = buildDbTimeline(rows, durationSec, minDb, maxDb);

  renderWords(rows, minDb, maxDb);
  renderTable(rows, minDb, maxDb);
  setScrubUI(durationSec);

  document.getElementById("durationSec").value = durationSec.toFixed(2);

  status.textContent = `Generated ${rows.length} words • Duration: ${durationSec.toFixed(2)}s from WAV file`;
}

// ---------- Wire up events ----------
document.getElementById("generateBtn").addEventListener("click", generate);

document.getElementById("wavFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const status = document.getElementById("status");
  status.classList.remove("flashing");
  status.textContent = "Loading WAV file...";
  
  try {
    await loadWavFile(file);
    const duration = audioBuffer.duration;
    document.getElementById("durationSec").value = duration.toFixed(2);
    status.textContent = `WAV file loaded: ${file.name} (${duration.toFixed(2)}s). Click Generate.`;
  } catch (error) {
    status.textContent = `Error loading WAV file: ${error.message}`;
    console.error(error);
  }
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

// Ready to load WAV file
document.getElementById("status").textContent = "Upload a WAV file to begin.";