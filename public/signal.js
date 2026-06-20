const state = {
  coins: [],
  bySym: {},
  ws: null,
  fav: new Set(JSON.parse(localStorage.getItem("sig_fav") || "[]")),
  watch: new Set(JSON.parse(localStorage.getItem("sig_watch") || "[]")),
  sortBy: localStorage.getItem("sig_sort") || "signal",
};

function saveSets() {
  localStorage.setItem("sig_fav", JSON.stringify([...state.fav]));
  localStorage.setItem("sig_watch", JSON.stringify([...state.watch]));
}

const $ = (s, r = document) => r.querySelector(s);

// ---- format ----
const fmtUSD = (v) => {
  if (v == null) return "—";
  const d = v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
};
const fmtBig = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
  return "$" + Math.round(v).toLocaleString("en-US");
};
const pctTxt = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

function rsiClass(v) {
  if (v == null) return "rsi-neu";
  if (v > 55) return "rsi-pos";
  if (v < 45) return "rsi-neg";
  return "rsi-neu";
}

function sigChip(label, st) {
  return `<span class="sig ${st === "LONG" ? "on" : ""}" title="${st === "LONG" ? "เข้าเกณฑ์ถือ" : "ถือเงินสด"}">${label}</span>`;
}

// in-progress RSI หนึ่งสเต็ปจากแท่งปิดล่าสุด
function liveRSI(s, price) {
  const d = price - s.lastClose;
  const g = d > 0 ? d : 0;
  const l = d < 0 ? -d : 0;
  const ag = (s.avgGain * 13 + g) / 14;
  const al = (s.avgLoss * 13 + l) / 14;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// ---- โหลดข้อมูล ----
async function load() {
  try {
    const r = await fetch("/api/signal");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const data = await r.json();
    state.coins = data.coins;
    data.coins.forEach((c) => (state.bySym[c.sym] = { ...c, live: c.lastClose, chg: null }));
    // จัดอันดับ volume (รายชื่อมาจาก Binance ที่เรียงตาม volume อยู่แล้ว)
    [...data.coins]
      .sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0))
      .forEach((c, i) => {
        if (state.bySym[c.sym]) state.bySym[c.sym].volRank = i + 1;
      });
    renderStatus(data);
    renderOrder(data);
    renderCards(data);
    renderStats(data);
    renderStrategies(data);
    renderTable(data);
    connectWS();
  } catch (e) {
    $("#statusbar").innerHTML = `<span class="r">โหลดไม่สำเร็จ: ${e.message}</span> — หน้านี้ต้องเข้าถึง api.binance.com (ปกติบนเครื่องตัวเองได้)`;
  }
}

function renderStatus(d) {
  const dt = new Date(d.updatedAt);
  $("#clock").textContent = dt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
  $("#statusbar").innerHTML =
    `<span class="dot">●</span> อัปเดตแล้ว` +
    `<span class="sep">|</span> <span class="v">${d.coins.length}</span> เหรียญ` +
    `<span class="sep">|</span> <span id="ws-state">กำลังเชื่อมต่อสด…</span>` +
    `<span class="sep">|</span> BTC <span class="v" id="btc-px">—</span>` +
    `<span class="sep">|</span> กลยุทธ์ <span class="v">RSI 55/45 · long-only</span>`;
}

function renderOrder(d) {
  const longs = d.coins.filter((c) => c.state === "LONG").map((c) => c.sym);
  if (longs.length) {
    $("#order-title").innerHTML = `เข้าเกณฑ์ถือ: <span class="syms">${longs.join(", ")}</span>`;
    $("#order-sub").textContent = `${longs.length} จาก ${d.coins.length} เหรียญ RSI > 55 · ที่เหลือถือเงินสด (RSI ยังไม่ผ่านเกณฑ์)`;
  } else {
    $("#order-title").innerHTML = `ทั้งหมดถือเงินสด <span class="syms">(CASH)</span>`;
    $("#order-sub").textContent = `0 จาก ${d.coins.length} เหรียญที่ RSI > 55 — กลยุทธ์แนะให้ถือเงินสดทั้งหมดตอนนี้`;
  }
}

const consensus = (c) => Object.values(c.signals).filter((s) => s === "LONG").length;

