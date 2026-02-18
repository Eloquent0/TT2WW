// ---------- State ----------
let currentRows = [];
let dbTimeline = [];
let audioBuffer = null;
let audioContext = null;
let currentAudioFile = null;
let updatePlayButtonState = null; // assigned in DOMContentLoaded

// ---------- Animation State (module-level so runMachine can reset it) ----------
let animRafId = null;
let animStartTime = null;
let animOffset = 0;
let animIsPlaying = false;
let animNextWordIndex = 0;
let animStopFn = null;    // assigned in DOMContentLoaded
let animShowAllFn = null; // assigned in DOMContentLoaded

// ---------- Utils ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function tokenize(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}

// ---------- Parse timestamp format (time on one line, words on next) ----------
function parseTimestampedText(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const segments = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this line is a timestamp (format: M:SS or MM:SS)
    const timeMatch = line.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch && i + 1 < lines.length) {
      const minutes = parseInt(timeMatch[1]);
      const seconds = parseInt(timeMatch[2]);
      const timeInSeconds = minutes * 60 + seconds;
      const words = lines[i + 1].trim();
      
      if (words) {
        segments.push({ time: timeInSeconds, words });
      }
      i++; // Skip the next line since we already processed it
    }
  }
  
  return segments;
}

// ---------- Create word rows from timestamped segments ----------
function makeTimestampsFromSegments(segments, durationSec) {
  if (!segments.length) return [];
  
  const rows = [];
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const words = tokenize(seg.words);
    const startTime = seg.time;
    const endTime = i + 1 < segments.length ? segments[i + 1].time : durationSec;
    const segDuration = endTime - startTime;
    const wordDuration = words.length > 0 ? segDuration / words.length : 0;
    
    words.forEach((word, idx) => {
      const start = startTime + (idx * wordDuration);
      const end = Math.min(startTime + ((idx + 1) * wordDuration), endTime);
      rows.push({ word, start, end });
    });
  }
  
  return rows;
}

function amplitudeToDb(amplitude) {
  return amplitude <= 0 ? -80 : 20 * Math.log10(amplitude);
}

function getAudioAmplitudeAtTime(time) {
  if (!audioBuffer) return 0;
  const sampleIndex = Math.floor(time * audioBuffer.sampleRate);
  if (sampleIndex < 0 || sampleIndex >= audioBuffer.length) return 0;
  let sum = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    sum += Math.abs(audioBuffer.getChannelData(ch)[sampleIndex] || 0);
  }
  return sum / audioBuffer.numberOfChannels;
}

// ---------- dB → size ----------
function mapDbToSize(db, minDb, maxDb, mode = "neutral", minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  let t = clamp((db - minDb) / (maxDb - minDb), 0, 1);
  if (mode === "peak") t = Math.pow(t, 2.5);
  if (mode === "silence") t = Math.pow(t, 0.4);
  return Math.round(lerp(minPx, maxPx, t));
}

// ---------- Build dB timeline ----------
function buildDbTimeline(durationSec, minDb, maxDb) {
  const step = 0.05;
  const samples = [];
  for (let t = 0; t <= durationSec + 1e-9; t += step) {
    const amp = getAudioAmplitudeAtTime(t);
    const db = clamp(amplitudeToDb(amp), minDb, maxDb);
    samples.push({ t: Number(t.toFixed(2)), db });
  }
  return samples;
}

// ---------- Word timestamps — duration passed directly, never relies on global ----------
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

