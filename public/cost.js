const state = { tf: 0, gran: "month", data: null, chart: null };
const $ = (s) => document.querySelector(s);

// ---- format ----
function fmtK(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  if (a >= 1) return "$" + v.toFixed(0);
  return "$" + v.toFixed(2);
}
function fmtHash(ths) {
  if (ths == null) return "—";
  if (ths >= 1e9) return (ths / 1e9).toFixed(2) + " ZH/s";
  if (ths >= 1e6) return (ths / 1e6).toFixed(2) + " EH/s";
  if (ths >= 1e3) return (ths / 1e3).toFixed(2) + " PH/s";
  return ths.toFixed(0) + " TH/s";
}
const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(0) + "%";

async function load() {
  $("#statusbar").textContent = "กำลังโหลดข้อมูล…";
  try {
    const r = await fetch("/api/btc-cost");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    state.data = await r.json();
    renderStats();
    renderChart();
  } catch (e) {
    $("#statusbar").innerHTML = `<span style="color:var(--red)">โหลดไม่สำเร็จ: ${e.message}</span> — หน้านี้ต้องเข้าถึง blockchain.info (ปกติบนเครื่องตัวเองได้)`;
  }
}

function renderStats() {
  const c = state.data.current;
  const a = state.data.assumptions;
  const inRange = c.price >= c.low && c.price <= c.high;

  $("#cost-headline").innerHTML = `ราคา <b style="color:var(--terra)">${fmtK(c.price)}</b> ${
    c.price < c.low
      ? 'ต่ำกว่าต้นทุน best case <b class="r">(นักขุดขาดทุนแน่นอน)</b>'
      : c.price > c.high
      ? 'สูงกว่าช่วงต้นทุนทั้งหมด <b class="g">(นักขุดกำไรหนา)</b>'
      : `อยู่ในช่วงต้นทุน <b style="color:var(--terra)">${fmtK(c.low)}–${fmtK(c.high)}</b>`
  } — กำไร/ขาดทุนขึ้นกับต้นทุนจริงของแต่ละราย`;
  $("#cost-sub").innerHTML = `margin จากต้นทุนกลาง <b class="${c.marginMid >= 0 ? "g" : "r"}">${pct(
    c.marginMid
  )}</b> · บางราย (ไฟถูก/เครื่องใหม่) กำไร, บางราย (ไฟแพง/เครื่องเก่า) ขาดทุน · สมมติฐานปัจจุบัน เครื่องดี ~${a.goodJTH} J/TH, เฉลี่ยเครือข่าย ~${a.netJTH} J/TH`;

  $("#mid-val").textContent = fmtK(c.mid);
  $("#mid-sub").textContent = `ค่ากลาง · เครื่องดี + ไฟ $${a.elecMid}/kWh`;
  $("#price-val").textContent = fmtK(c.price);
  $("#price-sub").textContent = c.t;
  $("#range-val").textContent = `${fmtK(c.low)} – ${fmtK(c.high)}`;
  $("#range-sub").textContent = `best (เครื่องดี+ไฟ $${a.elecLow}) → worst (เฉลี่ยเครือข่าย+ไฟ $${a.elecHigh})`;
  $("#hash-val").textContent = fmtHash(c.hash);
  $("#hash-sub").textContent = `block reward ${c.reward} BTC`;

  $("#clock").textContent = c.t;
  $("#statusbar").innerHTML =
    `<span style="color:var(--green)">●</span> อัปเดตล่าสุด ${c.t}` +
    `<span class="sep">|</span> BTC` +
    `<span class="sep">|</span> ${state.data.series.length.toLocaleString()} วัน`;
}

// กรองช่วงเวลา + ลดความถี่ (รายเดือน/รายวัน)
function buildView() {
  let s = state.data.series;
  if (state.tf > 0) {
    const last = new Date(s[s.length - 1].t);
    const cs = new Date(last.getTime() - state.tf * 86400000).toISOString().slice(0, 10);
    s = s.filter((p) => p.t >= cs);
  }
  if (state.gran === "month") {
    const byM = new Map();
    for (const p of s) byM.set(p.t.slice(0, 7), p); // เก็บจุดสุดท้ายของเดือน
    return [...byM.values()];
  }
  return s;
}

