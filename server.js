import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// โหลดไฟล์ .env เอง (กันกรณีรันด้วย `npm start` / `node server.js` ที่ไม่อ่าน .env ให้อัตโนมัติ)
(function loadEnv() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* อ่าน .env ไม่ได้ก็ข้ามไป */
  }
})();

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

// ===== หุ้น US =====
const STOCK_PPY = 252; // วันเทรดต่อปี (ตลาดหุ้นปิดเสาร์-อาทิตย์/วันหยุด)
const STOCK_MIN_YEARS = 2; // ประวัติ ≥ 2 ปี
const STOCK_MAX_VOL = 0.6; // ความผันผวน ≤ 60%/ปี (หุ้นผันผวนน้อยกว่าคริปโตมาก)
// รายชื่อหุ้น US สภาพคล่องสูง คละกลุ่มอุตสาหกรรม — เลือกแบบเป็นกลาง (ไม่ได้เลือกจากผลกำไรในอดีต)
// คัดเหลือ ~20 ตัว tier บน เพื่อให้โหลดเบา + ลดโอกาสโดน rate limit ของแหล่งฟรี
const STOCK_TICKERS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", // เทค/อินเทอร์เน็ต
  "JPM", "V", "MA", // การเงิน
  "UNH", "JNJ", // สุขภาพ
  "WMT", "HD", "COST", "KO", "PG", // ค้าปลีก/อุปโภคบริโภค
  "XOM", // พลังงาน
];

// Twelve Data API key (ไม่บังคับ) — ฟรี ลิมิตสูงกว่า Yahoo/Stooq มาก เสถียรกว่า
// ถ้าใส่ key จะใช้ Twelve Data เป็นแหล่งหลักของหน้าหุ้นทันที (กัน 429 จาก Yahoo)
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";

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
// ppy = แท่ง/ปี (คริปโต 365 วันรวมเสาร์-อาทิตย์ · หุ้น ~252 วันเทรด)
function runStrat(closes, stateAt, fee = 0.0004, ppy = 365) {
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
  const years = (closes.length - 1) / ppy;
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)
  );
  return {
    final: eq,
    cagr: Math.pow(eq, 1 / years) - 1,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(ppy) : 0,
    mdd,
    trades,
    state,
    years,
  };
}

// ความผันผวนต่อปี (annualized volatility) จากผลตอบแทนรายวัน
function annualVol(closes, ppy = 365) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return Math.sqrt(variance) * Math.sqrt(ppy);
}

