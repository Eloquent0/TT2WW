// =============================
// Word → dB Translation Machine (WAV File Input)
// =============================

// ---------- Supabase Configuration ----------
// IMPORTANT: Replace these with your actual Supabase credentials
const SUPABASE_URL = "https://wtgglxxwtulnosftvflj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0Z2dseHh3dHVsbm9zZnR2ZmxqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExMTA3NzksImV4cCI6MjA4NjY4Njc3OX0.UPWE0sET_GYhnu4BT3zg8j8MCFuehzM1mXPOKfrTtAk"; 
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentRows = [];
let dbTimeline = [];
let durationGlobal = 300;
let audioBuffer = null;
let audioContext = null;
let currentAudioFile = null;
let currentUser = null;

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }

// ---------- Auth State Management ----------
async function initAuth() {
  // Check for existing session
  const { data: { session } } = await supabase.auth.getSession();
  currentUser = session?.user || null;
  updateAuthUI();

  // Listen for auth changes
  supabase.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    updateAuthUI();
    
    if (event === 'SIGNED_IN') {
      document.getElementById("status").textContent = `✅ Logged in as ${currentUser.email}`;
    } else if (event === 'SIGNED_OUT') {
      document.getElementById("status").textContent = "Logged out successfully";
    }
  });
}

function updateAuthUI() {
  const emailInput = document.getElementById("emailInput");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const authInfo = document.getElementById("authInfo");
  const saveDraftBtn = document.getElementById("saveDraftBtn");
  const publishBtn = document.getElementById("publishBtn");
  const galleryBtn = document.getElementById("galleryBtn");

  if (currentUser) {
    emailInput.style.display = "none";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    authInfo.textContent = `${currentUser.email}`;
    authInfo.style.display = "inline-block";
    if (saveDraftBtn) saveDraftBtn.disabled = false;
    if (publishBtn) publishBtn.disabled = false;
    galleryBtn.style.display = "inline-block";
  } else {
    emailInput.style.display = "inline-block";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    authInfo.textContent = "";
    authInfo.style.display = "none";
    if (saveDraftBtn) saveDraftBtn.disabled = true;
    if (publishBtn) publishBtn.disabled = true;
    galleryBtn.style.display = "none";
  }
}

// ---------- dB → font size mapping ----------
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

// ---------- Parse timestamped text format ----------
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

// ---------- dB to Color mapping ----------
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
  
  // Clear the container except for the legend
  const legend = container.querySelector(".legend");
  container.innerHTML = "";
  if (legend) {
    container.appendChild(legend);
  }

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

// ---------- Build Creation Payload ----------
function buildCreationPayload() {
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const mode = document.getElementById("mapMode").value;
  
  return {
    version: "1.0",
    duration: durationGlobal,
    title: "TT2WW Creation",
    data: {
      words: currentRows,
      mapping: { minDb, maxDb, minPx: 14, maxPx: 120, mode },
      style: { outputBg: "#fff", outputText: "#000", font: "Arial" }
    }
  };
}

// ---------- Capture Output as PNG ----------
async function captureOutputPngBlob() {
  const node = document.getElementById("wordOutput");
  const canvas = await html2canvas(node, { backgroundColor: "#ffffff", scale: 2 });
  return await new Promise(res => canvas.toBlob(res, "image/png"));
}

// ---------- Save Creation to Supabase ----------
async function saveCreation({ isPublic }) {
  if (!currentUser) {
    alert("Please log in first.");
    return;
  }

  if (!currentRows.length) {
    alert("No data to save. Please generate first.");
    return;
  }

  const status = document.getElementById("status");
  status.textContent = "💾 Saving creation...";

  try {
    const payload = buildCreationPayload();
    const pngBlob = await captureOutputPngBlob();

    // 1) Insert database row
    const { data: created, error: insertErr } = await supabase
      .from("creations")
      .insert({
        user_id: currentUser.id,
        title: payload.title,
        is_public: isPublic,
        data_json: payload
      })
      .select("id")
      .single();

    if (insertErr) throw insertErr;

    const creationId = created.id;
    const imagePath = `${currentUser.id}/${creationId}.png`;

    // 2) Upload image to Storage
    const { error: upErr } = await supabase
      .storage
      .from("tt2ww-images")
      .upload(imagePath, pngBlob, { contentType: "image/png", upsert: true });

    if (upErr) throw upErr;

    // 3) Update row with image path
    const { error: updErr } = await supabase
      .from("creations")
      .update({ image_path: imagePath })
      .eq("id", creationId);

    if (updErr) throw updErr;

    const shareUrl = `${window.location.origin}/?c=${creationId}`;
    status.textContent = `✅ Saved! ${isPublic ? 'Public' : 'Private'} creation created.`;
    
    // Show share link
    showShareModal(shareUrl, isPublic);
    
  } catch (error) {
    status.textContent = `❌ Save failed: ${error.message}`;
    console.error("Save error:", error);
  }
}

