import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const COINGECKO = "https://api.coingecko.com/api/v3";

// สร้าง client เฉพาะเมื่อมี ANTHROPIC_API_KEY (อ่านจาก env อัตโนมัติ)
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

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

async function cgFetch(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`CoinGecko ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// ---- ดึงรายการเหรียญ + ราคา (ตลาดรวม) ----
app.get("/api/markets", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const key = `markets:${vs}`;
  const cached = getCached(key, 30_000); // แคช 30 วิ
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
    res.status(502).json({ error: e.message });
  }
});

// ---- ดึงข้อมูลกราฟราคาของเหรียญเดียว ----
app.get("/api/coin/:id/chart", async (req, res) => {
  const vs = (req.query.vs || "usd").toLowerCase();
  const days = String(req.query.days || "7");
  const id = encodeURIComponent(req.params.id);
  const key = `chart:${id}:${vs}:${days}`;
  const cached = getCached(key, 60_000); // แคช 60 วิ
  if (cached) return res.json(cached);

  const url = `${COINGECKO}/coins/${id}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(days)}`;
  try {
    const data = await cgFetch(url);
    setCached(key, data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- บอกหน้าเว็บว่ามี Claude พร้อมใช้ไหม ----
app.get("/api/status", (_req, res) => {
  res.json({ aiEnabled: Boolean(anthropic) });
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