// ---------- Assign dB to words (with multiple calculation modes) ----------
function assignDbToWords(wordRows, dbTimeline, minDb, maxDb, method = 'rms') {
  const SILENCE_FLOOR = -60;
  
  return wordRows.map(row => {
    const samples = dbTimeline
      .filter(s => s.t >= row.start && s.t <= row.end)
      .filter(s => Number.isFinite(s.db));

    if (!samples.length) {
      const v = clamp(SILENCE_FLOOR, minDb, maxDb);
      return { ...row, db: v, dbMean: v, dbMax: v };
    }

    let db;
    const dbMean = samples.reduce((sum, s) => sum + s.db, 0) / samples.length;
    const dbMax = Math.max(...samples.map(s => s.db));
    
    switch(method) {
      case 'rms': {
        const linearValues = samples.map(s => Math.pow(10, s.db / 20));
        const rms = Math.sqrt(linearValues.reduce((sum, v) => sum + v * v, 0) / linearValues.length);
        db = clamp(20 * Math.log10(rms), minDb, maxDb);
        break;
      }
      case 'weighted': {
        const weighted = samples.reduce((sum, s, i) => {
          const position = i / (samples.length - 1 || 1);
          const weight = Math.exp(-Math.pow((position - 0.5) * 3, 2));
          return sum + s.db * weight;
        }, 0);
        const totalWeight = samples.reduce((sum, s, i) => {
          const position = i / (samples.length - 1 || 1);
          return sum + Math.exp(-Math.pow((position - 0.5) * 3, 2));
        }, 0);
        db = clamp(weighted / totalWeight, minDb, maxDb);
        break;
      }
      case 'peak_smooth': {
        const sorted = [...samples].sort((a, b) => b.db - a.db);
        const topCount = Math.max(1, Math.ceil(sorted.length * 0.3));
        const topSamples = sorted.slice(0, topCount);
        db = clamp(topSamples.reduce((sum, s) => sum + s.db, 0) / topSamples.length, minDb, maxDb);
        break;
      }
      case 'median': {
        const sorted = [...samples].sort((a, b) => a.db - b.db);
        const mid = Math.floor(sorted.length / 2);
        db = sorted.length % 2 === 0
          ? clamp((sorted[mid - 1].db + sorted[mid].db) / 2, minDb, maxDb)
          : clamp(sorted[mid].db, minDb, maxDb);
        break;
      }
      default:
        db = clamp(dbMean, minDb, maxDb);
    }

    return {
      ...row,
      db: db,
      dbMean: clamp(dbMean, minDb, maxDb),
      dbMax: clamp(dbMax, minDb, maxDb)
    };
  });
}

// ---------- Color ----------
function dbToColor(db, minDb, maxDb) {
  if (maxDb === minDb) return "rgb(100,100,255)";
  const t = clamp(Math.pow((db - minDb) / (maxDb - minDb), 0.6), 0, 1);
  return `rgb(${Math.round(100 + 155 * t)},${Math.round(150 - 70 * t)},${Math.round(255 - 175 * t)})`;
}

// ---------- Render ----------
function escapeHtml(str) {
  return str.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
            .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function renderWords(rows, minDb, maxDb, mode = "neutral") {
  const container = document.getElementById("wordOutput");
  container.innerHTML = "";
  rows.forEach((r, index) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const color = dbToColor(r.db, minDb, maxDb);
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = r.word;
    span.style.fontSize = `${size}px`;
    span.style.lineHeight = "1.05";
    span.style.color = color;
    span.style.marginRight = `${clamp(Math.round(size * 0.18), 6, 48)}px`;
    
    span.setAttribute('data-word', r.word);
    span.setAttribute('data-index', index + 1);
    span.setAttribute('data-start', r.start.toFixed(2));
    span.setAttribute('data-end', r.end.toFixed(2));
    span.setAttribute('data-db', (r.dbMean ?? r.db).toFixed(1));
    span.setAttribute('data-db-max', (r.dbMax ?? r.db).toFixed(1));
    span.setAttribute('data-size', size);
    
    const tooltip = document.createElement('div');
    tooltip.className = 'word-tooltip';
    tooltip.innerHTML = `
      <div class="tooltip-row"><strong>#${index + 1}:</strong> ${escapeHtml(r.word)}</div>
      <div class="tooltip-row"><strong>Time:</strong> ${r.start.toFixed(2)}s - ${r.end.toFixed(2)}s</div>
      <div class="tooltip-row"><strong>dB Mean:</strong> ${(r.dbMean ?? r.db).toFixed(1)} dB</div>
      <div class="tooltip-row"><strong>dB Max:</strong> ${(r.dbMax ?? r.db).toFixed(1)} dB</div>
      <div class="tooltip-row"><strong>Font Size:</strong> ${size}px</div>
    `;
    span.appendChild(tooltip);
    container.appendChild(span);
  });
}