// ---------- Share Modal ----------
function showShareModal(url, isPublic) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content">
      <h2>✅ Creation Saved!</h2>
      <p>${isPublic ? 'Your creation is now public and visible in the gallery.' : 'Your creation is saved privately.'}</p>
      ${isPublic ? `
        <div class="share-link">
          <input type="text" value="${url}" readonly id="shareUrl">
          <button onclick="copyShareLink()" class="btn">Copy Link</button>
        </div>
      ` : ''}
      <button onclick="closeModal()" class="btn primary">Close</button>
    </div>
  `;
  document.body.appendChild(modal);
}

window.copyShareLink = function() {
  const input = document.getElementById("shareUrl");
  input.select();
  document.execCommand("copy");
  alert("Link copied to clipboard!");
};

window.closeModal = function() {
  const modal = document.querySelector(".modal");
  if (modal) modal.remove();
};

// ---------- Gallery View ----------
async function showGallery() {
  const modal = document.createElement("div");
  modal.className = "modal gallery-modal";
  modal.innerHTML = `
    <div class="modal-content gallery-content">
      <div class="gallery-header">
        <h2>🎨 Public Creations</h2>
        <button onclick="closeModal()" class="btn ghost">✕</button>
      </div>
      <div id="galleryGrid" class="gallery-grid">
        <p>Loading...</p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Fetch public creations
  const { data, error } = await supabase
    .from("creations")
    .select("id, title, image_path, created_at, user_id")
    .eq("is_public", true)
    .order("created_at", { ascending: false })
    .limit(50);

  const grid = document.getElementById("galleryGrid");
  
  if (error || !data || data.length === 0) {
    grid.innerHTML = "<p>No public creations yet. Be the first to share!</p>";
    return;
  }

  grid.innerHTML = "";
  
  for (const item of data) {
    const card = document.createElement("div");
    card.className = "gallery-card";
    
    // Get public URL for image
    const { data: urlData } = supabase.storage
      .from("tt2ww-images")
      .getPublicUrl(item.image_path);
    
    const imageUrl = urlData?.publicUrl || "";
    const date = new Date(item.created_at).toLocaleDateString();
    
    card.innerHTML = `
      <img src="${imageUrl}" alt="${escapeHtml(item.title)}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22%3E%3Crect fill=%22%23333%22 width=%22200%22 height=%22150%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 fill=%22%23999%22 text-anchor=%22middle%22 dy=%22.3em%22%3ENo Image%3C/text%3E%3C/svg%3E'">
      <div class="gallery-info">
        <h3>${escapeHtml(item.title)}</h3>
        <p>${date}</p>
        <button onclick="loadCreation('${item.id}')" class="btn">View</button>
      </div>
    `;
    
    grid.appendChild(card);
  }
}

window.loadCreation = async function(creationId) {
  closeModal();
  const url = new URL(window.location);
  url.searchParams.set('c', creationId);
  window.location = url.toString();
};

// ---------- Load Shared Creation ----------
async function maybeLoadShared() {
  const id = new URLSearchParams(window.location.search).get("c");
  if (!id) return;

  const status = document.getElementById("status");
  status.textContent = "📥 Loading shared creation...";

  const { data, error } = await supabase
    .from("creations")
    .select("data_json, image_path, is_public, title")
    .eq("id", id)
    .single();

  if (error) {
    status.textContent = `❌ Failed to load: ${error.message}`;
    return;
  }

  if (!data.is_public && (!currentUser || data.user_id !== currentUser.id)) {
    status.textContent = "❌ This creation is private.";
    return;
  }

  // Re-render from JSON
  const payload = data.data_json;
  const minDb = payload.data.mapping.minDb || -60;
  const maxDb = payload.data.mapping.maxDb || 0;
  const mode = payload.data.mapping.mode || 'neutral';
  
  currentRows = payload.data.words;
  renderWords(currentRows, minDb, maxDb, mode);
  renderTable(currentRows, minDb, maxDb, mode);
  
  // Update controls
  document.getElementById("minDb").value = minDb;
  document.getElementById("maxDb").value = maxDb;
  document.getElementById("mapMode").value = mode;
  
  status.textContent = `✅ Loaded: ${data.title}`;
}

