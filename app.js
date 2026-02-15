// =============================
// Word → dB Translation Machine (WAV File Input)
// =============================

let currentRows = [];
let dbTimeline = [];
let durationGlobal = 300;
let audioBuffer = null;
let audioContext = null;
let currentAudioFile = null;

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }

// dB → font size mapping with different curve modes
function mapDbToSize(db, minDb, maxDb, mode = 'neutral', minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  
  let t = clamp((db - minDb) / (maxDb - minDb), 0, 1);
  
  switch(mode) {
    case 'peak':
      t = Math.pow(t, 2.5);
      break;
    case 'silence':
      t = Math.pow(t, 0.4);
      break;
  }
  
  return Math.round(lerp(minPx, maxPx, t));
}

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
  
  return { audioBuffer, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
}

// ---------- Transcription API Integration ----------
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
  
  return await response.json();
}

function getAudioAmplitudeAtTime(time) {
  if (!audioBuffer) return 0;
  
  const sampleIndex = Math.floor(time * audioBuffer.sampleRate);
  if (sampleIndex >= audioBuffer.length) return 0;
  
  let sum = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    sum += Math.abs(channelData[sampleIndex] || 0);
  }
  
  return sum / audioBuffer.numberOfChannels;
}

function amplitudeToDb(amplitude) {
  return amplitude <= 0 ? -80 : 20 * Math.log10(amplitude);
}

// ---------- Parse timestamped text format (time\nword\ntime\nword) ----------
function parseTimestampedText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const result = [];
  
  for (let i = 0; i < lines.length - 1; i += 2) {
    const timeMatch = lines[i].match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!timeMatch) continue;
    
    const hours = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    const minutes = parseInt(timeMatch[1], 10);
    const seconds = parseInt(timeMatch[2], 10);
    const startTime = hours * 3600 + minutes * 60 + seconds;
    const words = lines[i + 1].trim().split(/\s+/).filter(Boolean);
    
    result.push({ time: startTime, text: lines[i + 1], words });
  }
  
  return result;
}

function timestampsToWordRows(timestampedSegments) {
  const wordRows = [];
  
  for (let i = 0; i < timestampedSegments.length; i++) {
    const segment = timestampedSegments[i];
    const nextSegment = timestampedSegments[i + 1];
    
    const segmentStart = segment.time;
    const segmentEnd = nextSegment ? nextSegment.time : segmentStart + 2.0;
    const wordDuration = (segmentEnd - segmentStart) / segment.words.length;
    
    if (segment.words.length === 0) continue;
    
    for (let j = 0; j < segment.words.length; j++) {
      const start = segmentStart + (j * wordDuration);
      wordRows.push({ word: segment.words[j], start, end: start + wordDuration });
    }
  }
  
  return wordRows;
}

function makeTimestamps(words) {
  const n = words.length;
  if (n === 0) return [];

  const DURATION = 300.0;
  const PAUSE_DURATION = 0.15;
  const PUNCTUATION = /[.,!?;:]$/;
  
  let pauseCount = words.filter(word => PUNCTUATION.test(word)).length;
  const wordDur = (DURATION - (pauseCount * PAUSE_DURATION)) / n;
  
  const rows = [];
  let currentTime = 0;
  
  for (const word of words) {
    rows.push({ word, start: currentTime, end: currentTime + wordDur });
    currentTime += wordDur;
    if (PUNCTUATION.test(word)) currentTime += PAUSE_DURATION;
  }
  
  return rows;
}

function assignDbToWords(wordRows, dbTimeline, minDb = -40, maxDb = -5) {
  const SILENCE_FLOOR = -60;
  
  return wordRows.map(row => {
    const { start, end } = row;
    const pitchHz = getPitchForWord(start, end);
    
    const samplesInRange = dbTimeline.filter(s => s.t >= start && s.t <= end);
    const validSamples = samplesInRange.filter(s => Number.isFinite(s.db));
    
    if (validSamples.length === 0) {
      const clampedSilence = clamp(SILENCE_FLOOR, minDb, maxDb);
      return { ...row, db: clampedSilence, dbMean: clampedSilence, dbMax: clampedSilence, pitchHz };
    }
    
    const dbMean = validSamples.reduce((sum, s) => sum + s.db, 0) / validSamples.length;
    const dbMax = Math.max(...validSamples.map(s => s.db));
    
    return { 
      ...row, 
      db: clamp(dbMean, minDb, maxDb), 
      dbMean: clamp(dbMean, minDb, maxDb), 
      dbMax: clamp(dbMax, minDb, maxDb), 
      pitchHz 
    };
  });
}

