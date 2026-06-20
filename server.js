import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;
const COINGECKO = "https://api.coingecko.com/api/v3";
const BINANCE = "https://api.binance.com";

// เหรียญสำรอง (ใช้เมื่อดึง Top จาก Binance ไม่ได้)
const SIGNAL_COINS = [
  "BTC", "ETH", "BNB", "SOL", "ADA", "DOGE", "AVAX", "LINK",
  "AXS", "SAND", "ZEC", "FET", "EGLD", "RUNE", "VET", "WLD", "ONE", "ENJ",
];

// stablecoin / token ที่ไม่ควรเอามาคิด RSI
const STABLE = new Set([
  "USDC", "FDUSD", "TUSD", "DAI", "BUSD", "USDP", "GUSD", "PYUSD",
  "USTC", "EUR", "EURI", "AEUR", "XUSD", "USD1",
]);

// เหรียญ wrapped/staked ที่ซ้ำกับตัวจริง (ตัดออกกันนับซ้ำ)
const WRAPPED = new Set([
  "WBTC", "WETH", "WEETH", "WSTETH", "STETH", "WBETH", "RETH", "CBETH",
  "WBNB", "BSC-USD", "LBTC", "SOLVBTC", "BTCB",
]);

// จำนวนเหรียญ tier บน (เรียงตามมาร์เก็ตแคป) ที่ใช้ในหน้า RSI Signal
const SIGNAL_COUNT = 50;

// เกณฑ์คัดเหรียญ "ผ่านเกณฑ์" แบบเป็นกลาง (ไม่ดูผลกำไร → ไม่มี survivorship bias)
const PASS_MIN_YEARS = 2; // ประวัติ ≥ 2 ปี (ตัดเหรียญใหม่/ปั่น)
const PASS_MAX_VOL = 1.5; // ความผันผวน ≤ 150%/ปี (ตัดเหรียญสวิงแรงแบบมีคนปั่น)

// สร้าง client เฉพาะเมื่อมี ANTHROPIC_API_KEY (อ่านจาก env อัตโนมัติ)
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// CoinGecko Demo API key (ไม่บังคับ แต่ใส่แล้วลิมิตสูงขึ้นมาก — แนะนำสำหรับหน้า RSI)
const CG_KEY = process.env.COINGECKO_API_KEY || "";

// แคชราคาในหน่วยความจำสั้นๆ เพื่อกัน rate limit ของ CoinGecko (ฟรี ~10-30 req/min)
const cache = new Map();
function getCached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { t: Date.now(), data });
}
// คืนข้อมูลเก่าในแคชแม้หมดอายุแล้ว (ใช้เป็น fallback เวลาโดน rate limit)
function getStale(key) {
  const hit = cache.get(key);
  return hit ? hit.data : null;
}

async function cgFetch(url, { retries = 2 } = {}) {
  const headers = { accept: "application/json" };
  if (CG_KEY) headers["x-cg-demo-api-key"] = CG_KEY;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    // โดน rate limit → รอแล้วลองใหม่ (backoff)
    if (r.status === 429 && attempt < retries) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    const text = await r.text().catch(() => "");
    throw new Error(`CoinGecko ${r.status}: ${text.slice(0, 200)}`);
  }
}