// เส้น halving แนวตั้ง
const halvingPlugin = {
  id: "halv",
  afterDraw(chart) {
    if (!state.data) return;
    const {
      ctx,
      chartArea: { top, bottom },
      scales: { x },
    } = chart;
    const labels = chart.data.labels;
    if (!labels.length) return;
    for (const hd of state.data.halvings) {
      if (hd < labels[0] || hd > labels[labels.length - 1]) continue;
      let idx = labels.findIndex((l) => l >= hd);
      if (idx < 0) continue;
      const xPos = x.getPixelForValue(idx);
      ctx.save();
      ctx.strokeStyle = "rgba(107,120,224,0.75)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(xPos, top);
      ctx.lineTo(xPos, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(130,142,240,0.95)";
      ctx.font = "10px 'Space Mono', monospace";
      ctx.fillText("Halving", xPos + 3, top + 11);
      ctx.restore();
    }
  },
};

function renderChart() {
  const pts = buildView();
  const labels = pts.map((p) => p.t);
  const CLAY = "#c9763f";
  const CLAY_FILL = "rgba(201,118,63,0.22)";

  if (state.chart) state.chart.destroy();
  const ctx = $("#chart").getContext("2d");

  const datasets = [
    // ขอบบนของแถบ (worst) — ช่วยให้ fill ทำงาน ซ่อนจาก legend
    {
      label: "_high",
      data: pts.map((p) => p.high),
      borderColor: "rgba(201,118,63,0.45)",
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
      spanGaps: true,
    },
    // ขอบล่าง (best) เติมสีถึงขอบบน = แถบช่วงต้นทุน
    {
      label: "ช่วงต้นทุน (best–worst)",
      data: pts.map((p) => p.low),
      borderColor: "rgba(201,118,63,0.45)",
      backgroundColor: CLAY_FILL,
      borderWidth: 1,
      pointRadius: 0,
      fill: "-1",
      spanGaps: true,
    },
    // ต้นทุนกลาง
    {
      label: "ต้นทุนกลาง",
      data: pts.map((p) => p.mid),
      borderColor: CLAY,
      borderWidth: 1.4,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      spanGaps: true,
    },
    // ราคาตลาด (บนสุด)
    {
      label: "ราคา BTC",
      data: pts.map((p) => p.price),
      borderColor: "#e8e6e1",
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.1,
      spanGaps: true,
    },
    // จุดขาดทุน (ราคาต่ำกว่าต้นทุน best case)
    {
      label: "ขาดทุนแน่นอน",
      data: pts.map((p) => (p.price != null && p.low != null && p.price < p.low ? p.price : null)),
      borderColor: "transparent",
      backgroundColor: "rgba(224,71,59,0.9)",
      pointRadius: 2.4,
      showLine: false,
    },
  ];

  state.chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    plugins: [halvingPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          labels: {
            color: "#aeb6c2",
            boxWidth: 14,
            filter: (it) => it.text !== "_high",
          },
        },
        tooltip: {
          callbacks: {
            title: (t) => t[0].label,
            label: (it) => {
              if (it.dataset.label === "_high") return "ต้นทุน worst: " + fmtK(it.raw);
              if (it.raw == null) return null;
              return it.dataset.label + ": " + fmtK(it.raw);
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#727c8b", maxTicksLimit: 11 }, grid: { color: "#1d232e" } },
        y: {
          type: "logarithmic",
          ticks: {
            color: "#727c8b",
            callback: (v) => {
              const ok = [0.1, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000];
              return ok.includes(v) ? fmtK(v) : "";
            },
          },
          grid: { color: "#1d232e" },
        },
      },
    },
  });

  $("#chart-note").innerHTML =
    `เส้นขาว = ราคาตลาด · <b style="color:${CLAY}">แถบส้ม</b> = ช่วงต้นทุนการผลิต (best–worst) · ` +
    `<b style="color:${CLAY}">เส้นประ</b> = ต้นทุนกลาง · <b style="color:#828ef0">เส้นน้ำเงิน</b> = Halving · ` +
    `<b class="r">จุดแดง</b> = ราคาต่ำกว่าต้นทุน best case · log scale · เป็นค่าประมาณการ`;
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
