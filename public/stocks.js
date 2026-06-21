const state = {
  coins: [],
  bySym: {},
  fav: new Set(JSON.parse(localStorage.getItem("stk_fav") || "[]")),
  watch: new Set(JSON.parse(localStorage.getItem("stk_watch") || "[]")),
  sortBy: localStorage.getItem("stk_sort") || "signal",
  filterMode: localStorage.getItem("stk_filter") || "pass",
  meta: null,
  aiEnabled: false,
  chatHistory: [],
};

function saveSets() {
  localStorage.setItem("stk_fav", JSON.stringify([...state.fav]));
  localStorage.setItem("stk_watch", JSON.stringify([...state.watch]));
}

const $ = (s, r = document) => r.querySelector(s);

// ---- format ----
const fmtUSD = (v) => {
  if (v == null) return "—";
  const d = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
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

const signPct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function heldText(bars) {
  if (bars <= 0) return "วันนี้";
  if (bars < 22) return bars + " วันเทรด";
  return Math.round(bars / 21) + " เดือน (" + bars + " วันเทรด)";
}
function entryRisk(pct) {
  if (pct < 0.08)
    return { cls: "go", text: "ราคายังใกล้จุดเข้า — เข้าตอนนี้ใกล้เคียงสัญญาณแรก (เข้าก่อน เสี่ยงต่ำกว่า)" };
  if (pct < 0.3)
    return { cls: "", text: "ราคาขยับจากจุดเข้าพอควรแล้ว — เข้าใหม่ได้ แต่ไม่ใช่ราคาแรก" };
  return {
    cls: "warn",
    text: "⚠️ ราคาวิ่งไกลจากจุดเข้ามากแล้ว — เข้าตอนนี้ไล่ราคาสูง เสี่ยงกว่าคนที่ได้สัญญาณแรก",
  };
}
function btLineHTML(c) {
  const t = c.bt;
  if (!t || !t.n) return `<div class="bt-line muted">📊 Backtest: ยังไม่มีเทรดที่จบ</div>`;
  const wr = (t.wins / t.n) * 100;
  return `<div class="bt-line">📊 Backtest ${t.years.toFixed(1)} ปี · ชนะ <b>${t.wins}/${t.n}</b> (${wr.toFixed(0)}%) · เฉลี่ย <b class="${t.avgRet >= 0 ? "pos" : "neg"}">${signPct(t.avgRet)}</b>/เทรด · รวม <b class="${t.totalRet >= 0 ? "pos" : "neg"}">${signPct(t.totalRet)}</b></div>`;
}
function entryBoxHTML(c) {
  const e = c.entry;
  const r = entryRisk(e.pctSinceEntry);
  const pcls = e.pctSinceEntry >= 0 ? "pos" : "neg";
  return `<div class="entry-box">
    <div class="entry-head">🟢 สัญญาณเข้าเมื่อ</div>
    <div class="entry-line">${fmtDate(e.date)} @ ${fmtUSD(e.price)} · ถือมา <b>${heldText(e.barsHeld)}</b> · ตั้งแต่เข้า <b class="${pcls}">${signPct(e.pctSinceEntry)}</b></div>
    <div class="entry-risk ${r.cls}">${r.text}</div>
  </div>`;
}

// ---- โหลดข้อมูล ----
async function load() {
  try {
    const r = await fetch("/api/stock-signal");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const data = await r.json();
    state.coins = data.coins;
    state.meta = data.meta || null;
    data.coins.forEach((c) => (state.bySym[c.sym] = c));
    setFilterLabels();
    // จัดอันดับความผันผวนต่ำ→สูง (สำหรับเรียง + แสดงอันดับ)
    [...data.coins]
      .sort((a, b) => (a.annVol ?? 9) - (b.annVol ?? 9))
      .forEach((c, i) => {
        if (state.bySym[c.sym]) state.bySym[c.sym].volRank = i + 1;
      });
    renderStatus(data);
    renderOrder();
    renderCards();
    renderFilterNote();
    renderBacktest();
  } catch (e) {
    $("#statusbar").innerHTML = `<span class="r">โหลดไม่สำเร็จ: ${e.message}</span> — หน้านี้ต้องเข้าถึง stooq.com (ปกติบนเครื่องตัวเองได้)`;
  }
}

function renderStatus(d) {
  const dt = new Date(d.updatedAt);
  $("#clock").textContent =
    dt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
  $("#statusbar").innerHTML =
    `<span class="dot">●</span> อัปเดตแล้ว` +
    `<span class="sep">|</span> <span class="v">${d.coins.length}</span> หุ้น` +
    `<span class="sep">|</span> ตลาด <span class="v">US</span>` +
    `<span class="sep">|</span> ราคาปิดล่าสุด <span class="v">${d.coins[0]?.lastDate || "—"}</span>` +
    `<span class="sep">|</span> กลยุทธ์ <span class="v">RSI 55/45 · long-only</span>`;
}

// หุ้นที่จะแสดง (ตามโหมดกรอง)
function shownCoins() {
  if (state.filterMode === "pass" && state.coins.some((c) => c.pass))
    return state.coins.filter((c) => c.pass);
  return state.coins;
}

function setFilterLabels() {
  const m = state.meta;
  if (!m) return;
  const pf = document.querySelector('#filter-seg button[data-f="pass"]');
  const af = document.querySelector('#filter-seg button[data-f="all"]');
  if (pf) pf.textContent = `ผ่านเกณฑ์ (${m.nPass})`;
  if (af) af.textContent = `ทั้งหมด (${m.nAll})`;
}

function renderFilterNote() {
  const m = state.meta;
  const el = $("#filter-note");
  if (!m || !el) return;
  if (state.filterMode === "pass") {
    el.innerHTML = `แสดงเฉพาะ <b>หุ้นที่ผ่านเกณฑ์</b> (${m.nPass}/${m.nAll}) — จาก ${m.nAll} หุ้น US สภาพคล่องสูง เหลือเฉพาะที่ประวัติ ≥ ${m.minYears} ปี และผันผวน ≤ ${Math.round(m.maxVol * 100)}%/ปี · เลือกแบบเป็นกลาง ไม่มี survivorship bias`;
  } else {
    el.innerHTML = `แสดง <b>ทั้งหมด ${m.nAll} หุ้น US</b> — บริษัทใหญ่สภาพคล่องสูง คละกลุ่มอุตสาหกรรม · ดูค่า "ผันผวน %/ปี" บนการ์ดได้`;
  }
}

function renderOrder() {
  const list = shownCoins();
  const longs = list.filter((c) => c.state === "LONG").map((c) => c.sym);
  if (longs.length) {
    $("#order-title").innerHTML = `เข้าเกณฑ์ถือ: <span class="syms">${longs.join(", ")}</span>`;
    $("#order-sub").textContent = `${longs.length} จาก ${list.length} หุ้น RSI > 55 · ที่เหลือถือเงินสด (RSI ยังไม่ผ่านเกณฑ์)`;
  } else {
    $("#order-title").innerHTML = `ทั้งหมดถือเงินสด <span class="syms">(CASH)</span>`;
    $("#order-sub").textContent = `0 จาก ${list.length} หุ้นที่ RSI > 55 — กลยุทธ์แนะให้ถือเงินสดทั้งหมดตอนนี้`;
  }
}

// Backtest ตลอดประวัติ: รวมเทรดของทุกหุ้นที่แสดงอยู่
function renderBacktest() {
  const list = shownCoins();
  const all = [];
  list.forEach((c) =>
    (c.bt?.list || []).filter((t) => !t.open).forEach((t) => all.push(t))
  );
  const n = all.length;
  const wins = all.filter((t) => t.ret > 0).length;
  const wr = n ? (wins / n) * 100 : 0;
  const avg = n ? (all.reduce((a, b) => a + b.ret, 0) / n) * 100 : 0;
  const wrCls = wr >= 50 ? "g" : "r";
  const maxYears = Math.max(0, ...list.map((c) => c.bt?.years || 0));
  $("#bt2y-head").innerHTML = n
    ? `โอกาสกำไร <b class="${wrCls}">${wr.toFixed(0)}%</b> · จาก <b>${n}</b> เทรด (${wins} ชนะ) · กำไรเฉลี่ย <b class="${avg >= 0 ? "g" : "r"}">${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%</b>/เทรด · ประวัติสูงสุด ~${maxYears.toFixed(1)} ปี`
    : "ยังไม่มีเทรดที่จบ";
}

const consensus = (c) => Object.values(c.signals).filter((s) => s === "LONG").length;

// สถานะแบบสรุป (ราคาปิด) — ห่างจากเส้นเข้า/ออกกี่จุด
function footHTML(c) {
  const rsi = c.rsiLast;
  if (rsi == null) return "";
  if (c.state === "CASH") {
    const dist = 55 - rsi;
    return `คงสถานะ (แท่งปิด) — เข้า (→LONG) เมื่อ RSI > 55 <b>(ห่างอีก ${Math.abs(dist).toFixed(1)} จุด)</b>`;
  }
  const dist = rsi - 45;
  const near = dist <= 4 ? " ⚠️ ใกล้พลิก!" : "";
  return `คงสถานะ (แท่งปิด) — ออก (→CASH) เมื่อ RSI < 45 <b>(ห่างอีก ${Math.abs(dist).toFixed(1)} จุด)${near}</b>`;
}

function renderCards() {
  // ⭐ โปรด → เข้าเกณฑ์ (LONG) → แล้วเรียงตามตัวเลือกภายในแต่ละกลุ่ม
  const ordered = [...shownCoins()].sort((a, b) => {
    const af = state.fav.has(a.sym) ? 0 : 1;
    const bf = state.fav.has(b.sym) ? 0 : 1;
    if (af !== bf) return af - bf;
    const al = a.state === "LONG" ? 0 : 1;
    const bl = b.state === "LONG" ? 0 : 1;
    if (al !== bl) return al - bl;
    if (state.sortBy === "rsi") return (b.rsiLast ?? 0) - (a.rsiLast ?? 0);
    if (state.sortBy === "vol") return (a.annVol ?? 9) - (b.annVol ?? 9); // ผันผวนต่ำก่อน
    const cd = consensus(b) - consensus(a); // signal
    if (cd !== 0) return cd;
    return (a.annVol ?? 9) - (b.annVol ?? 9);
  });
  $("#signal-grid").innerHTML = ordered
    .map((c) => {
      const isLong = c.state === "LONG";
      const isFav = state.fav.has(c.sym);
      const isWatch = state.watch.has(c.sym);
      const tv = `https://www.tradingview.com/chart/?symbol=${c.sym}`;
      const isNew = isLong && c.entry?.isNew;
      const chg = c.chgPct != null ? c.chgPct * 100 : null;
      return `<div class="card ${isLong ? "is-long" : ""} ${isFav ? "is-fav" : ""}" id="c-${c.sym}">
        ${isLong ? `<div class="long-tag${isNew ? " new" : ""}">${isNew ? "🆕 สัญญาณเข้าใหม่" : "✓ เข้าเกณฑ์ถือ"}</div>` : ""}
        <div class="card-top">
          <span class="sym">${c.sym}</span>
          <span class="card-right">
            <span class="badge ${isLong ? "long" : ""}">${c.state}</span>
            <button class="act ${isFav ? "on" : ""}" data-fav="${c.sym}" title="รายการโปรด (ปักหมุดขึ้นบน)">⭐</button>
            <button class="act ${isWatch ? "on" : ""}" data-watch="${c.sym}" title="เฝ้าดู">👀</button>
            <a class="act" href="${tv}" target="_blank" rel="noopener" title="เปิดกราฟบน TradingView">📈</a>
          </span>
        </div>
        <div class="price-row">
          <span class="price">${fmtUSD(c.lastClose)}</span>
          <span class="chg ${chg == null ? "" : chg >= 0 ? "up" : "down"}">${chg == null ? "—" : pctTxt(chg)}</span>
        </div>
        <div class="meta">${
          c.annVol != null ? `ผันผวน ${Math.round(c.annVol * 100)}%/ปี · ผันผวนต่ำอันดับ #${state.bySym[c.sym]?.volRank ?? "—"}` : ""
        }</div>
        <div class="rsi-big ${rsiClass(c.rsiLast)}">${c.rsiLast == null ? "—" : c.rsiLast.toFixed(1)}
          <small>RSI 14 · ราคาปิดล่าสุด</small>
        </div>
        <div class="gauge">
          <span class="mark closed" style="left:${c.rsiLast ?? 50}%"></span>
        </div>
        <div class="gauge-scale"><span>0</span><span>45</span><span>55</span><span>100</span></div>
        <div class="sig-row">
          <span class="sig-lab">สัญญาณ ${consensus(c)}/5</span>
          ${sigChip("RSI", c.signals.rsi)}
          ${sigChip("+EMA", c.signals.rsiEma)}
          ${sigChip("MA✕", c.signals.maCross)}
          ${sigChip("MACD", c.signals.macd)}
          ${sigChip("Donch", c.signals.donchian)}
        </div>
        <div class="card-foot">
          <div>${footHTML(c)}</div>
        </div>
        ${isLong && c.entry ? entryBoxHTML(c) : ""}
        ${btLineHTML(c)}
      </div>`;
    })
    .join("");
}

// ปุ่ม ⭐ / 👀 บนการ์ด (event delegation)
$("#signal-grid").addEventListener("click", (e) => {
  const favBtn = e.target.closest("[data-fav]");
  const watchBtn = e.target.closest("[data-watch]");
  if (favBtn) {
    const sym = favBtn.dataset.fav;
    state.fav.has(sym) ? state.fav.delete(sym) : state.fav.add(sym);
    saveSets();
    renderCards();
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
    localStorage.setItem("stk_sort", state.sortBy);
    if (state.coins.length) renderCards();
  })
);
document.querySelectorAll("#sort-seg button").forEach((b) =>
  b.classList.toggle("active", b.dataset.sort === state.sortBy)
);

// ปุ่มสลับตัวกรอง ผ่านเกณฑ์ / ทั้งหมด
document.querySelectorAll("#filter-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#filter-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.filterMode = b.dataset.f;
    localStorage.setItem("stk_filter", state.filterMode);
    if (state.coins.length) {
      renderOrder();
      renderCards();
      renderFilterNote();
      renderBacktest();
    }
  })
);
document.querySelectorAll("#filter-seg button").forEach((b) =>
  b.classList.toggle("active", b.dataset.f === state.filterMode)
);

// ===== AI: วิเคราะห์สัญญาณ + แชท =====
async function streamPost(url, payload, onChunk) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
    onChunk(dec.decode(value, { stream: true }));
  }
}

function buildSummary() {
  const list = shownCoins();
  return {
    ตลาด: "US",
    โหมด: state.filterMode === "pass" ? "ผ่านเกณฑ์" : "ทั้งหมด",
    จำนวนหุ้น: list.length,
    เข้าเกณฑ์ถือ_LONG: list.filter((c) => c.state === "LONG").map((c) => c.sym),
    หุ้น: list.slice(0, 30).map((c) => ({
      sym: c.sym,
      สถานะ: c.state,
      rsi: c.rsiLast == null ? null : Math.round(c.rsiLast),
      ผันผวนต่อปี: c.annVol == null ? null : Math.round(c.annVol * 100) + "%",
      สัญญาณLONG: consensus(c) + "/5",
    })),
  };
}

$("#signal-analyze").addEventListener("click", async () => {
  const out = $("#signal-ai-out");
  const btn = $("#signal-analyze");
  out.classList.remove("hidden");
  if (!state.aiEnabled) {
    out.textContent = "⚠️ ต้องตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ก่อนถึงจะใช้ AI ได้";
    return;
  }
  out.textContent = "";
  btn.disabled = true;
  btn.textContent = "กำลังวิเคราะห์…";
  try {
    await streamPost("/api/stock-analysis", { summary: buildSummary() }, (t) => {
      out.textContent += t;
    });
  } catch (e) {
    out.textContent = "เกิดข้อผิดพลาด: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🤖 วิเคราะห์สัญญาณอีกครั้ง";
  }
});

// แชท
function addChatMsg(role, text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
$("#chat-fab").addEventListener("click", () => {
  $("#chat-panel").classList.toggle("hidden");
  if (!$("#chat-panel").classList.contains("hidden")) $("#chat-input").focus();
});
$("#chat-close").addEventListener("click", () => $("#chat-panel").classList.add("hidden"));
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!state.aiEnabled) {
    addChatMsg("bot", "⚠️ ต้องตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ก่อน");
    return;
  }
  input.value = "";
  addChatMsg("user", text);
  state.chatHistory.push({ role: "user", content: text });
  const sendBtn = $("#chat-form button");
  sendBtn.disabled = true;
  const botDiv = addChatMsg("bot", "…");
  let acc = "";
  try {
    await streamPost(
      "/api/chat",
      { messages: state.chatHistory.slice(-12), snapshot: buildSummary() },
      (t) => {
        acc += t;
        botDiv.textContent = acc;
        $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
      }
    );
    state.chatHistory.push({ role: "assistant", content: acc });
  } catch (err) {
    botDiv.textContent = "เกิดข้อผิดพลาด: " + err.message;
  } finally {
    sendBtn.disabled = false;
  }
});

// เช็คว่าเปิด AI ได้ไหม
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    state.aiEnabled = s.aiEnabled;
    if (!s.aiEnabled) {
      $("#chat-fab").classList.add("hidden");
      $("#signal-analyze").classList.add("hidden");
    }
  })
  .catch(() => {});

load();
