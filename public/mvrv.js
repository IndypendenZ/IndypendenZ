const state = { tf: 0, gran: "month", data: null, chart: null };
const $ = (s) => document.querySelector(s);

const AMBER = "#e0a93c";
function zZone(v) {
  if (v < 0.1) return { label: "โซนจุดต่ำสุด · โอกาสสะสมในอดีต", color: "var(--green)" };
  if (v < 2) return { label: "ปกติ–ถูก", color: "var(--ink)" };
  if (v < 7) return { label: "แพงขึ้น", color: AMBER };
  return { label: "โซนฟอง · ใกล้จุดสูงสุดในอดีต", color: "var(--red)" };
}
function mvrvZone(v) {
  if (v < 1) return { label: "ต่ำกว่ามูลค่าจริง · โซนสะสม", color: "var(--green)" };
  if (v < 2.4) return { label: "ปกติ", color: "var(--ink)" };
  if (v < 3.7) return { label: "เริ่มแพง", color: AMBER };
  return { label: "แพงมาก · ระวังจุดสูงสุด", color: "var(--red)" };
}

async function load() {
  $("#statusbar").textContent = "กำลังโหลดข้อมูล…";
  try {
    const r = await fetch("/api/mvrv");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    state.data = await r.json();
    renderStats();
    renderChart();
  } catch (e) {
    $("#statusbar").innerHTML = `<span style="color:var(--red)">โหลดไม่สำเร็จ: ${e.message}</span> — ต้องเข้าถึง bitcoin-data.com / coingecko (ปกติบนเครื่องตัวเองได้)`;
  }
}

function renderStats() {
  const d = state.data;
  const c = d.current;
  const zz = zZone(c.z);
  $("#z-val").textContent = c.z.toFixed(2);
  $("#z-val").style.color = zz.color;
  $("#z-zone").textContent = zz.label;

  if (d.hasRatio && c.mvrv != null) {
    const mz = mvrvZone(c.mvrv);
    $("#mvrv-val").textContent = c.mvrv.toFixed(2);
    $("#mvrv-val").style.color = mz.color;
    $("#mvrv-zone").textContent = mz.label;
  } else {
    $("#mvrv-val").textContent = "—";
    $("#mvrv-zone").textContent = "ไม่มีข้อมูลฟรี (ใช้ Z-Score)";
  }

  const zs = d.series.map((p) => p.z);
  $("#z-range").textContent = `${Math.min(...zs).toFixed(1)} … ${Math.max(...zs).toFixed(1)}`;

  $("#statusbar").innerHTML =
    `<span style="color:var(--green)">●</span> อัปเดตล่าสุด ${c.t}` +
    `<span class="sep">|</span> BTC` +
    `<span class="sep">|</span> ${d.series.length.toLocaleString()} วัน`;
  $("#clock").textContent = c.t;
}

// กรองช่วงเวลา + ลดความถี่ (รายเดือน/รายวัน) + คำนวณจุดสัญญาณ
function buildView() {
  const d = state.data;
  let s = d.series;
  if (state.tf > 0) {
    const last = new Date(s[s.length - 1].t);
    const cut = new Date(last.getTime() - state.tf * 86400000);
    const cs = cut.toISOString().slice(0, 10);
    s = s.filter((p) => p.t >= cs);
  }
  // ลดความถี่
  let pts;
  if (state.gran === "month") {
    const byM = new Map();
    for (const p of s) byM.set(p.t.slice(0, 7), p); // เก็บจุดสุดท้ายของเดือน
    pts = [...byM.values()];
  } else {
    pts = s;
  }
  // จุดสัญญาณ: รายเดือน = ทุกจุดที่อยู่ในโซน · รายวัน = เฉพาะตอนเปลี่ยนโซน
  let prev = null;
  for (const p of pts) {
    const z = p.zone;
    if (z === "NORMAL" || p.price == null) {
      p.mark = null;
    } else if (state.gran === "month") {
      p.mark = z;
    } else {
      p.mark = z !== prev ? z : null;
    }
    prev = z;
  }
  return pts;
}