// คำนวณทุกกลยุทธ์ของสินทรัพย์เดียว (เหรียญหรือหุ้น)
function computeCoin(sym, closes, times, ppy = 365) {
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
    rsi: runStrat(closes, stRsi, 0.0004, ppy),
    rsiEma: runStrat(closes, stRsiEma, 0.0004, ppy),
    maCross: runStrat(closes, stMa, 0.0004, ppy),
    macd: runStrat(closes, stMacd, 0.0004, ppy),
    donchian: runStrat(closes, stDon, 0.0004, ppy),
    bh: runStrat(closes, () => "LONG", 0.0004, ppy),
  };

  // หา "จุดเข้า" ของกลยุทธ์ RSI (วันที่ RSI ตัดขึ้นเหนือ 55 ครั้งล่าสุด)
  let entry = null;
  if (strat.rsi.state === "LONG") {
    let st = "CASH";
    let eIdx = null;
    for (let i = 0; i < rsi.length; i++) {
      if (rsi[i] == null) continue;
      if (rsi[i] > 55 && st !== "LONG") {
        st = "LONG";
        eIdx = i;
      } else if (rsi[i] < 45 && st !== "CASH") {
        st = "CASH";
        eIdx = null;
      }
    }
    if (eIdx != null) {
      const ep = closes[eIdx];
      const now = closes[closes.length - 1];
      const bars = closes.length - 1 - eIdx;
      entry = {
        price: ep,
        date: times ? times[eIdx] : null,
        barsHeld: bars,
        pctSinceEntry: now / ep - 1,
        isNew: bars <= 1,
      };
    }
  }

  // backtest per-trade ตลอดประวัติ: เข้าวันแรกของสัญญาณ ถือจนจบ
  const FEE = 0.0004;
  const winStart = 0; // ใช้ข้อมูลทั้งหมดเท่าที่มี (รวมตลาดหมี)
  let st2 = "CASH";
  let eIdx2 = null;
  const tradeList = [];
  for (let i = 0; i < rsi.length; i++) {
    if (rsi[i] == null) continue;
    if (rsi[i] > 55 && st2 !== "LONG") {
      st2 = "LONG";
      eIdx2 = i;
    } else if (rsi[i] < 45 && st2 !== "CASH") {
      if (st2 === "LONG" && eIdx2 != null && eIdx2 >= winStart) {
        tradeList.push({
          entry: times ? times[eIdx2] : null,
          exit: times ? times[i] : null,
          ret: (closes[i] / closes[eIdx2]) * (1 - FEE) * (1 - FEE) - 1,
          open: false,
        });
      }
      st2 = "CASH";
      eIdx2 = null;
    }
  }
  if (st2 === "LONG" && eIdx2 != null && eIdx2 >= winStart) {
    tradeList.push({
      entry: times ? times[eIdx2] : null,
      exit: null,
      ret: (closes[closes.length - 1] / closes[eIdx2]) * (1 - FEE) - 1,
      open: true,
    });
  }
  const closed = tradeList.filter((t) => !t.open);
  const bt = {
    n: closed.length,
    wins: closed.filter((t) => t.ret > 0).length,
    avgRet: closed.length ? closed.reduce((a, b) => a + b.ret, 0) / closed.length : 0,
    totalRet: tradeList.reduce((a, b) => a * (1 + b.ret), 1) - 1,
    years: (closes.length - 1) / ppy,
    list: tradeList,
  };

  return {
    sym,
    lastClose: closes[closes.length - 1],
    rsiLast: rsi[rsi.length - 1],
    avgGain,
    avgLoss,
    annVol: annualVol(closes, ppy),
    entry,
    bt,
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

// ราคาปิดรายวัน BTC เป็น Map(วันที่ -> ราคา) สำหรับกราฟ MVRV
async function binancePriceMap(symbol = "BTCUSDT", pages = 4) {
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
  const map = new Map();
  for (const x of batches.flat())
    map.set(new Date(x[0]).toISOString().slice(0, 10), parseFloat(x[4]));
  return map;
}

// ราคาปิดรายวัน + วันที่ (สำหรับหา "จุดเข้า" ของสัญญาณ)
async function binanceDaily(symbol, pages = 2) {
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
  const rows = batches.flat();
  return {
    closes: rows.map((x) => parseFloat(x[4])),
    times: rows.map((x) => new Date(x[0]).toISOString().slice(0, 10)),
  };
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
        const { closes, times } = await binanceDaily(base + "USDT", 4); // เท่าที่ Binance มี (~สูงสุด 9 ปี)
        if (closes.length < 60) continue;
        const coin = { ...computeCoin(base, closes, times), vol };
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

// ===== หุ้น US: ดึงราคาปิดรายวัน (ฟรี ไม่ต้องมี key) =====
const STOCK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// แหล่งหลัก: Yahoo Finance chart API (JSON, ประวัติยาว, ใช้ราคาปรับ split/ปันผล)
// Yahoo จำกัดอัตราเรียกแบบไม่มี session → ขอ cookie + crumb ก่อนเพื่อยกลิมิตให้สูงขึ้น
let yahooAuth = null;
async function getYahooAuth() {
  if (yahooAuth) return yahooAuth;
  let cookie = "";
  try {
    const r1 = await fetch("https://fc.yahoo.com/", {
      headers: { "user-agent": STOCK_UA },
    });
    const sc =
      typeof r1.headers.getSetCookie === "function"
        ? r1.headers.getSetCookie()
        : r1.headers.get("set-cookie")
        ? [r1.headers.get("set-cookie")]
        : [];
    cookie = sc.map((c) => c.split(";")[0]).join("; ");
  } catch {
    /* ไม่มี cookie ก็ลองต่อ */
  }
  let crumb = "";
  try {
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": STOCK_UA, cookie, accept: "text/plain" },
    });
    if (r2.ok) crumb = (await r2.text()).trim();
  } catch {
    /* บาง endpoint ไม่ต้องใช้ crumb */
  }
  yahooAuth = { cookie, crumb };
  return yahooAuth;
}

