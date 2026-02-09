:root{
  --bg:#0b0f17;
  --card:#0f1623;
  --muted:#9aa7bd;
  --text:#e7eefc;
  --line:#233046;
  --accent:#7aa7ff;
  --accent2:#ffd27a;
  --shadow: 0 12px 40px rgba(0,0,0,0.35);
  --radius: 16px;
}

*{ box-sizing:border-box; }
body{
  margin:0;
  background: radial-gradient(1200px 600px at 20% -10%, rgba(122,167,255,0.25), transparent 60%),
              radial-gradient(900px 500px at 90% 10%, rgba(255,210,122,0.18), transparent 55%),
              var(--bg);
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
}

.app{
  max-width: 1100px;
  margin: 28px auto;
  padding: 0 16px 40px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:flex-end;
  gap:16px;
  margin-bottom:16px;
}

h1{
  margin:0;
  font-size: 28px;
  letter-spacing: -0.02em;
}
.sub{
  margin:6px 0 0;
  color: var(--muted);
  font-size: 14px;
}

.badge{
  padding:8px 10px;
  border:1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  background: rgba(255,255,255,0.03);
}

.grid{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap:16px;
  align-items:start;
}

@media (max-width: 900px){
  .grid{ grid-template-columns: 1fr; }
}

.card{
  background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px;
}

.card h2{
  margin:0 0 12px;
  font-size: 15px;
  letter-spacing: 0.02em;
  color: #cfe0ff;
  text-transform: uppercase;
}

.label{
  display:block;
  font-size: 12px;
  color: var(--muted);
  margin: 10px 0 6px;
}

.textarea, .input{
  width: 100%;
  border: 1px solid var(--line);
  background: rgba(0,0,0,0.22);
  color: var(--text);
  border-radius: 12px;
  padding: 10px 12px;
  outline: none;
}

.textarea:focus, .input:focus{
  border-color: rgba(122,167,255,0.8);
  box-shadow: 0 0 0 3px rgba(122,167,255,0.18);
}

.row{
  display:grid;
  gap:10px;
  margin-top: 10px;
}
.row3{ grid-template-columns: repeat(3, 1fr); }
.row2{ grid-template-columns: repeat(2, 1fr); }

.field{ min-width:0; }

.actions{
  margin-top: 14px;
}

.btn{
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.04);
  color: var(--text);
  border-radius: 12px;
  padding: 10px 12px;
  cursor:pointer;
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}

.btn:hover{ transform: translateY(-1px); border-color: rgba(122,167,255,0.55); }
.btn:active{ transform: translateY(0px); }

.btn.primary{
  border-color: rgba(122,167,255,0.55);
  background: rgba(122,167,255,0.18);
}

.btn.ghost{
  background: transparent;
  color: var(--muted);
}

.status{
  margin:10px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.output{
  border: 1px dashed rgba(122,167,255,0.35);
  background: rgba(0,0,0,0.18);
  border-radius: 12px;
  padding: 14px;
  min-height: 200px;
  line-height: 1.15;
  overflow-wrap:anywhere;
}

.word {
  display: inline-block;
  margin-right: 6px;
  margin-bottom: 6px;
  padding: 2px 2px;
  border-radius: 6px;
}

.word:hover{
  outline: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
}

.timeline{
  margin-top: 14px;
  border-top: 1px solid rgba(35,48,70,0.8);
  padding-top: 12px;
}
.timeline input[type="range"]{ width: 100%; }
.timelineMeta{
  display:flex;
  justify-content:space-between;
  color: var(--muted);
  font-size: 12px;
  margin-top: 6px;
}

.tableWrap{
  overflow:auto;
  border-radius: 12px;
  border: 1px solid var(--line);
}
.table{
  width:100%;
  border-collapse: collapse;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}
.table th, .table td{
  padding: 8px 10px;
  border-bottom: 1px solid rgba(35,48,70,0.7);
  white-space: nowrap;
}
.table th{
  text-align:left;
  color:#cfe0ff;
  background: rgba(0,0,0,0.18);
}