function renderChart() {
  const d = state.data;
  const pts = buildView();
  const labels = pts.map((p) => p.t);
  const useRatio = d.hasRatio;
  const mvrvVals = pts.map((p) => (useRatio ? p.mvrv : p.z));
  const refs = useRatio ? [1, 3] : [0, 7];

  const markData = (type) =>
    pts.map((p) => (p.mark === type && p.price != null ? p.price : null));

  if (state.chart) state.chart.destroy();
  const ctx = $("#chart").getContext("2d");

  const datasets = [
    {
      label: "ราคา BTC",
      data: pts.map((p) => p.price),
      borderColor: "#e2683f",
      borderWidth: 2,
      pointRadius: 0,
      yAxisID: "yPrice",
      tension: 0.15,
      spanGaps: true,
    },
  ];
  if (d.hasRealized) {
    datasets.push({
      label: "Realized Price",
      data: pts.map((p) => p.realized),
      borderColor: "#8a93a3",
      borderWidth: 1.2,
      borderDash: [5, 4],
      pointRadius: 0,
      yAxisID: "yPrice",
      spanGaps: true,
    });
  }
  datasets.push({
    label: useRatio ? "MVRV" : "MVRV Z-Score",
    data: mvrvVals,
    borderColor: "#caa05a",
    borderWidth: 1.2,
    pointRadius: 0,
    yAxisID: "yMvrv",
    tension: 0.15,
    spanGaps: true,
  });
  // เส้นเกณฑ์โซน
  datasets.push(
    {
      label: useRatio ? "Fair Value 1.0" : "Z = 0",
      data: labels.map(() => refs[0]),
      borderColor: "rgba(53,193,132,0.55)",
      borderWidth: 1,
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: "yMvrv",
    },
    {
      label: useRatio ? "Euphoria 3.0" : "Z = 7",
      data: labels.map(() => refs[1]),
      borderColor: "rgba(239,91,82,0.55)",
      borderWidth: 1,
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: "yMvrv",
    }
  );
  // สัญญาณ
  datasets.push(
    {
      label: "BUY",
      data: markData("BUY"),
      yAxisID: "yPrice",
      showLine: false,
      pointStyle: "triangle",
      pointRadius: 8,
      pointBackgroundColor: "#2e9e5b",
      pointBorderColor: "#2e9e5b",
    },
    {
      label: "SELL",
      data: markData("SELL"),
      yAxisID: "yPrice",
      showLine: false,
      pointStyle: "rectRot",
      pointRadius: 7,
      pointBackgroundColor: "#d4a017",
      pointBorderColor: "#d4a017",
    },
    {
      label: "STRONG SELL",
      data: markData("STRONG_SELL"),
      yAxisID: "yPrice",
      showLine: false,
      pointStyle: "rectRot",
      pointRadius: 8,
      pointBackgroundColor: "#e0473b",
      pointBorderColor: "#e0473b",
    }
  );

  state.chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          labels: {
            color: "#aeb6c2",
            boxWidth: 14,
            // ซ่อนเส้นเกณฑ์ออกจาก legend
            filter: (it) => !/^(Fair Value|Euphoria|Z =)/.test(it.text),
          },
        },
        tooltip: { callbacks: { title: (t) => t[0].label } },
      },
      scales: {
        x: { ticks: { color: "#727c8b", maxTicksLimit: 10 }, grid: { color: "#1d232e" } },
        yPrice: {
          position: "left",
          ticks: {
            color: "#727c8b",
            callback: (v) => (v >= 1000 ? "$" + v / 1000 + "K" : "$" + v),
          },
          grid: { color: "#1d232e" },
        },
        yMvrv: {
          position: "right",
          min: 0,
          max: useRatio ? 6 : undefined,
          ticks: { color: "#caa05a" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });

  $("#chart-note").innerHTML =
    `🟢 <b class="g">BUY</b> = MVRV ต่ำ (ถูก) · 🟡 <b style="color:${AMBER}">SELL</b> = เริ่มแพง · 🔴 <b class="r">STRONG SELL</b> = แพงมาก (Euphoria) · ` +
    (useRatio
      ? `เส้นเกณฑ์ Fair Value 1.0 / Euphoria 3.0`
      : `ใช้ MVRV Z-Score (เกณฑ์ 0 / 7) เพราะไม่มี MVRV ratio ฟรี`);
}

document.querySelectorAll("#tf-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tf-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.tf = Number(b.dataset.tf);
    if (state.data) renderChart();
  })
);
document.querySelectorAll("#gran-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#gran-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.gran = b.dataset.gran;
    if (state.data) renderChart();
  })
);

load();