async function yahooDaily(ticker, retries = 2) {
  const { cookie, crumb } = await getYahooAuth();
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d` +
    (crumb ? `&crumb=${encodeURIComponent(crumb)}` : "");
  const headers = { "user-agent": STOCK_UA, accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429 && attempt < retries) {
      yahooAuth = null; // รีเฟรช session แล้วลองใหม่
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      const a = await getYahooAuth();
      if (a.cookie) headers.cookie = a.cookie;
      continue;
    }
    if (!r.ok) throw new Error(`Yahoo ${ticker} ${r.status}`);
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp))
      throw new Error(`Yahoo ${ticker}: ไม่มีข้อมูล`);
    const ts = result.timestamp;
    const closeArr = result.indicators?.quote?.[0]?.close || [];
    const adjArr = result.indicators?.adjclose?.[0]?.adjclose || null; // ปรับ split/ปันผล
    const closes = [];
    const times = [];
    for (let i = 0; i < ts.length; i++) {
      const c = adjArr && adjArr[i] != null ? adjArr[i] : closeArr[i];
      if (c == null || !isFinite(c) || c <= 0) continue;
      times.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      closes.push(c);
    }
    if (closes.length < 60) throw new Error(`Yahoo ${ticker}: ข้อมูลน้อยเกินไป`);
    return { closes, times };
  }
}

// แหล่งสำรอง: Stooq CSV — Date,Open,High,Low,Close,Volume (เรียงเก่า→ใหม่)
async function stooqDaily(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
    ticker.toLowerCase()
  )}.us&i=d`;
  const r = await fetch(url, { headers: { "user-agent": STOCK_UA } });
  if (!r.ok) throw new Error(`Stooq ${ticker} ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !/^date/i.test(lines[0]))
    throw new Error(`Stooq ${ticker}: ${text.slice(0, 60)}`);
  const closes = [];
  const times = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const close = parseFloat(cols[4]);
    if (!isFinite(close) || close <= 0) continue;
    times.push(cols[0]);
    closes.push(close);
  }
  return { closes, times };
}

// ดึงราคาหุ้น: ถ้ามี Twelve Data key ใช้ก่อน (เสถียรสุด) แล้วค่อย Yahoo → Stooq
async function stockDaily(ticker) {
  const errs = [];
  if (TD_KEY) {
    try {
      return await twelveDataDaily(ticker);
    } catch (e) {
      errs.push(e.message);
    }
  }
  try {
    return await yahooDaily(ticker);
  } catch (e) {
    errs.push(e.message);
  }
  try {
    return await stooqDaily(ticker);
  } catch (e) {
    errs.push(e.message);
  }
  throw new Error(errs.join(" | "));
}

// แหล่งทางเลือก: Twelve Data (ฟรี มี key · 800 ครั้ง/วัน, 8 ครั้ง/นาที) — เสถียรกว่ามาก
async function twelveDataDaily(ticker) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}` +
    `&interval=1day&outputsize=5000&apikey=${TD_KEY}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`TwelveData ${ticker} ${r.status}`);
  const j = await r.json();
  if (j.status === "error")
    throw new Error(`TwelveData ${ticker}: ${j.message || j.code}`);
  const values = j.values || [];
  if (!values.length) throw new Error(`TwelveData ${ticker}: ไม่มีข้อมูล`);
  // Twelve Data ส่งใหม่→เก่า → กลับเป็นเก่า→ใหม่
  const closes = [];
  const times = [];
  for (const v of [...values].reverse()) {
    const c = parseFloat(v.close);
    if (!isFinite(c) || c <= 0) continue;
    times.push(v.datetime);
    closes.push(c);
  }
  if (closes.length < 60) throw new Error(`TwelveData ${ticker}: ข้อมูลน้อยเกินไป`);
  return { closes, times };
}

app.get("/api/stock-signal", async (_req, res) => {
  const cached = getCached("stock-signal", 1800_000); // แคช 30 นาที (หุ้นอัปเดตวันละครั้งพอ)
  if (cached) return res.json(cached);
  try {
    const stocks = [];
    let lastErr = null;
    for (const ticker of STOCK_TICKERS) {
      try {
        const { closes, times } = await stockDaily(ticker);
        if (closes.length < 60) continue;
        const s = computeCoin(ticker, closes, times, STOCK_PPY);
        s.pass = s.years >= STOCK_MIN_YEARS && s.annVol <= STOCK_MAX_VOL;
        s.chgPct =
          closes.length > 1 ? closes[closes.length - 1] / closes[closes.length - 2] - 1 : null;
        s.lastDate = times[times.length - 1];
        stocks.push(s);
      } catch (err) {
        lastErr = err.message; // เก็บไว้บอกสาเหตุถ้าพังทั้งหมด
      }
      // Twelve Data ฟรีจำกัด 8 ครั้ง/นาที → หน่วง ~8 วิ · Yahoo/Stooq หน่วงสั้นพอ
      await new Promise((r) => setTimeout(r, TD_KEY ? 8000 : 300));
    }
    if (!stocks.length)
      throw new Error("ดึงข้อมูลหุ้นไม่ได้ (Yahoo/Stooq)" + (lastErr ? " · " + lastErr : ""));

    const passing = stocks.filter((c) => c.pass);
    const base = passing.length ? passing : stocks;

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

    const cleanStocks = stocks.map(({ strat, ...rest }) => rest);
    const data = {
      coins: cleanStocks,
      strategies,
      meta: {
        nAll: stocks.length,
        nPass: passing.length,
        minYears: STOCK_MIN_YEARS,
        maxVol: STOCK_MAX_VOL,
        trackYears: Math.max(...base.map((c) => c.years)),
        invested: base.length * 10000,
        market: "US",
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
    setCached("stock-signal", data);
    res.json(data);
  } catch (e) {
    const stale = getStale("stock-signal");
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ---- AI วิเคราะห์สัญญาณหุ้น (หน้า Stocks) ----
app.post("/api/stock-analysis", async (req, res) => {
  if (!anthropic)
    return res.status(503).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  const { summary = null } = req.body || {};
  if (!summary) return res.status(400).json({ error: "ไม่มีข้อมูลสัญญาณ" });
  const system =
    "คุณเป็นผู้ช่วยวิเคราะห์สัญญาณเทคนิคหุ้นสหรัฐเชิงการศึกษา ภาษาไทย " +
    "อธิบายภาพรวมของสัญญาณที่ให้มา (หุ้นไหนเข้าเกณฑ์ถือ/ใกล้พลิก/หลายกลยุทธ์เห็นพ้อง) อย่างเป็นกลาง " +
    "ชี้ทั้งโอกาสและความเสี่ยง ห้ามชี้นำซื้อ/ขายแบบฟันธง ปิดท้ายด้วยคำเตือนว่าไม่ใช่คำแนะนำการลงทุน";
  const userPrompt =
    "นี่คือสัญญาณ RSI/กลยุทธ์ล่าสุดของหุ้น US ที่ติดตาม ช่วยสรุปเป็นภาษาไทยอ่านง่าย:\n\n```json\n" +
    JSON.stringify(summary).slice(0, 5000) +
    "\n```\n\nจัดเป็นหัวข้อ: 1) ภาพรวมตอนนี้ 2) หุ้นที่น่าจับตา (เข้าเกณฑ์/ใกล้พลิก) 3) สิ่งที่ต้องระวัง 4) คำเตือน";
  await streamClaude(res, {
    system,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 1400,
    effort: "medium",
  });
});

