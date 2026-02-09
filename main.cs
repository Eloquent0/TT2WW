// PRE-GENERATED TEST DATA
const testData = [
  { word: "This",    db: -30, start: 0.0,  end: 1.2 },
  { word: "is",      db: -35, start: 1.2,  end: 1.6 },
  { word: "a",       db: -40, start: 1.6,  end: 1.9 },
  { word: "machine", db: -10, start: 1.9,  end: 3.2 },
  { word: "test",    db: -15, start: 3.2,  end: 4.0 }
];

// MAP dB → FONT SIZE
function dbToFontSize(db) {
  const minDb = -40;
  const maxDb = -5;
  const minSize = 14;
  const maxSize = 120;

  const t = (db - minDb) / (maxDb - minDb);
  return Math.round(minSize + t * (maxSize - minSize));
}

// RENDER OUTPUT
document.getElementById("runTest").addEventListener("click", () => {
  const container = document.getElementById("output");
  container.innerHTML = "";

  testData.forEach(item => {
    const span = document.createElement("span");
    span.textContent = item.word + " ";
    span.style.fontSize = dbToFontSize(item.db) + "px";
    span.style.display = "inline-block";
    span.style.marginRight = "4px";

    container.appendChild(span);
  });
});