// ---------- Main Machine Runner ----------
async function runMachine(){
  const status = document.getElementById("status");
  status.textContent = "⏳ Processing...";
  status.classList.add("flashing");

  try {
    if (!currentAudioFile) {
      alert("Please upload an audio/video file first.");
      status.textContent = "❌ No file uploaded.";
      status.classList.remove("flashing");
      return;
    }

    const transcriptText = document.getElementById("transcriptInput").value.trim();
    if (!transcriptText) {
      alert("Please paste a transcript.");
      status.textContent = "❌ No transcript provided.";
      status.classList.remove("flashing");
      return;
    }

    const minDb = Number(document.getElementById("minDb").value);
    const maxDb = Number(document.getElementById("maxDb").value);
    const mode = document.getElementById("mapMode").value;

    // Parse transcript into words
    const words = transcriptText.split(/\s+/).filter(w => w.length > 0);
    
    // Calculate timing for each word
    const wordDuration = durationGlobal / words.length;
    
    currentRows = words.map((word, idx) => {
      const startTime = idx * wordDuration;
      const endTime = (idx + 1) * wordDuration;
      
      // Get dB values for this time range
      const dbValues = [];
      for (let t = startTime; t < endTime; t += 0.05) {
        const db = getDbAtTime(t);
        if (Number.isFinite(db)) dbValues.push(db);
      }
      
      const dbMean = dbValues.length > 0 
        ? dbValues.reduce((a, b) => a + b, 0) / dbValues.length 
        : -60;
      const dbMax = dbValues.length > 0 ? Math.max(...dbValues) : -60;
      
      return {
        word,
        start: startTime,
        end: endTime,
        db: dbMean,
        dbMean,
        dbMax
      };
    });

    // Render the results
    renderWords(currentRows, minDb, maxDb, mode);
    renderTable(currentRows, minDb, maxDb);

    status.textContent = `✅ Generated ${currentRows.length} words!`;
    status.classList.remove("flashing");

  } catch (error) {
    status.textContent = `❌ Error: ${error.message}`;
    status.classList.remove("flashing");
    console.error("Machine error:", error);
  }
}

// ---------- Event Listeners ----------
document.getElementById("generateBtn").addEventListener("click", runMachine);

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("emailInput").value.trim();
  if (!email) {
    alert("Please enter your email address");
    return;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  
  if (error) {
    alert(`Login error: ${error.message}`);
    return;
  }
  
  alert("✅ Check your email for the magic link!");
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabase.auth.signOut();
});

document.getElementById("wavFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const status = document.getElementById("status");
  status.classList.remove("flashing");
  status.textContent = "⏳ Loading audio file...";
  
  try {
    // First load the audio buffer
    const { duration } = await loadWavFile(file);
    
    if (duration > 300 || duration <= 0) {
      status.textContent = duration > 300 
        ? `❌ Error: Audio must be 5 minutes or less. Your file is ${duration.toFixed(2)}s.`
        : `❌ Error: Invalid audio duration.`;
      audioBuffer = null;
      currentAudioFile = null;
      dbTimeline = [];
      durationGlobal = 300;
      e.target.value = "";
      return;
    }
    
    currentAudioFile = file;
    durationGlobal = duration;
    
    // Now build dB timeline after audioBuffer is loaded
    const minDb = Number(document.getElementById("minDb").value) || -60;
    const maxDb = Number(document.getElementById("maxDb").value) || 0;
    
    status.textContent = "⏳ Analyzing audio amplitude...";
    dbTimeline = buildDbTimeline(duration, minDb, maxDb);
    
    setScrubUI(duration);
    
    status.textContent = `✅ Audio loaded: ${file.name} (${duration.toFixed(2)}s, ${dbTimeline.length} samples). Paste transcript and click Generate.`;
    
  } catch (error) {
    status.textContent = `❌ Error loading audio file: ${error.message}`;
    console.error("Audio load error:", error);
    audioBuffer = null;
    currentAudioFile = null;
    dbTimeline = [];
    durationGlobal = 300;
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

document.getElementById("saveDraftBtn").addEventListener("click", () => saveCreation({ isPublic: false }));
document.getElementById("publishBtn").addEventListener("click", () => saveCreation({ isPublic: true }));
document.getElementById("galleryBtn").addEventListener("click", showGallery);

// Initialize auth on page load
initAuth().then(() => {
  maybeLoadShared();
});

document.getElementById("status").textContent = "Upload a WAV file to begin.";