function renderTable(rows, minDb, maxDb, mode = "neutral") {
  const tbody = document.querySelector("#metaTable tbody");
  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const size = mapDbToSize(r.db, minDb, maxDb, mode);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(r.word)}</td>
      <td>${r.start.toFixed(2)}</td>
      <td>${r.end.toFixed(2)}</td>
      <td>${(r.dbMean ?? r.db).toFixed(1)}</td>
      <td>${(r.dbMax ?? r.db).toFixed(1)}</td>
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
    lines.push([
      i + 1,
      `"${String(r.word).replaceAll('"','""')}"`,
      r.start.toFixed(2), r.end.toFixed(2),
      (r.dbMean ?? r.db).toFixed(1),
      (r.dbMax ?? r.db).toFixed(1),
      size
    ].join(","));
  });
  return lines.join("\n");
}

function downloadTextFile(filename, content, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

// ---------- Scrub ----------
function setScrubUI(durationSec) {
  const scrub = document.getElementById("scrub");
  scrub.min = "0"; scrub.max = String(durationSec); scrub.value = "0";
  document.getElementById("scrubTime").textContent = "0.00s";
  document.getElementById("scrubDb").textContent = "— dB";
}

function getDbAtTime(t) {
  if (!dbTimeline.length) return NaN;
  return dbTimeline[clamp(Math.round(t / 0.05), 0, dbTimeline.length - 1)].db;
}

// ---------- Main runner ----------
async function runMachine() {
  const status = document.getElementById("status");
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);
  const mode = document.getElementById("mapMode")?.value || "neutral";
  const volumeMethod = document.getElementById("volumeMethod")?.value || "rms";

  try {
    if (!audioBuffer) { status.textContent = "❌ Please upload an audio file first."; return; }
    if (!(maxDb > minDb)) { status.textContent = "❌ Max dB must be greater than Min dB."; return; }

    const durationSec = audioBuffer.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      status.textContent = "❌ Invalid audio duration."; return;
    }

    const text = document.getElementById("textInput").value;
    if (!text.trim()) { status.textContent = "❌ Please enter text."; return; }

    status.textContent = "🎵 Measuring dB from audio...";
    dbTimeline = buildDbTimeline(durationSec, minDb, maxDb);

    status.textContent = "📝 Tokenizing + timestamping...";
    
    const hasTimestamps = /^\d{1,2}:\d{2}$/m.test(text);
    let wordRows;
    
    if (hasTimestamps) {
      const segments = parseTimestampedText(text);
      if (segments.length === 0) {
        status.textContent = "❌ No valid timestamps found."; return;
      }
      wordRows = makeTimestampsFromSegments(segments, durationSec);
      status.textContent = `📝 Parsed ${segments.length} timestamped segments...`;
    } else {
      const words = tokenize(text);
      wordRows = makeTimestamps(words, durationSec);
    }

    status.textContent = "📊 Mapping dB to words...";
    const rows = assignDbToWords(wordRows, dbTimeline, minDb, maxDb, volumeMethod);
    currentRows = rows;

    status.textContent = "🎨 Rendering...";
    renderWords(rows, minDb, maxDb, mode);
    renderTable(rows, minDb, maxDb, mode);
    setScrubUI(durationSec);

    const durEl = document.getElementById("durationSec");
    if (durEl) durEl.value = durationSec.toFixed(2);

    status.textContent = `✅ Generated ${rows.length} words • Duration: ${durationSec.toFixed(2)}s`;

    // Reset animation state so Play is ready from the start
    if (animRafId !== null) { cancelAnimationFrame(animRafId); animRafId = null; }
    animIsPlaying = false;
    animOffset = 0;
    animNextWordIndex = 0;
    // Show all words in static state (no fade — just reset)
    document.querySelectorAll("#wordOutput .word").forEach(el => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
      el.style.transition = "none";
    });
    const playBtn = document.getElementById("playAnimationBtn");
    if (playBtn) { playBtn.textContent = "▶ Play"; playBtn.classList.remove("playing"); }
    if (updatePlayButtonState) updatePlayButtonState();
  } catch (err) {
    console.error("runMachine error:", err);
    status.textContent = `❌ Error: ${err.message}`;
  }
}