function buildDbTimeline(durationSec, minDb, maxDb) {
  const step = 0.05;
  const samples = [];

  for (let t = 0; t <= durationSec + 1e-9; t += step){
    let db = minDb;
    
    if (audioBuffer) {
      const amp = getAudioAmplitudeAtTime(t);
      db = clamp(amplitudeToDb(amp), minDb, maxDb);
    }

    samples.push({ t: Number(t.toFixed(2)), db });
  }

  return samples;
}

// ---------- Pitch Estimation ----------
function estimatePitchAtTime(time, minHz = 80, maxHz = 1000) {
  if (!audioBuffer) return null;

  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const windowSize = 2048;

  if (channelData.length < windowSize) return null;

  let center = Math.floor(time * sampleRate);
  let start = Math.max(0, center - Math.floor(windowSize / 2));
  if (start + windowSize > channelData.length) {
    start = channelData.length - windowSize;
  }

  const buffer = channelData.subarray(start, start + windowSize);

  let energy = 0;
  for (let i = 0; i < buffer.length; i++) {
    energy += buffer[i] * buffer[i];
  }

  const rms = Math.sqrt(energy / buffer.length);
  if (rms < 0.01) return null;

  let minLag = Math.floor(sampleRate / maxHz);
  let maxLag = Math.min(Math.floor(sampleRate / minHz), buffer.length - 1);

  if (minLag >= maxLag) return null;

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < buffer.length - lag; i++) {
      sum += buffer[i] * buffer[i + lag];
    }

    if (sum > bestCorr) {
      bestCorr = sum;
      bestLag = lag;
    }
  }

  if (bestLag === -1 || energy === 0 || (bestCorr / energy) < 0.25) return null;

  return sampleRate / bestLag;
}

function getPitchForWord(start, end) {
  if (!audioBuffer) return null;
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const pitches = [0.25, 0.5, 0.75]
    .map(p => estimatePitchAtTime(start + duration * p))
    .filter(p => Number.isFinite(p));

  return pitches.length ? pitches.reduce((a, b) => a + b, 0) / pitches.length : null;
}

// ---------- dB to Color mapping (blue → red gradient, no yellow/green) ----------
function dbToColor(db, minDb, maxDb) {
  if (maxDb === minDb) return 'rgb(100, 100, 255)';
  
  let t = clamp(Math.pow((db - minDb) / (maxDb - minDb), 0.6), 0, 1);

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
    span.style.marginRight = `${clamp(Math.round(size * 0.18), 6, 48)}px`;

    const dbMeanStr = (r.dbMean !== undefined ? r.dbMean : r.db).toFixed(1);
    const dbMaxStr = r.dbMax !== undefined ? ` | Max: ${r.dbMax.toFixed(1)}` : '';
    const pitchStr = Number.isFinite(r.pitchHz) ? `${r.pitchHz.toFixed(1)} Hz` : '—';
    span.title = `#${idx+1}\n${r.start.toFixed(2)}–${r.end.toFixed(2)}s\nMean: ${dbMeanStr} dB${dbMaxStr}\nPitch: ${pitchStr}\n${size}px`;

    container.appendChild(span);
  });
}

