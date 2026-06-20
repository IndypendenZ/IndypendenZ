const state = { metric: "z", data: null, chart: null };
const $ = (s) => document.querySelector(s);

const AMBER = "#e0a93c";
function mvrvZone(v) {
  if (v < 1) return { label: "ต่ำกว่ามูลค่าจริง · โซนสะสม (จุดต่ำสุดของรอบ)", color: "var(--green)" };
  if (v < 2.4) return { label: "ปกติ", color: "var(--ink)" };
  if (v < 3.7) return { label: "เริ่มแพง · ตลาดร้อนขึ้น", color: AMBER };
  return { label: "แพงมาก · ระวังจุดสูงสุด", color: "var(--red)" };
}
function zZone(v) {
  if (v < 0.1) return { label: "โซนจุดต่ำสุด · โอกาสสะสมในอดีต", color: "var(--green)" };
  if (v < 2) return { label: "ปกติ–ถูก", color: "var(--ink)" };
  if (v < 7) return { label: "แพงขึ้น", color: AMBER };
  return { label: "โซนฟอง · ใกล้จุดสูงสุดในอดีต", color: "var(--red)" };
}

async function load() {
  $("#statusbar").textContent = "กำลังโหลดข้อมูล…";
  try {
    const r = await fetch("/api/mvrv");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    state.data = await r.json();
    render();
  } catch (e) {
    $("#statusbar").innerHTML = `<span style="color:var(--red)">โหลดไม่สำเร็จ: ${e.message}</span> — ต้องเข้าถึง bitcoin-data.com (ปกติบนเครื่องตัวเองได้)`;
  }
}

function render() {
  const d = state.data;
  const c = d.current;

  // Z-Score (มีเสมอ)
  const zz = zZone(c.z);
  $("#z-val").textContent = c.z.toFixed(2);
  $("#z-val").style.color = zz.color;
  $("#z-zone").textContent = zz.label;

  // MVRV ratio (ถ้ามี)
  if (d.hasRatio && c.mvrv != null) {
    const mz = mvrvZone(c.mvrv);
    $("#mvrv-val").textContent = c.mvrv.toFixed(2);
    $("#mvrv-val").style.color = mz.color;
    $("#mvrv-zone").textContent = mz.label;
  } else {
    $("#mvrv-val").textContent = "—";
    $("#mvrv-zone").textContent = "ไม่มีข้อมูลฟรี (ใช้ Z-Score แทน)";
    // ซ่อนปุ่ม MVRV ratio ถ้าไม่มีข้อมูล
    const btn = document.querySelector('#metric-seg button[data-metric="mvrv"]');
    if (btn) btn.style.display = "none";
    state.metric = "z";
    document.querySelector('#metric-seg button[data-metric="z"]')?.classList.add("active");
  }

  // ช่วง Z ในอดีต
  const zs = d.series.map((p) => p.z);
  $("#z-range").textContent = `${Math.min(...zs).toFixed(1)} … ${Math.max(...zs).toFixed(1)}`;

  $("#statusbar").innerHTML =
    `<span style="color:var(--green)">●</span> อัปเดตล่าสุด ${c.t}` +
    `<span class="sep">|</span> BTC` +
    `<span class="sep">|</span> ${d.series.length.toLocaleString()} วัน`;
  $("#clock").textContent = c.t;

  renderChart();
}

function renderChart() {
  const d = state.data;
  const m = d.hasRatio ? state.metric : "z";
  const pts = d.series.filter((p) => p[m] != null);
  const labels = pts.map((p) => p.t);
  const values = pts.map((p) => p[m]);
  const refs = m === "mvrv" ? [1, 3.7] : [0, 7];

  if (state.chart) state.chart.destroy();
  const ctx = $("#chart").getContext("2d");
  const datasets = [
    {
      label: m === "mvrv" ? "MVRV" : "MVRV Z-Score",
      data: values,
      borderColor: "#e2683f",
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.1,
    },
    ...refs.map((y, i) => ({
      label: `เกณฑ์ ${y}`,
      data: values.map(() => y),
      borderColor: i === 0 ? "#35c184" : "#ef5b52",
      borderWidth: 1,
      borderDash: [6, 5],
      pointRadius: 0,
    })),
  ];

  state.chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { labels: { color: "#aeb6c2", boxWidth: 14 } },
        tooltip: { callbacks: { title: (t) => t[0].label } },
      },
      scales: {
        x: { ticks: { color: "#727c8b", maxTicksLimit: 8 }, grid: { display: false } },
        y: { ticks: { color: "#727c8b" }, grid: { color: "#262d39" } },
      },
    },
  });

  $("#chart-note").innerHTML =
    m === "mvrv"
      ? `เส้นประ <b class="g">เขียว = 1.0</b> (จุดคุ้มทุน) · <b class="r">แดง = 3.7</b> (โซนแพงมาก)`
      : `เส้นประ <b class="g">เขียว = 0</b> (โซนจุดต่ำสุด) · <b class="r">แดง = 7</b> (โซนฟอง)`;
}

document.querySelectorAll("#metric-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#metric-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.metric = b.dataset.metric;
    if (state.data) renderChart();
  })
);

load();