// ---------- Auth UI ----------
function updateAuthUI() {
  const emailInput = document.getElementById("emailInput");
  const loginBtn   = document.getElementById("loginBtn");
  const logoutBtn  = document.getElementById("logoutBtn");
  const authInfo   = document.getElementById("authInfo");
  const saveDraftBtn = document.getElementById("saveDraftBtn");
  const publishBtn   = document.getElementById("publishBtn");
  const galleryBtn   = document.getElementById("galleryBtn");

  if (currentUser) {
    if (emailInput) emailInput.style.display = "none";
    if (loginBtn)   loginBtn.style.display   = "none";
    if (logoutBtn)  logoutBtn.style.display  = "inline-block";
    if (authInfo)  { authInfo.textContent = currentUser.email; authInfo.style.display = "inline-block"; }
    if (saveDraftBtn) saveDraftBtn.disabled = false;
    if (publishBtn)   publishBtn.disabled   = false;
    if (galleryBtn)   galleryBtn.style.display = "inline-block";
  } else {
    if (emailInput) emailInput.style.display = "inline-block";
    if (loginBtn)   loginBtn.style.display   = "inline-block";
    if (logoutBtn)  logoutBtn.style.display  = "none";
    if (authInfo)  { authInfo.textContent = ""; authInfo.style.display = "none"; }
    if (saveDraftBtn) saveDraftBtn.disabled = true;
    if (publishBtn)   publishBtn.disabled   = true;
    if (galleryBtn)   galleryBtn.style.display = "none";
  }
}