// ===== MVRV (Market Value to Realized Value) จาก bitcoin-data.com (ฟรี, BTC) =====
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ดึง metric จาก bitcoin-data.com แบบยืดหยุ่น (หา field วันที่ + ค่าเอง)
async function fetchBD(slug) {
  const r = await fetch(`https://bitcoin-data.com/v1/${slug}`, {
    headers: { accept: "application/json", "user-agent": BROWSER_UA },
  });
  if (!r.ok) throw new Error(`bitcoin-data ${slug} ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error("รูปแบบข้อมูลไม่ถูกต้อง");
  return arr
    .map((it) => {
      const t =
        it.d ||
        it.theDay ||
        it.date ||
        (it.unixTs ? new Date(Number(it.unixTs) * 1000).toISOString().slice(0, 10) : null);
      let v = null;
      for (const [k, val] of Object.entries(it)) {
        if (["d", "theDay", "date", "unixTs"].includes(k)) continue;
        const n = parseFloat(val);
        if (isFinite(n)) {
          v = n;
          break;
        }
      }
      return { t, v };
    })
    .filter((x) => x.t && x.v != null);
}

// โซน/สัญญาณจาก MVRV ratio (ถ้ามี) ไม่งั้นใช้ Z-Score
function mvrvZoneCode(mvrv, z) {
  if (mvrv != null)
    return mvrv < 1 ? "BUY" : mvrv > 3 ? "STRONG_SELL" : mvrv > 2.4 ? "SELL" : "NORMAL";
  return z < 0 ? "BUY" : z > 7 ? "STRONG_SELL" : z > 5 ? "SELL" : "NORMAL";
}

app.get("/api/mvrv", async (_req, res) => {
  const key = "mvrv:btc";
  const cached = getCached(key, 3600_000); // แคช 1 ชม.
  if (cached) return res.json(cached);
  try {
    const z = await fetchBD("mvrv-zscore");
    if (z.length < 30) throw new Error("ข้อมูล MVRV ไม่พอ");

    // เสริม: MVRV ratio + realized price (bitcoin-data) + ราคา BTC (CoinGecko)
    let ratioMap = null;
    let realizedMap = null;
    let priceMap = null;
    try {
      const m = await fetchBD("mvrv");
      if (m.length) ratioMap = new Map(m.map((p) => [p.t, p.v]));
    } catch {}
    try {
      const rp = await fetchBD("realized-price");
      if (rp.length) realizedMap = new Map(rp.map((p) => [p.t, p.v]));
    } catch {}
    try {
      priceMap = await binancePriceMap("BTCUSDT", 3); // ราคาจาก Binance (เสถียร)
    } catch {
      try {
        const mk = await cgFetch(`${COINGECKO}/coins/bitcoin/market_chart?vs_currency=usd&days=max`);
        priceMap = new Map(
          (mk.prices || []).map(([ms, p]) => [new Date(ms).toISOString().slice(0, 10), p])
        );
      } catch {}
    }

    const series = z.map((p) => {
      const mvrv = ratioMap ? ratioMap.get(p.t) ?? null : null;
      return {
        t: p.t,
        z: p.v,
        mvrv,
        price: priceMap ? priceMap.get(p.t) ?? null : null,
        realized: realizedMap ? realizedMap.get(p.t) ?? null : null,
        zone: mvrvZoneCode(mvrv, p.v),
      };
    });
    const data = {
      asset: "btc",
      hasRatio: Boolean(ratioMap),
      hasRealized: Boolean(realizedMap),
      hasPrice: Boolean(priceMap),
      current: series[series.length - 1],
      series,
    };
    setCached(key, data);
    res.json(data);
  } catch (e) {
    const stale = getStale(key);
    if (stale) return res.json(stale);
    res.status(502).json({ error: e.message });
  }
});

// ===== ต้นทุนการผลิต BTC (Bitcoin production cost) vs ราคา =====
// แบบจำลองต้นทุนค่าไฟในการขุด:
//   ต้นทุน/BTC = (hashrate × ประสิทธิภาพ J/TH × วินาที/วัน → kWh) × ค่าไฟ ÷ BTC ที่ขุดได้ต่อวัน
const COST_ELEC_LOW = 0.03; // ค่าไฟถูก (best case)
const COST_ELEC_MID = 0.05; // ค่าไฟปกติ (ค่ากลาง)
const COST_ELEC_HIGH = 0.05; // ค่าไฟปกติ (worst case = เครื่องเฉลี่ยเครือข่าย)
const COST_GOOD_FACTOR = 0.6; // เครื่องรุ่นใหม่ประหยัดไฟ = ~60% ของ J/TH เฉลี่ยเครือข่าย

// ประสิทธิภาพเฉลี่ยเครือข่าย (J/TH) ตามปี — ดีขึ้นเรื่อยๆ (ค่าประมาณการ)
const COST_EFF_ANCHORS = [
  [2013, 6000], [2014, 2200], [2015, 1100], [2016, 600], [2017, 320],
  [2018, 170], [2019, 115], [2020, 80], [2021, 60], [2022, 48],
  [2023, 40], [2024, 33], [2025, 30], [2026, 28],
];
function netEffJTH(yr) {
  const a = COST_EFF_ANCHORS;
  if (yr <= a[0][0]) return a[0][1];
  if (yr >= a[a.length - 1][0]) return a[a.length - 1][1];
  for (let i = 1; i < a.length; i++) {
    if (yr <= a[i][0]) {
      const [y0, e0] = a[i - 1];
      const [y1, e1] = a[i];
      const f = (yr - y0) / (y1 - y0);
      return Math.exp(Math.log(e0) + f * (Math.log(e1) - Math.log(e0))); // interpolate แบบ log
    }
  }
  return a[a.length - 1][1];
}

const COST_HALVINGS = [
  [Date.UTC(2009, 0, 3), 50],
  [Date.UTC(2012, 10, 28), 25],
  [Date.UTC(2016, 6, 9), 12.5],
  [Date.UTC(2020, 4, 11), 6.25],
  [Date.UTC(2024, 3, 20), 3.125],
  [Date.UTC(2028, 2, 1), 1.5625],
];
function blockRewardAt(ms) {
  let r = 50;
  for (const [t, v] of COST_HALVINGS) if (ms >= t) r = v;
  return r;
}

// ต้นทุน/BTC จาก hashrate (TH/s), ประสิทธิภาพ (J/TH), ค่าไฟ ($/kWh), block reward
function costPerBTC(hashTHs, jth, elec, reward) {
  const dailyKWh = (hashTHs * jth * 86400) / 3.6e6; // J/วัน → kWh/วัน
  const btcPerDay = 144 * reward; // ~144 บล็อก/วัน
  return (dailyKWh * elec) / btcPerDay;
}

// ดึงกราฟจาก blockchain.info (ฟรี ไม่ต้องมี key) — [{x: unixSec, y: number}]
async function bcChart(name) {
  const r = await fetch(
    `https://api.blockchain.info/charts/${name}?timespan=all&format=json&sampled=false&cors=true`,
    { headers: { accept: "application/json", "user-agent": BROWSER_UA } }
  );
  if (!r.ok) throw new Error(`blockchain.info ${name} ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.values)) throw new Error(`blockchain.info ${name}: รูปแบบข้อมูลผิด`);
  return j.values;
}

app.get("/api/btc-cost", async (_req, res) => {
  const key = "btc-cost";
  const cached = getCached(key, 6 * 3600_000); // แคช 6 ชม.
  if (cached) return res.json(cached);
  try {
    const [priceVals, hashVals] = await Promise.all([
      bcChart("market-price"),
      bcChart("hash-rate"),
    ]);
    if (priceVals.length < 100 || hashVals.length < 50)
      throw new Error("ข้อมูลจาก blockchain.info ไม่พอ");

    // hashrate: เรียงตามเวลา เพื่อ forward-fill ให้ตรงกับวันที่ของราคา
    const hr = hashVals.map((p) => ({ t: p.x, y: p.y })).sort((a, b) => a.t - b.t);
    let hi = 0;
    const series = [];
    for (const p of priceVals) {
      const price = p.y;
      if (!price || price <= 0) continue;
      const ms = p.x * 1000;
      while (hi + 1 < hr.length && hr[hi + 1].t <= p.x) hi++;
      const hashTHs = hr[hi] ? hr[hi].y : null;
      if (!hashTHs || hashTHs <= 0) continue;
      const yr = ms / 31557600000 + 1970; // ปีแบบเศษ
      const reward = blockRewardAt(ms);
      const netJ = netEffJTH(yr);
      const goodJ = netJ * COST_GOOD_FACTOR;
      series.push({
        t: new Date(ms).toISOString().slice(0, 10),
        price,
        low: costPerBTC(hashTHs, goodJ, COST_ELEC_LOW, reward), // best (ถูกสุด)
        mid: costPerBTC(hashTHs, goodJ, COST_ELEC_MID, reward),
        high: costPerBTC(hashTHs, netJ, COST_ELEC_HIGH, reward), // worst (แพงสุด)
        hash: hashTHs,
        reward,
      });
    }
    if (!series.length) throw new Error("คำนวณต้นทุนไม่ได้");

    const cur = series[series.length - 1];
    const nowYr = Date.now() / 31557600000 + 1970;
    const data = {
      current: {
        t: cur.t,
        price: cur.price,
        low: cur.low,
        mid: cur.mid,
        high: cur.high,
        hash: cur.hash,
        reward: cur.reward,
        marginMid: cur.price / cur.mid - 1,
      },
      assumptions: {
        elecLow: COST_ELEC_LOW,
        elecMid: COST_ELEC_MID,
        elecHigh: COST_ELEC_HIGH,
        netJTH: Math.round(netEffJTH(nowYr)),
        goodJTH: Math.round(netEffJTH(nowYr) * COST_GOOD_FACTOR),
      },
      halvings: ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"],
      series,
      updatedAt: Date.now(),
    };
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
  console.log(
    TD_KEY
      ? "💵 หุ้น US: ใช้ Twelve Data key (เสถียร ไม่ค่อยโดน 429 · โหลดครั้งแรก ~2-3 นาที)"
      : "💵 หุ้น US: ใช้ Yahoo/Stooq ฟรี (ถ้าโดน 429 บ่อย ใส่ TWELVEDATA_API_KEY เพื่อแก้)"
  );
});
