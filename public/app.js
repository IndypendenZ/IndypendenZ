// ===== สถานะ =====
const state = {
  vs: "usd",
  tab: "all",
  search: "",
  coins: [],
  watch: new Set(JSON.parse(localStorage.getItem("watch") || "[]")),
  aiEnabled: false,
  current: null, // เหรียญที่เปิดในโมดัล
  chart: null,
};

const $ = (sel) => document.querySelector(sel);
const body = $("#market-body");

// ===== ฟอร์แมตตัวเลข =====
function fmtPrice(v) {
  if (v == null) return "—";
  const sym = state.vs === "thb" ? "฿" : "$";
  const digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 8;
  return sym + Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });
}
function fmtBig(v) {
  if (v == null) return "—";
  const sym = state.vs === "thb" ? "฿" : "$";
  const abs = Math.abs(v);
  if (abs >= 1e12) return sym + (v / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return sym + (v / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sym + (v / 1e6).toFixed(2) + "M";
  return sym + Number(v).toLocaleString("en-US");
}
function pct(v) {
  if (v == null) return `<span class="muted">—</span>`;
  const cls = v >= 0 ? "pos" : "neg";
  const arrow = v >= 0 ? "▲" : "▼";
  return `<span class="${cls}">${arrow} ${Math.abs(v).toFixed(2)}%</span>`;
}

// ===== sparkline เป็น SVG เล็กๆ (เบากว่าสร้างกราฟ 50 อัน) =====
function sparkline(prices, up) {
  if (!prices || prices.length < 2) return "";
  const w = 120,
    h = 34,
    pad = 2;
  const min = Math.min(...prices),
    max = Math.max(...prices);
  const range = max - min || 1;
  const step = (w - pad * 2) / (prices.length - 1);
  const pts = prices
    .map((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const color = up ? "#16c784" : "#ea3943";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

// ===== โหลดราคา =====
async function loadMarkets() {
  setStatus("กำลังโหลดข้อมูล…");
  try {
    const r = await fetch(`/api/markets?vs=${state.vs}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    state.coins = await r.json();
    setStatus(`อัปเดตล่าสุด ${new Date().toLocaleTimeString("th-TH")} · ${state.coins.length} เหรียญ`);
    render();
  } catch (e) {
    setStatus("โหลดข้อมูลไม่สำเร็จ: " + e.message, true);
  }
}

function setStatus(msg, isError = false) {
  const el = $("#status-bar");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// ===== กรองตามแท็บ/ค้นหา =====
function visibleCoins() {
  let list = [...state.coins];
  if (state.tab === "watch") list = list.filter((c) => state.watch.has(c.id));
  if (state.tab === "gainers")
    list = list
      .filter((c) => c.price_change_percentage_24h_in_currency != null)
      .sort(
        (a, b) =>
          b.price_change_percentage_24h_in_currency -
          a.price_change_percentage_24h_in_currency
      )
      .slice(0, 15);
  if (state.tab === "losers")
    list = list
      .filter((c) => c.price_change_percentage_24h_in_currency != null)
      .sort(
        (a, b) =>
          a.price_change_percentage_24h_in_currency -
          b.price_change_percentage_24h_in_currency
      )
      .slice(0, 15);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)
    );
  }
  return list;
}

// ===== วาดตาราง =====
function render() {
  const list = visibleCoins();
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="10" class="loading">${
      state.tab === "watch" ? "ยังไม่มีเหรียญในรายการติดตาม — กดดาว ⭐ เพื่อเพิ่ม" : "ไม่พบเหรียญ"
    }</td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((c) => {
      const up7 = (c.price_change_percentage_7d_in_currency ?? 0) >= 0;
      const starred = state.watch.has(c.id);
      return `
      <tr data-id="${c.id}">
        <td class="star-col"><span class="star ${starred ? "on" : ""}" data-star="${c.id}">${
        starred ? "★" : "☆"
      }</span></td>
        <td class="rank-col muted">${c.market_cap_rank ?? "—"}</td>
        <td>
          <div class="coin-cell">
            <img src="${c.image}" alt="" loading="lazy"/>
            <div>
              <div class="coin-name">${c.name}</div>
              <div class="coin-symbol">${c.symbol}</div>
            </div>
          </div>
        </td>
        <td class="num">${fmtPrice(c.current_price)}</td>
        <td class="num">${pct(c.price_change_percentage_1h_in_currency)}</td>
        <td class="num">${pct(c.price_change_percentage_24h_in_currency)}</td>
        <td class="num">${pct(c.price_change_percentage_7d_in_currency)}</td>
        <td class="num hide-sm">${fmtBig(c.total_volume)}</td>
        <td class="num hide-sm">${fmtBig(c.market_cap)}</td>
        <td class="spark-col hide-sm">${sparkline(c.sparkline_in_7d?.price, up7)}</td>
      </tr>`;
    })
    .join("");
}

// ===== คลิกตาราง: ดาว หรือ เปิดโมดัล =====
body.addEventListener("click", (e) => {
  const starEl = e.target.closest("[data-star]");
  if (starEl) {
    const id = starEl.dataset.star;
    state.watch.has(id) ? state.watch.delete(id) : state.watch.add(id);
    localStorage.setItem("watch", JSON.stringify([...state.watch]));
    render();
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openModal(row.dataset.id);
});

// ===== โมดัลรายละเอียด =====
async function openModal(id) {
  const c = state.coins.find((x) => x.id === id);
  if (!c) return;
  state.current = c;
  $("#m-img").src = c.image;
  $("#m-name").textContent = `${c.name} (${c.symbol.toUpperCase()})`;
  $("#m-rank").textContent = c.market_cap_rank ? `อันดับ #${c.market_cap_rank}` : "";
  $("#m-price").textContent = fmtPrice(c.current_price);
  const ch = c.price_change_percentage_24h_in_currency;
  const chEl = $("#m-change");
  chEl.innerHTML = pct(ch) + " <span class='muted'>(24ชม)</span>";
  $("#ai-output").textContent =
    'กดปุ่ม "วิเคราะห์เหรียญนี้" เพื่อให้ AI สรุปข้อมูลตลาดล่าสุดให้';
  $("#ai-output").classList.add("muted");
  $("#modal").classList.remove("hidden");
  // reset range เป็น 7 วัน
  document
    .querySelectorAll("#range button")
    .forEach((b) => b.classList.toggle("active", b.dataset.days === "7"));
  loadChart(id, 7);
}

function closeModal() {
  $("#modal").classList.add("hidden");
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

// ===== กราฟราคา =====
async function loadChart(id, days) {
  try {
    const r = await fetch(`/api/coin/${id}/chart?vs=${state.vs}&days=${days}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const data = await r.json();
    const prices = data.prices || [];
    const labels = prices.map(([t]) =>
      new Date(t).toLocaleString("th-TH", {
        day: days > 1 ? "numeric" : undefined,
        month: days > 1 ? "short" : undefined,
        hour: "2-digit",
        minute: "2-digit",
      })
    );
    const values = prices.map(([, p]) => p);
    const up = values.length > 1 && values[values.length - 1] >= values[0];

    if (state.chart) state.chart.destroy();
    const ctx = $("#chart").getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 0, 260);
    const line = up ? "#16c784" : "#ea3943";
    grad.addColorStop(0, up ? "rgba(22,199,132,0.25)" : "rgba(234,57,67,0.25)");
    grad.addColorStop(1, "rgba(0,0,0,0)");

    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: line,
            backgroundColor: grad,
            fill: true,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#8b93a7", maxTicksLimit: 6 }, grid: { display: false } },
          y: {
            ticks: {
              color: "#8b93a7",
              callback: (v) => fmtPrice(v),
            },
            grid: { color: "#232a3a" },
          },
        },
      },
    });
  } catch (e) {
    console.error(e);
  }
}

document.querySelectorAll("#range button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#range button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    if (state.current) loadChart(state.current.id, Number(b.dataset.days));
  })
);

// ===== AI วิเคราะห์ (streaming) =====
$("#analyze-btn").addEventListener("click", async () => {
  if (!state.current) return;
  if (!state.aiEnabled) {
    $("#ai-output").classList.remove("muted");
    $("#ai-output").textContent =
      "⚠️ ยังเปิดใช้ AI ไม่ได้ — ต้องตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ก่อน (ดูวิธีใน README)";
    return;
  }
  const btn = $("#analyze-btn");
  const out = $("#ai-output");
  btn.disabled = true;
  btn.textContent = "กำลังวิเคราะห์…";
  out.classList.remove("muted");
  out.textContent = "";

  try {
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coin: state.current, vs: state.vs }),
    });
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || r.statusText);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.textContent += dec.decode(value, { stream: true });
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    out.textContent = "เกิดข้อผิดพลาด: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "วิเคราะห์อีกครั้ง";
  }
});

// ===== คอนโทรลด้านบน =====
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  render();
});
$("#refresh").addEventListener("click", loadMarkets);
document.querySelectorAll("#currency button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#currency button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.vs = b.dataset.vs;
    loadMarkets();
  })
);
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.tab = b.dataset.tab;
    render();
  })
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ===== เริ่มทำงาน =====
async function init() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    state.aiEnabled = s.aiEnabled;
  } catch {}
  await loadMarkets();
  // รีเฟรชอัตโนมัติทุก 60 วิ
  setInterval(loadMarkets, 60_000);
}
init();
