// =============================
// Mock Speech → dB → Typography Machine
// =============================

// ---------- Utilities ----------
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Map dB range → font size
function dbToFontPx(db, minDb, maxDb, minPx = 14, maxPx = 120) {
  if (maxDb === minDb) return minPx;
  const t = (db - minDb) / (maxDb - minDb);
  return Math.round(lerp(minPx, maxPx, clamp(t, 0, 1)));
}

// ---------- Tokenization ----------
function tokenize(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ---------- Mock timestamps ----------
function makeTimestamps(words, durationSec) {
  const n = words.length;
  if (n === 0) return [];

  const base = durationSec / n;
  let t = 0;

  return words.map((w, i) => {
    const jitter = (Math.random() - 0.5) * base * 0.4;
    const dur = Math.max(0.12, base + jitter);

    const pause =
      i % (6 + Math.floor(Math.random() * 5)) === 0 && i !== 0
        ? 0.2 + Math.random() * 0.6
        : 0;

    const start = t;
    const end = Math.min(durationSec, t + dur);
    t = end + pause;

    return { word: w, start, end };
  }).map((o, i, arr) => {
    if (i === arr.length - 1) o.end = durationSec;
    return o;
  });
}

// ---------- Mock dB per word ----------
function makeDbValues(items, minDb, maxDb) {
  let prev = lerp(minDb, maxDb, 0.5);

  return items.map(it => {
    const target = lerp(minDb, maxDb, Math.random());
    const db = clamp(prev * 0.7 + target * 0.3, minDb, maxDb);
    prev = db;
    return { ...it, db };
  });
}

// ---------- Render ----------
function renderWords(rows, minDb, maxDb) {
  const container = document.getElementById("wordOutput");
  container.innerHTML = "";

  rows.forEach(r => {
    const span = document.createElement("span");
    const size = dbToFontPx(r.db, minDb, maxDb);

    span.textContent = r.word + " ";
    span.style.fontSize = `${size}px`;
    span.style.lineHeight = "1.1";
    span.style.display = "inline-block";

    container.appendChild(span);
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
      <td>${r.word}</td>
      <td>${r.start.toFixed(2)}</td>
      <td>${r.end.toFixed(2)}</td>
      <td>${r.db.toFixed(1)}</td>
      <td>${size}</td>
    `;

    tbody.appendChild(tr);
  });
}

// ---------- Main ----------
document.getElementById("generateBtn").addEventListener("click", () => {
  const text = document.getElementById("textInput").value;
  const durationSec = Number(document.getElementById("durationSec").value);
  const minDb = Number(document.getElementById("minDb").value);
  const maxDb = Number(document.getElementById("maxDb").value);

  const words = tokenize(text);
  const timestamps = makeTimestamps(words, durationSec);
  const withDb = makeDbValues(timestamps, minDb, maxDb);

  renderWords(withDb, minDb, maxDb);
  renderTable(withDb, minDb, maxDb);
});