function renderTable(rows, minDb, maxDb, mode = 'neutral') {
  const tbody = document.querySelector("#metaTable tbody");
  tbody.innerHTML = "";

  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const dbMean = (r.dbMean !== undefined ? r.dbMean : r.db).toFixed(1);
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
  const lines = ["index,word,start,end,dbMean,dbMax,font_px"];

  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const safeWord = `"${String(r.word).replaceAll('"','""')}"`;
    const dbMean = (r.dbMean !== undefined ? r.dbMean : r.db).toFixed(1);
    const dbMax = (r.dbMax !== undefined ? r.dbMax : r.db).toFixed(1);
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
    status.textContent = "🔍 Validating audio...";
    
    if (!audioBuffer) {
      status.textContent = "❌ Please upload an audio file first.";
      return;
    }

    const durationSec = audioBuffer.duration;
    const MAX_DURATION = 300.0;

    if (durationSec > MAX_DURATION) {
      status.textContent = `❌ Audio must be 5 minutes or less. Your file is ${durationSec.toFixed(2)}s.`;
      return;
    }
    
    if (durationSec <= 0 || !(maxDb > minDb)) {
      status.textContent = durationSec <= 0 ? "❌ Invalid audio duration." : "❌ Max dB must be greater than Min dB.";
      return;
    }

    durationGlobal = durationSec;

    let wordRows;
    
    if (useTranscription) {
      if (!currentAudioFile) {
        status.textContent = "❌ Audio file not available for transcription.";
        return;
      }
      
      status.textContent = "🎙️ Uploading to transcription service...";
      const transcriptionData = await uploadForTranscription(currentAudioFile);
      
      if (!transcriptionData?.words?.length) {
        status.textContent = "❌ No words received from transcription service.";
        return;
      }
      
      wordRows = transcriptionData.words.map(w => ({ word: w.word, start: w.start, end: w.end }));
      status.textContent = `✅ Received ${wordRows.length} words from transcription service.`;
      
    } else {
      const text = document.getElementById("textInput").value;
      
      if (!text.trim()){
        status.textContent = "❌ Please enter text.";
        return;
      }
      
      const hasTimestamps = /^\d+:\d{2}/m.test(text);
      
      if (hasTimestamps) {
        status.textContent = "📝 Parsing timestamped text...";
        const timestampedSegments = parseTimestampedText(text);
        
        if (!timestampedSegments.length) {
          status.textContent = "❌ No valid timestamps found.";
          return;
        }
        
        wordRows = timestampsToWordRows(timestampedSegments);
        
        if (!wordRows.length) {
          status.textContent = "❌ No words found in timestamped text.";
          return;
        }
        
        status.textContent = `✅ Parsed ${wordRows.length} words from ${timestampedSegments.length} timestamped segments.`;
      } else {
        status.textContent = "📝 Tokenizing text...";
        const words = tokenize(text);
        
        if (!words.length) {
          status.textContent = "❌ No words found in text.";
          return;
        }

        status.textContent = `⏱️ Generating timestamps for ${words.length} words...`;
        wordRows = makeTimestamps(words);
      }
    }

    if (!wordRows?.length) {
      status.textContent = "❌ Failed to generate timestamps.";
      return;
    }

    status.textContent = "🎵 Measuring dB from audio...";
    dbTimeline = buildDbTimeline(durationSec, minDb, maxDb);
    
    if (!dbTimeline?.length) {
      status.textContent = "❌ Failed to analyze audio.";
      return;
    }
    
    status.textContent = "📊 Mapping dB to words...";
    const rows = assignDbToWords(wordRows, dbTimeline, minDb, maxDb);
    
    if (!rows?.length) {
      status.textContent = "❌ Failed to map dB values to words.";
      return;
    }

    currentRows = rows;

    status.textContent = "🎨 Rendering output...";
    renderWords(rows, minDb, maxDb, mode);
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
    const { duration } = await loadWavFile(file);
    
    if (duration > 300 || duration <= 0) {
      status.textContent = duration > 300 
        ? `Error: Audio must be 5 minutes or less. Your file is ${duration.toFixed(2)}s.`
        : `Error: Invalid audio duration.`;
      audioBuffer = null;
      currentAudioFile = null;
      document.getElementById("durationSec").value = "0";
      e.target.value = "";
      return;
    }
    
    currentAudioFile = file;
    document.getElementById("durationSec").value = duration.toFixed(2);
    status.textContent = `Audio file loaded: ${file.name} (${duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz). Click Generate.`;
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
  downloadTextFile("generated_word_db_data.csv", rowsToCsv(currentRows, minDb, maxDb, mode), "text/csv");
});

document.getElementById("scrub").addEventListener("input", (e) => {
  const t = Number(e.target.value);
  document.getElementById("scrubTime").textContent = `${t.toFixed(2)}s`;

  const db = getDbAtTime(t);
  document.getElementById("scrubDb").textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : `— dB`;
});

document.getElementById("status").textContent = "Upload a WAV file to begin.";
const SUPABASE_URL = "https://wtgglxxwtulnosftvflj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_7fD-sfI8wb8IU8x-x1qALg_kZ0lHuJ4";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);