// ---- ดึงรายการเหรียญ + ราคา (ตลาดรวม) ----
app.get("/api/markets", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const key = `markets:${vs}`;
  const cached = getCached(key, 45_000); // แคช 45 วิ
  if (cached) return res.json(cached);

  const url =
    `${COINGECKO}/coins/markets?vs_currency=${encodeURIComponent(vs)}` +
    `&order=market_cap_desc&per_page=50&page=1&sparkline=true` +
    `&price_change_percentage=1h,24h,7d`;
  try {
    const data = await cgFetch(url);
    setCached(key, data);
    res.json(data);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ---- ดึงข้อมูลกราฟราคาของเหรียญเดียว ----
app.get("/api/coin/:id/chart", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const days = String(req.query.days || "7");
  const id = encodeURIComponent(req.params.id);
  const key = `chart:${id}:${vs}:${days}`;
  const cached = getCached(key, 120_000); // แคช 2 นาที
  if (cached) return res.json(cached);

  const url = `${COINGECKO}/coins/${id}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(days)}`;
  try {
    const data = await cgFetch(url);
    setCached(key, data);
    res.json(data);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ---- ภาพรวมตลาดรวม + ดัชนี Fear & Greed ----
app.get("/api/global", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const key = `global:${vs}`;
  const cached = getCached(key, 60_000);
  if (cached) return res.json(cached);
  try {
    const [g, fngJson] = await Promise.all([
      cgFetch(`${COINGECKO}/global`),
      fetch("https://api.alternative.me/fng/?limit=1")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    const d = g.data || {};
    const fng = fngJson?.data?.[0]
      ? { value: Number(fngJson.data[0].value), label: fngJson.data[0].value_classification }
      : null;
    const data = {
      vs,
      total_market_cap: d.total_market_cap?.[vs],
      total_volume: d.total_volume?.[vs],
      market_cap_change_24h: d.market_cap_change_percentage_24h_usd,
      btc_dominance: d.market_cap_percentage?.btc,
      eth_dominance: d.market_cap_percentage?.eth,
      active_cryptos: d.active_cryptocurrencies,
      fng,
    };
    setCached(key, data);
    res.json(data);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ---- เหรียญมาแรง (Trending) ----
app.get("/api/trending", async (_req, res) => {
  const cached = getCached("trending", 300_000);
  if (cached) return res.json(cached);
  try {
    const t = await cgFetch(`${COINGECKO}/search/trending`);
    const coins = (t.coins || []).slice(0, 10).map((c) => ({
      id: c.item.id,
      name: c.item.name,
      symbol: c.item.symbol,
      thumb: c.item.thumb,
      rank: c.item.market_cap_rank,
      change24h: c.item.data?.price_change_percentage_24h?.usd,
    }));
    setCached("trending", coins);
    res.json(coins);
  } catch (e) {
    const stale = getStale("trending");
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ---- บอกหน้าเว็บว่ามี Claude พร้อมใช้ไหม ----
app.get("/api/status", (_req, res) => {
  res.json({ aiEnabled: Boolean(anthropic) });
});

// ---- คำนวณ RSI(14) แบบ Wilder ----
function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ช่วงเวลา → จำนวนวันที่ดึงจาก CoinGecko (granularity ปรับอัตโนมัติ)
const RSI_TF = {
  "5m": 1, // days=1 → ข้อมูล 5 นาที
  "1h": 14, // days=2-90 → ข้อมูลรายชั่วโมง
  "1d": 200, // days>90 → ข้อมูลรายวัน
};

// ---- สแกน RSI ของเหรียญ Top 25 ----
app.get("/api/rsi", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const tf = RSI_TF[req.query.tf] ? req.query.tf : "1d";
  const key = `rsi:${vs}:${tf}`;
  const cached = getCached(key, 300_000); // แคช 5 นาที
  if (cached) return res.json(cached);

  try {
    let markets = getCached(`markets:${vs}`, 60_000);
    if (!markets) {
      markets = await cgFetch(
        `${COINGECKO}/coins/markets?vs_currency=${vs}&order=market_cap_desc&per_page=30&page=1&sparkline=false`
      );
    }
    const top = markets.slice(0, 25);
    const days = RSI_TF[tf];
    const out = [];
    for (const c of top) {
      try {
        const chart = await cgFetch(
          `${COINGECKO}/coins/${c.id}/market_chart?vs_currency=${vs}&days=${days}`
        );
        const closes = (chart.prices || []).map((p) => p[1]);
        out.push({
          id: c.id,
          name: c.name,
          symbol: c.symbol,
          image: c.image,
          price: c.current_price,
          rsi: computeRSI(closes, 14),
        });
      } catch {
        out.push({
          id: c.id,
          name: c.name,
          symbol: c.symbol,
          image: c.image,
          price: c.current_price,
          rsi: null,
        });
      }
      // หน่วงเล็กน้อยกัน rate limit ของ CoinGecko ฟรี
      await new Promise((r) => setTimeout(r, 600));
    }
    setCached(key, out);
    res.json(out);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ===== RSI Signal + Backtest (ใช้ราคาจาก Binance) =====

// คำนวณซีรีส์ RSI(14) แบบ Wilder + คืนสถานะ smoothing ล่าสุด
function rsiSeries(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return { rsi, avgGain: 0, avgLoss: 0 };
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return { rsi, avgGain, avgLoss };
}

// backtest กลยุทธ์ RSI 55/45 long-only เทียบกับ Buy & Hold
function backtest(closes, fee = 0.0004) {
  const { rsi, avgGain, avgLoss } = rsiSeries(closes, 14);
  let state = "CASH";
  let stratEq = 1;
  let bhEq = 1;
  let trades = 0;
  let peak = 1;
  let mdd = 0;
  const rets = [];
  for (let i = 0; i < closes.length - 1; i++) {
    if (rsi[i] != null) {
      if (rsi[i] > 55 && state !== "LONG") {
        state = "LONG";
        trades++;
        stratEq *= 1 - fee;
      } else if (rsi[i] < 45 && state !== "CASH") {
        state = "CASH";
        trades++;
        stratEq *= 1 - fee;
      }
    }
    const r = closes[i + 1] / closes[i] - 1;
    bhEq *= 1 + r;
    if (state === "LONG") {
      stratEq *= 1 + r;
      rets.push(r);
    } else {
      rets.push(0);
    }
    peak = Math.max(peak, stratEq);
    mdd = Math.min(mdd, (stratEq - peak) / peak);
  }
  // สถานะปัจจุบัน = อิงแท่งปิดล่าสุด
  const rsiLast = rsi[closes.length - 1];
  if (rsiLast != null) {
    if (rsiLast > 55) state = "LONG";
    else if (rsiLast < 45) state = "CASH";
  }
  const years = (closes.length - 1) / 365.25;
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)
  );
  return {
    finalRSI: stratEq,
    finalBH: bhEq,
    cagr: Math.pow(stratEq, 1 / years) - 1,
    cagrBH: Math.pow(bhEq, 1 / years) - 1,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    mdd,
    trades,
    years,
    state,
    rsiLast,
    avgGain,
    avgLoss,
    lastClose: closes[closes.length - 1],
  };
}

// ===== อินดิเคเตอร์เพิ่มเติม =====
function sma(v, p) {
  const o = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) o[i] = s / p;
  }
  return o;
}
function ema(v, p) {
  const o = new Array(v.length).fill(null);
  if (v.length < p) return o;
  const k = 2 / (p + 1);
  let s = 0;
  for (let i = 0; i < p; i++) s += v[i];
  let prev = s / p;
  o[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    o[i] = prev;
  }
  return o;
}
function macdArrays(closes) {
  const f = ema(closes, 12);
  const s = ema(closes, 26);
  const line = closes.map((_, i) =>
    f[i] != null && s[i] != null ? f[i] - s[i] : null
  );
  const sig = new Array(closes.length).fill(null);
  const k = 2 / (9 + 1);
  let prev = null;
  let cnt = 0;
  let sum = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] == null) continue;
    if (cnt < 9) {
      sum += line[i];
      cnt++;
      if (cnt === 9) {
        prev = sum / 9;
        sig[i] = prev;
      }
    } else {
      prev = line[i] * k + prev * (1 - k);
      sig[i] = prev;
    }
  }
  return { line, sig };
}
function rollMax(v, p) {
  const o = new Array(v.length).fill(null);
  for (let i = p; i < v.length; i++) {
    let m = -Infinity;
    for (let j = i - p; j < i; j++) m = Math.max(m, v[j]);
    o[i] = m;
  }
  return o;
}
function rollMin(v, p) {
  const o = new Array(v.length).fill(null);
  for (let i = p; i < v.length; i++) {
    let m = Infinity;
    for (let j = i - p; j < i; j++) m = Math.min(m, v[j]);
    o[i] = m;
  }
  return o;
}

// backtest แบบทั่วไป: stateAt(i) คืน "LONG"/"CASH"/null(คงสถานะ)
function runStrat(closes, stateAt, fee = 0.0004) {
  let state = "CASH";
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  let trades = 0;
  const rets = [];
  for (let i = 0; i < closes.length - 1; i++) {
    const w = stateAt(i);
    if (w && w !== state) {
      state = w;
      trades++;
      eq *= 1 - fee;
    }
    const r = closes[i + 1] / closes[i] - 1;
    if (state === "LONG") {
      eq *= 1 + r;
      rets.push(r);
    } else rets.push(0);
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, (eq - peak) / peak);
  }
  const w = stateAt(closes.length - 1);
  if (w) state = w;
  const years = (closes.length - 1) / 365.25;
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)
  );
  return {
    final: eq,
    cagr: Math.pow(eq, 1 / years) - 1,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    mdd,
    trades,
    state,
    years,
  };
}

// ความผันผวนต่อปี (annualized volatility) จากผลตอบแทนรายวัน
function annualVol(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return Math.sqrt(variance) * Math.sqrt(365);
}

// คำนวณทุกกลยุทธ์ของเหรียญเดียว
function computeCoin(sym, closes) {
  const { rsi, avgGain, avgLoss } = rsiSeries(closes, 14);
  const e200 = ema(closes, 200);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const { line, sig } = macdArrays(closes);
  const hi20 = rollMax(closes, 20);
  const lo10 = rollMin(closes, 10);

  const stRsi = (i) =>
    rsi[i] == null ? null : rsi[i] > 55 ? "LONG" : rsi[i] < 45 ? "CASH" : null;
  const stRsiEma = (i) => {
    if (rsi[i] == null || e200[i] == null) return null;
    if (rsi[i] > 55 && closes[i] > e200[i]) return "LONG";
    if (rsi[i] < 45 || closes[i] < e200[i]) return "CASH";
    return null;
  };
  const stMa = (i) =>
    s50[i] == null || s200[i] == null ? null : s50[i] > s200[i] ? "LONG" : "CASH";
  const stMacd = (i) =>
    line[i] == null || sig[i] == null ? null : line[i] > sig[i] ? "LONG" : "CASH";
  const stDon = (i) => {
    if (hi20[i] == null || lo10[i] == null) return null;
    if (closes[i] >= hi20[i]) return "LONG";
    if (closes[i] <= lo10[i]) return "CASH";
    return null;
  };

  const strat = {
    rsi: runStrat(closes, stRsi),
    rsiEma: runStrat(closes, stRsiEma),
    maCross: runStrat(closes, stMa),
    macd: runStrat(closes, stMacd),
    donchian: runStrat(closes, stDon),
    bh: runStrat(closes, () => "LONG"),
  };

  return {
    sym,
    lastClose: closes[closes.length - 1],
    rsiLast: rsi[rsi.length - 1],
    avgGain,
    avgLoss,
    annVol: annualVol(closes),
    signals: {
      rsi: strat.rsi.state,
      rsiEma: strat.rsiEma.state,
      maCross: strat.maCross.state,
      macd: strat.macd.state,
      donchian: strat.donchian.state,
    },
    // metric ของกลยุทธ์ RSI (ใช้กับตารางเดิม + การ์ด)
    state: strat.rsi.state,
    finalRSI: strat.rsi.final,
    finalBH: strat.bh.final,
    cagr: strat.rsi.cagr,
    cagrBH: strat.bh.cagr,
    sharpe: strat.rsi.sharpe,
    mdd: strat.rsi.mdd,
    trades: strat.rsi.trades,
    years: strat.rsi.years,
    strat, // ลบออกก่อนส่ง
  };
}

const STRAT_DEFS = [
  ["rsi", "RSI 55/45"],
  ["rsiEma", "RSI + กรองเทรนด์ EMA200"],
  ["maCross", "MA Cross 50/200"],
  ["macd", "MACD (12/26/9)"],
  ["donchian", "Donchian 20/10"],
  ["bh", "Buy & Hold"],
];

// ดึงราคาปิดรายวันจาก Binance (แบ่งหน้าได้สูงสุด ~3000 แท่ง)
async function binanceCloses(symbol, pages = 3) {
  let endTime = Date.now();
  const batches = [];
  for (let i = 0; i < pages; i++) {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&endTime=${endTime}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) break;
    const k = await r.json();
    if (!Array.isArray(k) || !k.length) break;
    batches.unshift(k);
    endTime = k[0][0] - 1;
    if (k.length < 1000) break;
  }
  return batches.flat().map((x) => parseFloat(x[4]));
}

// ดึง Top N เหรียญตามสภาพคล่อง (quote volume) จาก Binance — เลือกแบบเป็นกลาง
async function binanceTopSymbols(n = 50) {
  const r = await fetch(`${BINANCE}/api/v3/ticker/24hr`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error("Binance ticker error");
  const arr = await r.json();
  return arr
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({ base: t.symbol.slice(0, -4), qv: parseFloat(t.quoteVolume) }))
    .filter(
      (t) =>
        t.base &&
        !STABLE.has(t.base) &&
        !t.base.includes("USD") &&
        !/(UP|DOWN|BULL|BEAR)$/.test(t.base)
    )
    .sort((a, b) => b.qv - a.qv)
    .slice(0, n)
    .map((t) => ({ sym: t.base, vol: t.qv }));
}

// แผนที่ volume ของทุกคู่ USDT บน Binance (base -> quote volume)
async function binanceUsdtVolMap() {
  const r = await fetch(`${BINANCE}/api/v3/ticker/24hr`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error("Binance ticker error");
  const arr = await r.json();
  const map = new Map();
  for (const t of arr) {
    if (!t.symbol.endsWith("USDT")) continue;
    const base = t.symbol.slice(0, -4);
    if (!base || STABLE.has(base) || base.includes("USD")) continue;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base)) continue;
    map.set(base, parseFloat(t.quoteVolume));
  }
  return map;
}

// Top N เหรียญตามมาร์เก็ตแคป (CoinGecko) ที่มีคู่ USDT บน Binance = "tier บน"
async function topMarketCapBases(n, volMap) {
  const mk = await cgFetch(
    `${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`
  );
  const out = [];
  const seen = new Set();
  for (const c of mk) {
    const base = (c.symbol || "").toUpperCase();
    if (!base || STABLE.has(base) || WRAPPED.has(base) || seen.has(base)) continue;
    if (!volMap.has(base)) continue; // ต้องมีคู่ USDT บน Binance (klines/ws ได้)
    seen.add(base);
    out.push({ sym: base, vol: volMap.get(base) });
    if (out.length >= n) break;
  }
  return out;
}

app.get("/api/signal", async (_req, res) => {
  const cached = getCached("signal", 600_000); // แคช 10 นาที
  if (cached) return res.json(cached);
  try {
    // เลือกเหรียญ tier บน ตามมาร์เก็ตแคป (CoinGecko) ∩ คู่ USDT บน Binance
    let symbols;
    try {
      const volMap = await binanceUsdtVolMap();
      symbols = await topMarketCapBases(SIGNAL_COUNT, volMap);
      if (!symbols.length) throw new Error("empty");
    } catch {
      try {
        symbols = await binanceTopSymbols(SIGNAL_COUNT); // สำรอง: ตาม volume
      } catch {
        symbols = SIGNAL_COINS.map((s) => ({ sym: s, vol: 0 }));
      }
    }
    const coins = [];
    for (const { sym: base, vol } of symbols) {
      try {
        const closes = await binanceCloses(base + "USDT", 2); // ~2000 แท่ง (≈5.5 ปี)
        if (closes.length < 60) continue;
        const coin = { ...computeCoin(base, closes), vol };
        coin.pass = coin.years >= PASS_MIN_YEARS && coin.annVol <= PASS_MAX_VOL;
        coins.push(coin);
      } catch {
        /* ข้ามเหรียญที่ดึงไม่ได้ */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!coins.length) throw new Error("ดึงข้อมูลจาก Binance ไม่ได้");

    // ใช้เฉพาะเหรียญที่ผ่านเกณฑ์เป็นฐานคำนวณสถิติ (ถ้าไม่มีผ่านเลย ใช้ทั้งหมด)
    const passing = coins.filter((c) => c.pass);
    const base = passing.length ? passing : coins;

    // เปรียบเทียบผลรวมของแต่ละกลยุทธ์ (สมมติ $10k/เหรียญ — เฉพาะที่ผ่านเกณฑ์)
    const strategies = STRAT_DEFS.map(([key, label]) => {
      const arr = base.map((c) => c.strat[key]);
      return {
        key,
        label,
        total: arr.reduce((a, b) => a + b.final * 10000, 0),
        avgCagr: arr.reduce((a, b) => a + b.cagr, 0) / arr.length,
        avgSharpe: arr.reduce((a, b) => a + b.sharpe, 0) / arr.length,
        worstMdd: Math.min(...arr.map((b) => b.mdd)),
        avgTrades: arr.reduce((a, b) => a + b.trades, 0) / arr.length,
      };
    });

    const cleanCoins = coins.map(({ strat, ...rest }) => rest);
    const data = {
      coins: cleanCoins,
      strategies,
      meta: {
        nAll: coins.length,
        nPass: passing.length,
        minYears: PASS_MIN_YEARS,
        maxVol: PASS_MAX_VOL,
        trackYears: Math.max(...base.map((c) => c.years)),
        invested: base.length * 10000,
      },
      portfolio: {
        n: base.length,
        totalRSI: base.reduce((a, b) => a + b.finalRSI * 10000, 0),
        totalBH: base.reduce((a, b) => a + b.finalBH * 10000, 0),
        invested: base.length * 10000,
        avgCagr: base.reduce((a, b) => a + b.cagr, 0) / base.length,
        avgSharpe: base.reduce((a, b) => a + b.sharpe, 0) / base.length,
        worstMdd: Math.min(...base.map((c) => c.mdd)),
        years: Math.max(...base.map((c) => c.years)),
      },
      updatedAt: Date.now(),
    };
    setCached("signal", data);
    res.json(data);
  } catch (e) {
    const stale = getStale("signal");
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ===== MVRV (Market Value to Realized Value) จาก CoinMetrics community API =====
async function fetchMvrv(asset) {
  const url =
    `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=${asset}&metrics=CapMrktCurUSD,CapRealUSD&frequency=1d&page_size=10000`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinMetrics ${r.status}`);
  const j = await r.json();
  const rows = (j.data || [])
    .map((d) => ({
      t: d.time.slice(0, 10),
      mc: parseFloat(d.CapMrktCurUSD),
      rc: parseFloat(d.CapRealUSD),
    }))
    .filter((d) => isFinite(d.mc) && isFinite(d.rc) && d.rc > 0);
  if (rows.length < 30) throw new Error("ข้อมูล MVRV ไม่พอ");
  const mcs = rows.map((d) => d.mc);
  const mean = mcs.reduce((a, b) => a + b, 0) / mcs.length;
  const std = Math.sqrt(mcs.reduce((a, b) => a + (b - mean) ** 2, 0) / mcs.length);
  const series = rows.map((d) => ({
    t: d.t,
    mvrv: d.mc / d.rc,
    z: (d.mc - d.rc) / std,
  }));
  const lastRow = rows[rows.length - 1];
  const last = series[series.length - 1];
  return {
    asset,
    current: { ...last, mc: lastRow.mc, rc: lastRow.rc },
    series,
  };
}

app.get("/api/mvrv", async (req, res) => {
  const asset = (req.query.asset || "btc").toLowerCase();
  if (!["btc", "eth"].includes(asset))
    return res.status(400).json({ error: "รองรับเฉพาะ btc / eth" });
  const key = `mvrv:${asset}`;
  const cached = getCached(key, 3600_000); // แคช 1 ชม.
  if (cached) return res.json(cached);
  try {
    const data = await fetchMvrv(asset);
    setCached(key, data);
    res.json(data);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// helper: สตรีมคำตอบจาก Claude ออกทาง response
async function streamClaude(res, { system, messages, maxTokens = 1200, effort = "low" }) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  try {
    const stream = anthropic.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system,
      messages,
    });
    stream.on("text", (delta) => res.write(delta));
    await stream.finalMessage();
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else {
      res.write(`\n\n[เกิดข้อผิดพลาด: ${e.message}]`);
      res.end();
    }
  }
}

// ---- แชทถาม-ตอบเรื่องคริปโตกับ AI ----
app.post("/api/chat", async (req, res) => {
  if (!anthropic)
    return res.status(503).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  const { messages = [], snapshot = null } = req.body || {};
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12);
  if (!clean.length) return res.status(400).json({ error: "ไม่มีข้อความ" });

  let system =
    "คุณเป็นผู้ช่วย AI เรื่องคริปโตเคอเรนซี ตอบเป็นภาษาไทย กระชับ เข้าใจง่าย เป็นกลาง " +
    "อธิบายเชิงการศึกษา ห้ามชี้นำให้ซื้อหรือขายแบบฟันธง " +
    "ถ้าพูดถึงการลงทุน ให้เตือนว่าเป็นข้อมูลเชิงการศึกษา ไม่ใช่คำแนะนำการลงทุน";
  if (snapshot) {
    system +=
      "\n\nนี่คือข้อมูลตลาดล่าสุด (ใช้อ้างอิงราคาปัจจุบันได้):\n```json\n" +
      JSON.stringify(snapshot).slice(0, 4000) +
      "\n```";
  }
  await streamClaude(res, { system, messages: clean, maxTokens: 1200, effort: "low" });
});

// ---- AI วิเคราะห์ภาพรวมตลาดทั้งหมด ----
app.post("/api/market-analysis", async (req, res) => {
  if (!anthropic)
    return res.status(503).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  const { global: g = null, top = [], vs = "usd" } = req.body || {};
  const facts = {
    สกุลเงิน: vs.toUpperCase(),
    ภาพรวม: g,
    เหรียญ10อันดับแรก: (top || []).slice(0, 10).map((c) => ({
      ชื่อ: c.name,
      สัญลักษณ์: (c.symbol || "").toUpperCase(),
      ราคา: c.current_price,
      เปลี่ยน24ชม_pct: c.price_change_percentage_24h_in_currency,
    })),
  };
  const system =
    "คุณเป็นผู้ช่วยวิเคราะห์ภาพรวมตลาดคริปโตเชิงการศึกษา ภาษาไทย " +
    "อธิบายสิ่งที่ข้อมูลกำลังบอกอย่างเป็นกลาง ชี้ทั้งด้านบวกและความเสี่ยง " +
    "ห้ามชี้นำซื้อ/ขาย ปิดท้ายด้วยคำเตือนว่าไม่ใช่คำแนะนำการลงทุน";
  const userPrompt =
    "ช่วยสรุปภาพรวมตลาดคริปโตตอนนี้จากข้อมูลนี้ เป็นภาษาไทยอ่านง่าย:\n\n```json\n" +
    JSON.stringify(facts, null, 2) +
    "\n```\n\nจัดเป็นหัวข้อ: 1) อารมณ์ตลาดโดยรวม 2) สัญญาณที่น่าสนใจ 3) สิ่งที่ต้องระวัง 4) คำเตือน";
  await streamClaude(res, {
    system,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 1500,
    effort: "medium",
  });
});

// ---- AI วิเคราะห์สัญญาณ RSI (หน้า Signal) ----
app.post("/api/signal-analysis", async (req, res) => {
  if (!anthropic)
    return res.status(503).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  const { summary = null } = req.body || {};
  if (!summary) return res.status(400).json({ error: "ไม่มีข้อมูลสัญญาณ" });
  const system =
    "คุณเป็นผู้ช่วยวิเคราะห์สัญญาณเทคนิคคริปโตเชิงการศึกษา ภาษาไทย " +
    "อธิบายภาพรวมของสัญญาณที่ให้มา (เหรียญไหนเข้าเกณฑ์ถือ/ใกล้พลิก/หลายกลยุทธ์เห็นพ้อง) อย่างเป็นกลาง " +
    "ชี้ทั้งโอกาสและความเสี่ยง ห้ามชี้นำซื้อ/ขายแบบฟันธง ปิดท้ายด้วยคำเตือนว่าไม่ใช่คำแนะนำการลงทุน";
  const userPrompt =
    "นี่คือสัญญาณ RSI/กลยุทธ์ล่าสุดของเหรียญที่ติดตาม ช่วยสรุปเป็นภาษาไทยอ่านง่าย:\n\n```json\n" +
    JSON.stringify(summary).slice(0, 5000) +
    "\n```\n\nจัดเป็นหัวข้อ: 1) ภาพรวมตอนนี้ 2) เหรียญที่น่าจับตา (เข้าเกณฑ์/ใกล้พลิก) 3) สิ่งที่ต้องระวัง 4) คำเตือน";
  await streamClaude(res, {
    system,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 1400,
    effort: "medium",
  });
});

// ---- AI วิเคราะห์ข้อมูลตลาด (สตรีมข้อความกลับมา) ----
app.post("/api/analyze", async (req, res) => {
  if (!anthropic) {
    return res
      .status(503)
      .json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  }

  const { coin, vs = "usd", lang = "th" } = req.body || {};
  if (!coin || !coin.name) {
    return res.status(400).json({ error: "ไม่มีข้อมูลเหรียญที่จะวิเคราะห์" });
  }

  // สรุปข้อมูลตลาดส่งให้โมเดล (เป็นข้อเท็จจริงล่าสุดจาก CoinGecko)
  const facts = {
    ชื่อ: coin.name,
    สัญลักษณ์: (coin.symbol || "").toUpperCase(),
    สกุลเงินอ้างอิง: vs.toUpperCase(),
    ราคาปัจจุบัน: coin.current_price,
    เปลี่ยนแปลง_1ชม_pct: coin.price_change_percentage_1h_in_currency,
    เปลี่ยนแปลง_24ชม_pct: coin.price_change_percentage_24h_in_currency,
    เปลี่ยนแปลง_7วัน_pct: coin.price_change_percentage_7d_in_currency,
    มาร์เก็ตแคป: coin.market_cap,
    อันดับมาร์เก็ตแคป: coin.market_cap_rank,
    ปริมาณซื้อขาย_24ชม: coin.total_volume,
    สูงสุด_24ชม: coin.high_24h,
    ต่ำสุด_24ชม: coin.low_24h,
    ราคาสูงสุดตลอดกาล_ath: coin.ath,
    ห่างจาก_ath_pct: coin.ath_change_percentage,
  };

  const system =
    "คุณเป็นผู้ช่วยวิเคราะห์ข้อมูลตลาดคริปโตเชิงการศึกษา ภาษาไทย " +
    "งานของคุณคืออธิบายสิ่งที่ 'ตัวเลขกำลังบอก' จากข้อมูลที่ให้มาเท่านั้น " +
    "ห้ามชี้นำให้ซื้อหรือขาย ห้ามให้คำแนะนำการลงทุนแบบฟันธง และห้ามทำนายราคาแบบรับประกัน " +
    "ให้วิเคราะห์อย่างเป็นกลาง ชี้ทั้งสัญญาณบวกและความเสี่ยง ปิดท้ายด้วยข้อความเตือนว่านี่ไม่ใช่คำแนะนำการลงทุน";

  const userPrompt =
    `ช่วยวิเคราะห์ข้อมูลตลาดล่าสุดของเหรียญนี้ให้หน่อย แล้วสรุปเป็นภาษาไทยแบบอ่านง่าย:\n\n` +
    "```json\n" +
    JSON.stringify(facts, null, 2) +
    "\n```\n\n" +
    "จัดรูปแบบคำตอบเป็นหัวข้อสั้นๆ ดังนี้:\n" +
    "1) ภาพรวมตอนนี้ (ราคาขยับยังไงในกรอบ 1ชม/24ชม/7วัน)\n" +
    "2) สัญญาณที่น่าสนใจ (โมเมนตัม ปริมาณซื้อขาย ตำแหน่งเทียบ ATH/กรอบ 24ชม)\n" +
    "3) ความเสี่ยง/สิ่งที่ต้องระวัง\n" +
    "4) คำเตือน (ไม่ใช่คำแนะนำการลงทุน)";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const stream = anthropic.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: userPrompt }],
    });

    // ส่งเฉพาะ text delta (thinking ไม่ถูกส่งออกมาเพราะ display เป็น omitted)
    stream.on("text", (delta) => res.write(delta));
    await stream.finalMessage();
    res.end();
  } catch (e) {
    // ถ้ายังไม่ได้เริ่มสตรีม ส่ง error ปกติ; ถ้าเริ่มแล้วก็ปิด stream
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.write(`\n\n[เกิดข้อผิดพลาด: ${e.message}]`);
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ CryptoDash รันที่ http://localhost:${PORT}`);
  console.log(
    anthropic
      ? "🤖 AI วิเคราะห์: เปิดใช้งาน (พบ ANTHROPIC_API_KEY)"
      : "⚠️  AI วิเคราะห์: ปิดอยู่ (ตั้งค่า ANTHROPIC_API_KEY เพื่อเปิดใช้)"
  );
  console.log(
    CG_KEY
      ? "🪙 CoinGecko: ใช้ Demo key (ลิมิตสูง — หน้า RSI ใช้ได้เต็มที่)"
      : "⚠️  CoinGecko: ไม่มี key (ลิมิตต่ำ — หน้า RSI อาจขึ้นบางเหรียญ ใส่ COINGECKO_API_KEY เพื่อแก้)"
  );
});