// ---------- Save to Supabase ----------
async function saveCreation({ isPublic }) {
  if (!supabase) return alert("Supabase not connected.");
  if (!currentUser) return alert("Please log in first.");
  if (!currentRows.length) return alert("Generate something first.");

  const status = document.getElementById("status");
  status.textContent = "💾 Saving...";

  try {
    const minDb = Number(document.getElementById("minDb").value);
    const maxDb = Number(document.getElementById("maxDb").value);
    const mode  = document.getElementById("mapMode")?.value || "neutral";

    const payload = {
      version: "1.0",
      data: {
        words: currentRows,
        mapping: { minDb, maxDb, minPx: 14, maxPx: 120, mode }
      }
    };

    const { data: created, error: insertErr } = await supabase
      .from("creations")
      .insert({ user_id: currentUser.id, title: "TT2WW", is_public: isPublic, data_json: payload })
      .select("id").single();

    if (insertErr) throw insertErr;

    const shareUrl = `${window.location.origin}${window.location.pathname}?c=${created.id}`;
    status.textContent = `✅ Saved! ${isPublic ? "Public" : "Private"}`;

    if (isPublic) {
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-content">
          <h2>✅ Published!</h2>
          <p>Your creation is now public.</p>
          <div class="share-link">
            <input type="text" value="${shareUrl}" readonly id="shareUrl">
            <button onclick="navigator.clipboard.writeText(document.getElementById('shareUrl').value).then(()=>alert('Copied!'))" class="btn">Copy Link</button>
          </div>
          <button onclick="this.closest('.modal').remove()" class="btn primary" style="margin-top:12px">Close</button>
        </div>`;
      document.body.appendChild(modal);
    }
  } catch (err) {
    status.textContent = `❌ Save failed: ${err.message}`;
    console.error(err);
  }
}

// ---------- Gallery ----------
async function showGallery() {
  if (!supabase) return alert("Supabase not connected.");

  const modal = document.createElement("div");
  modal.className = "modal gallery-modal";
  modal.innerHTML = `
    <div class="modal-content gallery-content">
      <div class="gallery-header">
        <h2>🎨 Public Creations</h2>
        <button onclick="this.closest('.modal').remove()" class="btn ghost">✕</button>
      </div>
      <div id="galleryGrid" class="gallery-grid"><p>Loading...</p></div>
    </div>`;
  document.body.appendChild(modal);

  try {
    const { data, error } = await supabase
      .from("creations")
      .select("id, title, created_at")
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(50);

    const grid = document.getElementById("galleryGrid");
    if (error || !data?.length) {
      grid.innerHTML = "<p>No public creations yet. Be the first to share!</p>";
      return;
    }

    grid.innerHTML = "";
    data.forEach(item => {
      const card = document.createElement("div");
      card.className = "gallery-card";
      const date = new Date(item.created_at).toLocaleDateString();
      card.innerHTML = `
        <div class="gallery-info">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${date}</p>
          <button class="btn" onclick="
            this.closest('.modal').remove();
            const u = new URL(window.location);
            u.searchParams.set('c','${item.id}');
            window.location = u.toString();
          ">View</button>
        </div>`;
      grid.appendChild(card);
    });
  } catch (err) {
    document.getElementById("galleryGrid").innerHTML = `<p>Error: ${err.message}</p>`;
  }
}

// ---------- Load shared creation from URL ----------
async function maybeLoadShared() {
  if (!supabase) return;
  const id = new URLSearchParams(window.location.search).get("c");
  if (!id) return;

  const status = document.getElementById("status");
  status.textContent = "📥 Loading shared creation...";

  try {
    const { data, error } = await supabase
      .from("creations")
      .select("data_json, is_public, title")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!data.is_public) { status.textContent = "❌ This creation is private."; return; }

    const { data: { words, mapping } } = data.data_json;
    const { minDb, maxDb, mode } = mapping;

    currentRows = words;
    renderWords(currentRows, minDb, maxDb, mode);
    renderTable(currentRows, minDb, maxDb, mode);
    document.getElementById("minDb").value = minDb;
    document.getElementById("maxDb").value = maxDb;
    if (document.getElementById("mapMode")) document.getElementById("mapMode").value = mode;
    status.textContent = `✅ Loaded: ${data.title}`;
  } catch (err) {
    status.textContent = `❌ Failed to load: ${err.message}`;
  }
}

// ---------- DOM wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");

  // --- Version Details ---
  const versionDetails = document.getElementById("versionDetails");
  let animationTimer = null;

  if (versionDetails) {
    const summary = versionDetails.querySelector("summary");
    if (summary) {
      summary.addEventListener("click", (e) => {
        e.preventDefault();
        if (animationTimer !== null) {
          clearTimeout(animationTimer);
          animationTimer = null;
          const interrupted = versionDetails.dataset.state;
          if (interrupted === "closing") versionDetails.open = false;
          versionDetails.removeAttribute("data-state");
        }
        const isOpen = versionDetails.open;
        if (isOpen) {
          versionDetails.dataset.state = "closing";
          animationTimer = setTimeout(() => {
            versionDetails.open = false;
            versionDetails.removeAttribute("data-state");
            animationTimer = null;
          }, 300);
        } else {
          versionDetails.open = true;
          void versionDetails.offsetHeight;
          versionDetails.dataset.state = "opening";
          animationTimer = setTimeout(() => {
            versionDetails.removeAttribute("data-state");
            animationTimer = null;
          }, 300);
        }
      });
    }
  }

  // --- Copy output text ---
  const copyOutputBtn = document.getElementById("copyOutputBtn");
  if (copyOutputBtn) {
    copyOutputBtn.addEventListener("click", async () => {
      const wordOutput = document.getElementById("wordOutput");
      if (!wordOutput) return;
      
      const clone = wordOutput.cloneNode(true);
      clone.querySelectorAll('.word-tooltip').forEach(tooltip => tooltip.remove());
      const words = clone.querySelectorAll('.word');
      words.forEach((word, index) => {
        if (index < words.length - 1) word.after(document.createTextNode(' '));
      });
      const htmlContent = clone.innerHTML;
      const plainText = Array.from(wordOutput.querySelectorAll('.word'))
        .map(span => span.getAttribute('data-word') || '')
        .filter(text => text)
        .join(' ');
      
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([htmlContent], { type: 'text/html' }),
            'text/plain': new Blob([plainText], { type: 'text/plain' })
          })
        ]);
        const originalText = copyOutputBtn.textContent;
        copyOutputBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyOutputBtn.textContent = originalText; }, 2000);
      } catch (err) {
        console.error('Copy failed:', err);
        alert('Failed to copy');
      }
    });
  }

  // --- Startup diagnostics ---
  if (!window.AudioContext && !window.webkitAudioContext) {
    status.textContent = "❌ Web Audio API not supported in this browser.";
    return;
  }
  if (window.location.protocol === "file:") {
    status.textContent = "❌ Must run from a server, not file://. In VS Code: right-click index.html → Open with Live Server.";
    status.classList.remove("flashing");
    return;
  }

  // --- File upload ---
  const fileInput = document.getElementById("wavFileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      status.textContent = "⏳ Loading audio...";
      try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === "suspended") await audioContext.resume();
        const arrayBuffer = await file.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        currentAudioFile = file;
        const duration = audioBuffer.duration;
        if (duration > 300 || duration <= 0) {
          status.textContent = duration > 300
            ? `❌ File too long: ${duration.toFixed(2)}s (max 5 min)`
            : "❌ Invalid audio duration.";
          audioBuffer = null; currentAudioFile = null; e.target.value = ""; return;
        }
        const durEl = document.getElementById("durationSec");
        if (durEl) durEl.value = duration.toFixed(2);
        status.textContent = `✅ Loaded: ${file.name} (${duration.toFixed(2)}s). Click Generate.`;
        status.classList.remove("flashing");
      } catch (err) {
        status.textContent = `❌ ${err.message || "Could not decode audio. Try a WAV or MP3."}`;
        audioBuffer = null; currentAudioFile = null; e.target.value = "";
      }
    });
  }

  // --- Generate ---
  const generateBtn = document.getElementById("generateBtn");
  if (generateBtn) generateBtn.addEventListener("click", runMachine);

  // --- Download CSV ---
  const downloadBtn = document.getElementById("downloadCsvBtn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const minDb = Number(document.getElementById("minDb").value);
      const maxDb = Number(document.getElementById("maxDb").value);
      const mode  = document.getElementById("mapMode")?.value || "neutral";
      if (!currentRows.length) { status.textContent = "Nothing to download — Generate first."; return; }
      downloadTextFile("tt2ww_data.csv", rowsToCsv(currentRows, minDb, maxDb, mode), "text/csv");
    });
  }

  // --- Scrub ---
  const scrub = document.getElementById("scrub");
  if (scrub) {
    scrub.addEventListener("input", (e) => {
      const t = Number(e.target.value);
      document.getElementById("scrubTime").textContent = `${t.toFixed(2)}s`;
      const db = getDbAtTime(t);
      document.getElementById("scrubDb").textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "— dB";
    });
  }

  // --- Auth ---
  if (supabase) {
    supabase.auth.getSession().then(({ data: { session } }) => {
      currentUser = session?.user || null;
      updateAuthUI();
    });
    supabase.auth.onAuthStateChange((event, session) => {
      currentUser = session?.user || null;
      updateAuthUI();
      if (event === "SIGNED_IN") status.textContent = `✅ Logged in as ${currentUser.email}`;
      if (event === "SIGNED_OUT") status.textContent = "Logged out.";
    });
    maybeLoadShared();
  }

  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      if (!supabase) return alert("Supabase not connected.");
      const email = document.getElementById("emailInput")?.value.trim();
      if (!email) return alert("Enter your email.");
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin }
      });
      if (error) return alert(error.message);
      alert("✅ Check your email for the magic link!");
    });
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    if (supabase) await supabase.auth.signOut();
  });

  const saveDraftBtn = document.getElementById("saveDraftBtn");
  if (saveDraftBtn) saveDraftBtn.addEventListener("click", () => saveCreation({ isPublic: false }));

  const publishBtn = document.getElementById("publishBtn");
  if (publishBtn) publishBtn.addEventListener("click", () => saveCreation({ isPublic: true }));

  const galleryBtn = document.getElementById("galleryBtn");
  if (galleryBtn) galleryBtn.addEventListener("click", showGallery);

  // =====================================================
  // --- Play Animation (Progressive Word Reveal) ---
  // =====================================================

  // Animation state is module-level (animRafId, animOffset, etc.)
  // Assign helper refs so runMachine can call them

  updatePlayButtonState = function () {
    const playBtn = document.getElementById("playAnimationBtn");
    const resetBtn = document.getElementById("resetAnimationBtn");
    if (!playBtn) return;
    const hasRows = currentRows.length > 0;
    playBtn.disabled = !hasRows;
    if (resetBtn) resetBtn.disabled = !hasRows;
  };

  function getWordElements() {
    return Array.from(document.querySelectorAll("#wordOutput .word"));
  }

  function hideAllWords() {
    getWordElements().forEach(el => {
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      el.style.transition = "none";
    });
  }

  function showAllWords() {
    getWordElements().forEach(el => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
      el.style.transition = "none";
    });
  }
  animShowAllFn = showAllWords;

  function revealWord(el) {
    // Force a reflow so the transition fires from the hidden state
    void el.offsetWidth;
    el.style.transition = "opacity 0.25s ease, transform 0.25s ease";
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  }

  function stopAnimation() {
    if (animRafId !== null) {
      cancelAnimationFrame(animRafId);
      animRafId = null;
    }
    animIsPlaying = false;
    const playBtn = document.getElementById("playAnimationBtn");
    if (playBtn) {
      playBtn.textContent = "▶ Play";
      playBtn.classList.remove("playing");
    }
  }
  animStopFn = stopAnimation;

  function resetAnimation() {
    stopAnimation();
    animOffset = 0;
    animNextWordIndex = 0;
    showAllWords();
  }

  function startAnimation() {
    if (!currentRows.length) return;

    const els = getWordElements();
    if (!els.length) return;

    animIsPlaying = true;
    const playBtn = document.getElementById("playAnimationBtn");
    if (playBtn) {
      playBtn.textContent = "⏸ Pause";
      playBtn.classList.add("playing");
    }

    // Hide words that haven't been revealed yet
    for (let i = animNextWordIndex; i < els.length; i++) {
      els[i].style.opacity = "0";
      els[i].style.transform = "translateY(4px)";
      els[i].style.transition = "none";
    }

    // Record start wall-clock time, accounting for any resume offset
    animStartTime = performance.now() - animOffset * 1000;

    function tick() {
      if (!animIsPlaying) return;

      const elapsed = (performance.now() - animStartTime) / 1000; // seconds

      // Reveal all words whose start time has passed
      while (animNextWordIndex < currentRows.length && currentRows[animNextWordIndex].start <= elapsed) {
        if (els[animNextWordIndex]) revealWord(els[animNextWordIndex]);
        animNextWordIndex++;
      }

      // Update scrub bar if it exists
      const scrubEl = document.getElementById("scrub");
      if (scrubEl) {
        scrubEl.value = Math.min(elapsed, parseFloat(scrubEl.max));
        const timeEl = document.getElementById("scrubTime");
        if (timeEl) timeEl.textContent = `${Math.min(elapsed, parseFloat(scrubEl.max)).toFixed(2)}s`;
        const dbVal = getDbAtTime(elapsed);
        const dbEl = document.getElementById("scrubDb");
        if (dbEl) dbEl.textContent = Number.isFinite(dbVal) ? `${dbVal.toFixed(1)} dB` : "— dB";
      }

      if (animNextWordIndex >= currentRows.length) {
        // All words revealed — animation complete
        stopAnimation();
        animOffset = 0;
        animNextWordIndex = 0;
        return;
      }

      animRafId = requestAnimationFrame(tick);
    }

    animRafId = requestAnimationFrame(tick);
  }

  function pauseAnimation() {
    // Save position so we can resume from here
    if (animStartTime !== null) {
      animOffset = (performance.now() - animStartTime) / 1000;
    }
    stopAnimation();
  }

  // Wire up buttons
  const playAnimationBtn = document.getElementById("playAnimationBtn");
  if (playAnimationBtn) {
    playAnimationBtn.addEventListener("click", () => {
      if (!currentRows.length) {
        status.textContent = "Generate output first to play animation.";
        return;
      }
      if (animIsPlaying) {
        pauseAnimation();
      } else {
        startAnimation();
      }
    });
  }

  const resetAnimationBtn = document.getElementById("resetAnimationBtn");
  if (resetAnimationBtn) {
    resetAnimationBtn.addEventListener("click", () => {
      resetAnimation();
    });
  }

  // Initial state
  status.textContent = "Upload an audio file to begin.";
  updatePlayButtonState();
});