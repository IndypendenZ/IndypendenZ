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
});