function renderCards(d) {
  // ⭐ โปรด → เข้าเกณฑ์ (LONG) → แล้วเรียงตามตัวเลือกภายในแต่ละกลุ่ม
  const ordered = [...d.coins].sort((a, b) => {
    const af = state.fav.has(a.sym) ? 0 : 1;
    const bf = state.fav.has(b.sym) ? 0 : 1;
    if (af !== bf) return af - bf;
    // เหรียญที่เข้าเกณฑ์ถือ (LONG) ลอยขึ้นบนเสมอ
    const al = a.state === "LONG" ? 0 : 1;
    const bl = b.state === "LONG" ? 0 : 1;
    if (al !== bl) return al - bl;
    // เรียงภายในกลุ่มตามตัวเลือก
    if (state.sortBy === "rsi") return (b.rsiLast ?? 0) - (a.rsiLast ?? 0);
    if (state.sortBy === "vol") return (b.vol ?? 0) - (a.vol ?? 0);
    const cd = consensus(b) - consensus(a); // signal
    if (cd !== 0) return cd;
    return (b.vol ?? 0) - (a.vol ?? 0);
  });
  $("#signal-grid").innerHTML = ordered
    .map((c) => {
      const isLong = c.state === "LONG";
      const isFav = state.fav.has(c.sym);
      const isWatch = state.watch.has(c.sym);
      const tv = `https://www.tradingview.com/chart/?symbol=BINANCE:${c.sym}USDT`;
      return `<div class="card ${isLong ? "is-long" : ""} ${isFav ? "is-fav" : ""}" id="c-${c.sym}">
        ${isLong ? '<div class="long-tag">✓ เข้าเกณฑ์ถือ</div>' : ""}
        <div class="card-top">
          <span class="sym">${c.sym}</span>
          <span class="live">LIVE</span>
          <span class="card-right">
            <span class="badge ${isLong ? "long" : ""}">${c.state}</span>
            <button class="act ${isFav ? "on" : ""}" data-fav="${c.sym}" title="รายการโปรด (ปักหมุดขึ้นบน)">⭐</button>
            <button class="act ${isWatch ? "on" : ""}" data-watch="${c.sym}" title="เฝ้าดู">👀</button>
            <a class="act" href="${tv}" target="_blank" rel="noopener" title="เปิดกราฟบน TradingView (Binance)">📈</a>
          </span>
        </div>
        <div class="price-row">
          <span class="price">${fmtUSD(c.lastClose)}</span>
          <span class="chg" data-chg>—</span>
        </div>
        ${
          c.vol
            ? `<div class="meta">Vol ${fmtBig(c.vol)} · อันดับ #${state.bySym[c.sym]?.volRank ?? "—"}</div>`
            : ""
        }
        <div class="rsi-big ${rsiClass(c.rsiLast)}" data-rsi>${c.rsiLast == null ? "—" : c.rsiLast.toFixed(1)}
          <small>RSI 14 · สด</small>
        </div>
        <div class="gauge">
          <span class="mark closed" style="left:${c.rsiLast ?? 50}%"></span>
          <span class="mark live" data-mark style="left:${c.rsiLast ?? 50}%"></span>
        </div>
        <div class="gauge-scale"><span>0</span><span>45</span><span>55</span><span>100</span></div>
        <div class="sig-row">
          <span class="sig-lab">สัญญาณ ${
            Object.values(c.signals).filter((s) => s === "LONG").length
          }/5</span>
          ${sigChip("RSI", c.signals.rsi)}
          ${sigChip("+EMA", c.signals.rsiEma)}
          ${sigChip("MA✕", c.signals.maCross)}
          ${sigChip("MACD", c.signals.macd)}
          ${sigChip("Donch", c.signals.donchian)}
        </div>
        <div class="card-foot">
          <div data-foot></div>
          <div class="flip" data-flip></div>
        </div>
      </div>`;
    })
    .join("");
  // เติมค่าจาก WebSocket ล่าสุด (ถ้ามี) ไม่งั้นใช้ราคาแท่งปิด
  ordered.forEach((c) => {
    const s = state.bySym[c.sym];
    updateCard(c.sym, s?.lastPrice ?? c.lastClose, s?.lastChg ?? null);
  });
}

function updateCard(sym, price, chg) {
  const s = state.bySym[sym];
  if (!s) return;
  s.lastPrice = price;
  if (chg != null) s.lastChg = chg;
  const card = $("#c-" + sym);
  if (!card) return;
  const rsi = liveRSI(s, price);

  $("[data-rsi]", card).firstChild.nodeValue = rsi.toFixed(1);
  $("[data-rsi]", card).className = "rsi-big " + rsiClass(rsi);
  $("[data-mark]", card).style.left = Math.max(0, Math.min(100, rsi)) + "%";
  $(".price", card).textContent = fmtUSD(price);
  if (chg != null) {
    const el = $("[data-chg]", card);
    el.textContent = pctTxt(chg);
    el.className = "chg " + (chg >= 0 ? "up" : "down");
  }

  const foot = $("[data-foot]", card);
  const flip = $("[data-flip]", card);
  if (s.state === "CASH") {
    const dist = 55 - rsi;
    foot.innerHTML = `คงสถานะ (แท่งปิด) — เข้า (→LONG) เมื่อ RSI > 55 <b>(ห่างอีก ${Math.abs(dist).toFixed(1)} จุด)</b>`;
    if (rsi > 55) {
      flip.className = "flip go";
      flip.textContent = `ถ้าปิดวันนี้ที่ราคานี้ → RSI ${rsi.toFixed(0)} · จะเข้า LONG 🟢`;
    } else {
      flip.className = "flip";
      flip.textContent = `ถ้าปิดวันนี้ที่ราคานี้ → RSI ${rsi.toFixed(0)} (ยังไม่พลิก)`;
    }
  } else {
    const dist = rsi - 45;
    const near = dist <= 4 ? " ⚠️ ใกล้พลิก!" : "";
    foot.innerHTML = `คงสถานะ (แท่งปิด) — ออก (→CASH) เมื่อ RSI < 45 <b>(ห่างอีก ${Math.abs(dist).toFixed(1)} จุด)${near}</b>`;
    if (rsi < 45) {
      flip.className = "flip exit";
      flip.textContent = `ถ้าปิดวันนี้ที่ราคานี้ → RSI ${rsi.toFixed(0)} · จะออก CASH`;
    } else {
      flip.className = "flip";
      flip.textContent = `ถ้าปิดวันนี้ที่ราคานี้ → RSI ${rsi.toFixed(0)} (ยังไม่พลิก)`;
    }
  }
}

function renderStats(d) {
  const p = d.portfolio;
  const mult = p.totalRSI / p.invested;
  $("#stat-cards").innerHTML = `
    <div class="stat">
      <div class="k">เติม $10K/เหรียญ (รวม ${fmtBig(p.invested)}) → เป็น</div>
      <div class="v green">${fmtBig(p.totalRSI)}</div>
      <div class="s">${mult.toFixed(1)}x ของเงินที่ลงทั้งหมด · กลยุทธ์ RSI</div>
    </div>
    <div class="stat">
      <div class="k">เฉลี่ย CAGR (กลยุทธ์)</div>
      <div class="v ${p.avgCagr >= 0 ? "green" : "red"}">${(p.avgCagr * 100).toFixed(0)}%</div>
      <div class="s">ต่อปี · เฉลี่ยข้ามเหรียญ</div>
    </div>
    <div class="stat">
      <div class="k">เฉลี่ย Sharpe</div>
      <div class="v">${p.avgSharpe.toFixed(2)}</div>
      <div class="s">ผลตอบแทนต่อความเสี่ยง</div>
    </div>
    <div class="stat">
      <div class="k">ขาดทุนสูงสุด (MDD)</div>
      <div class="v red">${(p.worstMdd * 100).toFixed(0)}%</div>
      <div class="s">ช่วงดิ่งหนักสุด (เหรียญแย่สุด)</div>
    </div>`;
}

function renderStrategies(d) {
  if (!d.strategies) return;
  // เรียงตามผลรวมมาก→น้อย หาตัวที่ดีที่สุด (ไม่นับ Buy & Hold)
  const best = [...d.strategies]
    .filter((s) => s.key !== "bh")
    .sort((a, b) => b.total - a.total)[0];
  $("#strat-body").innerHTML = d.strategies
    .map((s) => {
      const isBest = best && s.key === best.key;
      const isBH = s.key === "bh";
      return `<tr class="${isBest ? "total" : ""}">
        <td class="csym" style="font-size:14px">${isBest ? "🏆 " : ""}${s.label}${isBH ? " (ซื้อถือยาว)" : ""}</td>
        <td class="num ${isBH ? "" : "g"}">${fmtBig(s.total)}</td>
        <td class="num ${s.avgCagr >= 0 ? "g" : "r"}">${(s.avgCagr * 100).toFixed(0)}%</td>
        <td class="num">${s.avgSharpe.toFixed(2)}</td>
        <td class="num r">${(s.worstMdd * 100).toFixed(0)}%</td>
        <td class="num">${s.avgTrades.toFixed(0)}</td>
      </tr>`;
    })
    .join("");
}

function renderTable(d) {
  const rows = [...d.coins].sort((a, b) => b.finalRSI - a.finalRSI);
  const p = d.portfolio;
  const totalRow = `<tr class="total">
    <td class="csym">รวม ${p.n} เหรียญ</td>
    <td class="num g">${fmtBig(p.totalRSI)}</td>
    <td class="num">${fmtBig(p.totalBH)}</td>
    <td class="num g">${(p.avgCagr * 100).toFixed(0)}%</td>
    <td class="num">${p.avgSharpe.toFixed(2)}</td>
    <td class="num r">${(p.worstMdd * 100).toFixed(0)}%</td>
    <td class="num">—</td>
  </tr>`;
  $("#bt-body").innerHTML =
    totalRow +
    rows
      .map((c) => {
        const rsiVal = c.finalRSI * 10000;
        const bhVal = c.finalBH * 10000;
        return `<tr>
        <td class="csym">${c.sym}</td>
        <td class="num g">${fmtBig(rsiVal)}</td>
        <td class="num ${bhVal >= 10000 ? "g" : "r"}">${fmtBig(bhVal)}</td>
        <td class="num ${c.cagr >= 0 ? "g" : "r"}">${(c.cagr * 100).toFixed(0)}%</td>
        <td class="num">${c.sharpe.toFixed(2)}</td>
        <td class="num r">${(c.mdd * 100).toFixed(0)}%</td>
        <td class="num">${c.trades}</td>
      </tr>`;
      })
      .join("");
}

// ---- Binance WebSocket (ราคาสด + in-progress RSI) ----
function connectWS() {
  const syms = state.coins.map((c) => c.sym.toLowerCase() + "usdt@miniTicker");
  const url = "wss://stream.binance.com:9443/stream?streams=" + syms.join("/");
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    const el = $("#ws-state");
    if (el) el.innerHTML = '<span class="dot">●</span> เชื่อมต่อสดแล้ว';
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const t = msg.data;
    if (!t || !t.s) return;
    const sym = t.s.replace("USDT", "");
    if (!state.bySym[sym]) return;
    const price = parseFloat(t.c);
    const open = parseFloat(t.o);
    const chg = open ? ((price - open) / open) * 100 : null;
    updateCard(sym, price, chg);
    if (sym === "BTC") {
      const b = $("#btc-px");
      if (b) b.textContent = fmtUSD(price);
    }
  };
  ws.onclose = () => {
    const el = $("#ws-state");
    if (el) el.textContent = "หลุดการเชื่อมต่อ — กำลังต่อใหม่…";
    setTimeout(connectWS, 4000);
  };
  ws.onerror = () => ws.close();
}

// ปุ่ม ⭐ / 👀 บนการ์ด (event delegation)
$("#signal-grid").addEventListener("click", (e) => {
  const favBtn = e.target.closest("[data-fav]");
  const watchBtn = e.target.closest("[data-watch]");
  if (favBtn) {
    const sym = favBtn.dataset.fav;
    state.fav.has(sym) ? state.fav.delete(sym) : state.fav.add(sym);
    saveSets();
    renderCards({ coins: state.coins }); // re-sort (โปรดขึ้นบน)
  } else if (watchBtn) {
    const sym = watchBtn.dataset.watch;
    state.watch.has(sym) ? state.watch.delete(sym) : state.watch.add(sym);
    saveSets();
    watchBtn.classList.toggle("on");
  }
});

// ปุ่มสลับการเรียง
document.querySelectorAll("#sort-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#sort-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.sortBy = b.dataset.sort;
    localStorage.setItem("sig_sort", state.sortBy);
    if (state.coins.length) renderCards({ coins: state.coins });
  })
);
// ตั้งปุ่ม active ให้ตรงกับค่าที่บันทึกไว้
document.querySelectorAll("#sort-seg button").forEach((b) =>
  b.classList.toggle("active", b.dataset.sort === state.sortBy)
);

load();
