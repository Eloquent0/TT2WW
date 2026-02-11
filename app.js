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

// dB → font size mapping with different curve modes
function mapDbToSize(db, minDb, maxDb, mode = 'neutral', minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  
  // Normalize dB to 0-1 range
  let t = (db - minDb) / (maxDb - minDb);
  t = clamp(t, 0, 1);
  
  // Apply curve based on mode
  switch(mode) {
    case 'peak':
      // Exponential: emphasize louder sounds (t^2.5)
      t = Math.pow(t, 2.5);
      break;
      
    case 'silence':
      // Compress highs, expand lows: emphasize quiet sounds (sqrt)
      t = Math.pow(t, 0.4);
      break;
      
    case 'neutral':
    default:
      // Linear: keep t as is
      break;
  }
  
  return Math.round(lerp(minPx, maxPx, t));
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
  
  // Store sampleRate and duration
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  
  return { audioBuffer, sampleRate, duration };
}

// ---------- Transcription API Integration ----------
let currentAudioFile = null; // Store the uploaded file for transcription

async function uploadForTranscription(audioFile) {
  const formData = new FormData();
  formData.append('audio', audioFile);
  
  const response = await fetch('http://localhost:5000/transcribe', {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data; // Expected format: { words: [{word: string, start: number, end: number}] }
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

// ---------- Deterministic word timestamps with punctuation pauses ----------
function makeTimestamps(words) {
  const n = words.length;
  if (n === 0) return [];

  const DURATION = 30.0;
  const PAUSE_DURATION = 0.15; // seconds per punctuation pause
  const PUNCTUATION = /[.,!?;:]$/; // detect trailing punctuation
  
  // Count words with punctuation
  let pauseCount = 0;
  for (const word of words) {
    if (PUNCTUATION.test(word)) pauseCount++;
  }
  
  // Calculate time allocation
  const totalPauseTime = pauseCount * PAUSE_DURATION;
  const totalWordTime = DURATION - totalPauseTime;
  const wordDur = totalWordTime / n;
  
  // Build timestamps with pauses
  const rows = [];
  let currentTime = 0;
  
  for (let i = 0; i < n; i++) {
    const word = words[i];
    const start = currentTime;
    const end = currentTime + wordDur;
    
    rows.push({ word, start, end });
    
    currentTime = end;
    
    // Add pause after punctuation
    if (PUNCTUATION.test(word)) {
      currentTime += PAUSE_DURATION;
    }
  }
  
  return rows;
}

// ---------- Assign dB values from timeline to words ----------
function assignDbToWords(wordRows, dbTimeline, minDb = -40, maxDb = -5) {
  const SILENCE_FLOOR = -60;
  
  return wordRows.map(row => {
    const { start, end } = row;
    
    // Find all samples within this word's time range
    const samplesInRange = dbTimeline.filter(sample => 
      sample.t >= start && sample.t <= end
    );
    
    // If no samples found, use silence floor
    if (samplesInRange.length === 0) {
      const clampedSilence = clamp(SILENCE_FLOOR, minDb, maxDb);
      return { ...row, db: clampedSilence, dbMean: clampedSilence, dbMax: clampedSilence };
    }
    
    // Filter out NaN and invalid values
    const validSamples = samplesInRange.filter(s => 
      Number.isFinite(s.db) && !Number.isNaN(s.db)
    );
    
    // If all samples are invalid, use silence floor
    if (validSamples.length === 0) {
      const clampedSilence = clamp(SILENCE_FLOOR, minDb, maxDb);
      return { ...row, db: clampedSilence, dbMean: clampedSilence, dbMax: clampedSilence };
    }
    
    // Calculate dbMean (average)
    const dbSum = validSamples.reduce((sum, s) => sum + s.db, 0);
    const dbMean = dbSum / validSamples.length;
    
    // Calculate dbMax
    const dbMax = Math.max(...validSamples.map(s => s.db));
    
    // Clamp values to the styling range
    const clampedMean = clamp(dbMean, minDb, maxDb);
    const clampedMax = clamp(dbMax, minDb, maxDb);
    
    // Set db = dbMean for font size mapping
    return { ...row, db: clampedMean, dbMean: clampedMean, dbMax: clampedMax };
  });
}

// ---------- Build dB timeline directly from audio ----------
function buildDbTimeline(durationSec, minDb, maxDb) {
  // sample every 0.05s (matches scrub step)
  const step = 0.05;
  const samples = [];

  for (let t = 0; t <= durationSec + 1e-9; t += step){
    // Get dB from audio at this time point
    let db = minDb; // default to silence floor
    
    if (audioBuffer) {
      const amp = getAudioAmplitudeAtTime(t);
      db = amplitudeToDb(amp);
      db = clamp(db, minDb, maxDb);
    }

    samples.push({ t: Number(t.toFixed(2)), db });
  }

  return samples;
}

// ---------- dB to Color mapping (blue=quiet, red=loud) ----------
function dbToColor(db, minDb, maxDb) {
  if (maxDb === minDb) return 'rgb(100, 100, 255)'; // default blue
  
  // Normalize to 0-1
  let t = (db - minDb) / (maxDb - minDb);
  t = clamp(t, 0, 1);
  
  // Interpolate from blue (quiet) to red (loud)
  // Blue: rgb(100, 150, 255)
  // Red: rgb(255, 80, 80)
  const r = Math.round(100 + (155 * t));
  const g = Math.round(150 - (70 * t));
  const b = Math.round(255 - (175 * t));
  
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------- Render ----------
function renderWords(rows, minDb, maxDb, mode = 'neutral') {
  const container = document.getElementById("wordOutput");
  container.innerHTML = "";

  rows.forEach((r, idx) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const color = dbToColor(r.db, minDb, maxDb);
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = r.word;

    span.style.fontSize = `${size}px`;
    span.style.lineHeight = "1.05";
    span.style.color = color;

    // Hover tooltip
    const dbMeanStr = r.dbMean !== undefined ? r.dbMean.toFixed(1) : r.db.toFixed(1);
    const dbMaxStr = r.dbMax !== undefined ? ` | Max: ${r.dbMax.toFixed(1)}` : '';
    span.title = `#${idx+1}\n${r.start.toFixed(2)}–${r.end.toFixed(2)}s\nMean: ${dbMeanStr} dB${dbMaxStr}\n${size}px`;

    container.appendChild(span);
    container.appendChild(document.createTextNode(" "));
  });
}

function renderTable(rows, minDb, maxDb, mode = 'neutral') {
  const tbody = document.querySelector("#metaTable tbody");
  tbody.innerHTML = "";

  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const dbMean = r.dbMean !== undefined ? r.dbMean.toFixed(1) : r.db.toFixed(1);
    const dbMax = r.dbMax !== undefined ? r.dbMax.toFixed(1) : '—';
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

function escapeHtml(str){
  return str
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---------- CSV Download ----------
function rowsToCsv(rows, minDb, maxDb, mode = 'neutral') {
  const header = ["index","word","start","end","dbMean","dbMax","font_px"];
  const lines = [header.join(",")];

  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const safeWord = `"${String(r.word).replaceAll('"','""')}"`;
    const dbMean = r.dbMean !== undefined ? r.dbMean.toFixed(1) : r.db.toFixed(1);
    const dbMax = r.dbMax !== undefined ? r.dbMax.toFixed(1) : r.db.toFixed(1);
    lines.push([i+1, safeWord, r.start.toFixed(2), r.end.toFixed(2), dbMean, dbMax, size].join(","));
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

// ---------- Main Machine Runner ----------
async function runMachine(){
  const status = document.getElementById("status");
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const mode = document.getElementById("mapMode").value;
  const useTranscription = document.getElementById("useTranscription").checked;

  try {
    // === STEP 1: Validate audio loaded and duration = 30s ===
    status.textContent = "🔍 Validating audio...";
    
    if (!audioBuffer) {
      status.textContent = "❌ Please upload an audio file first.";
      return;
    }

    const durationSec = audioBuffer.duration;
    const MAX_DURATION = 30.0;
    
    if (durationSec > MAX_DURATION) {
      status.textContent = `❌ Audio must be 30s or less. Your file is ${durationSec.toFixed(2)}s.`;
      return;
    }
    
    if (durationSec <= 0) {
      status.textContent = `❌ Invalid audio duration.`;
      return;
    }
    
    if (!(maxDb > minDb)){
      status.textContent = "❌ Max dB must be greater than Min dB.";
      return;
    }

    durationGlobal = durationSec;

    let wordRows;
    
    // === STEP 2: Get word timestamps (either from API or manual input) ===
    if (useTranscription) {
      if (!currentAudioFile) {
        status.textContent = "❌ Audio file not available for transcription.";
        return;
      }
      
      // Upload to transcription API
      status.textContent = "🎙️ Uploading to transcription service...";
      const transcriptionData = await uploadForTranscription(currentAudioFile);
      
      if (!transcriptionData || !transcriptionData.words || transcriptionData.words.length === 0) {
        status.textContent = "❌ No words received from transcription service.";
        return;
      }
      
      // Use timestamps from API
      wordRows = transcriptionData.words.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end
      }));
      
      status.textContent = `✅ Received ${wordRows.length} words from transcription service.`;
      
    } else {
      // Manual text input mode
      const text = document.getElementById("textInput").value;
      
      if (!text.trim()){
        status.textContent = "❌ Please enter text.";
        return;
      }
      
      // === STEP 4: Tokenize text input into words ===
      status.textContent = "📝 Tokenizing text...";
      const words = tokenize(text);
      
      if (words.length === 0) {
        status.textContent = "❌ No words found in text.";
        return;
      }

      // === STEP 5: Generate deterministic timestamps across 30s ===
      status.textContent = `⏱️ Generating timestamps for ${words.length} words...`;
      wordRows = makeTimestamps(words);
      
      if (!wordRows || wordRows.length === 0) {
        status.textContent = "❌ Failed to generate timestamps.";
        return;
      }
    }

    // === STEP 3: Decoding audio & measuring dB (always in browser) ===
    status.textContent = "🎵 Measuring dB from audio...";
    dbTimeline = buildDbTimeline(durationSec, minDb, maxDb);
    
    if (!dbTimeline || dbTimeline.length === 0) {
      status.textContent = "❌ Failed to analyze audio.";
      return;
    }
    
    // === STEP 6: Assign dbMean/dbMax per word window ===
    status.textContent = "📊 Mapping dB to words...";
    const rows = assignDbToWords(wordRows, dbTimeline, minDb, maxDb);
    
    if (!rows || rows.length === 0) {
      status.textContent = "❌ Failed to map dB values to words.";
      return;
    }

    currentRows = rows;

    // === STEP 7: Render words (Arial black on white) ===
    status.textContent = "🎨 Rendering output...";
    renderWords(rows, minDb, maxDb, mode);
    
    // === STEP 8: Render table and enable CSV download ===
    renderTable(rows, minDb, maxDb, mode);
    setScrubUI(durationSec);

    document.getElementById("durationSec").value = durationSec.toFixed(2);

    const source = useTranscription ? 'API transcription' : 'manual text';
    status.textContent = `✅ Generated ${rows.length} words • Duration: ${durationSec.toFixed(2)}s • Mode: ${mode} • Source: ${source}`;
    
  } catch (error) {
    status.textContent = `❌ Error: ${error.message}`;
    console.error("runMachine error:", error);
  }
}

// ---------- Wire up events ----------
document.getElementById("generateBtn").addEventListener("click", runMachine);

document.getElementById("wavFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const status = document.getElementById("status");
  status.classList.remove("flashing");
  status.textContent = "Loading audio file...";
  
  try {
    const { audioBuffer: buffer, sampleRate, duration } = await loadWavFile(file);
    
    // Validate: must be 30 seconds or less
    if (duration > 30) {
      status.textContent = `Error: Audio must be 30 seconds or less. Your file is ${duration.toFixed(2)}s.`;
      audioBuffer = null; // Clear invalid buffer
      currentAudioFile = null;
      document.getElementById("durationSec").value = "0";
      e.target.value = ""; // Clear file input
      return;
    }
    
    if (duration <= 0) {
      status.textContent = `Error: Invalid audio duration.`;
      audioBuffer = null;
      currentAudioFile = null;
      document.getElementById("durationSec").value = "0";
      e.target.value = "";
      return;
    }
    
    audioBuffer = buffer;
    currentAudioFile = file; // Store for transcription API
    document.getElementById("durationSec").value = duration.toFixed(2);
    status.textContent = `Audio file loaded: ${file.name} (${duration.toFixed(2)}s, ${sampleRate}Hz). Click Generate.`;
  } catch (error) {
    status.textContent = `Error loading audio file: ${error.message}`;
    console.error(error);
    audioBuffer = null;
    e.target.value = "";
  }
});

document.getElementById("downloadCsvBtn").addEventListener("click", () => {
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const mode = document.getElementById("mapMode").value;

  if (!currentRows.length){
    document.getElementById("status").textContent = "Nothing to download yet — click Generate first.";
    return;
  }
  const csv = rowsToCsv(currentRows, minDb, maxDb, mode);
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