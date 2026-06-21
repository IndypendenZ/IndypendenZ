#!/bin/bash
# ดับเบิลคลิกไฟล์นี้บน Mac เพื่อเปิด CryptoDash
# (ถ้ากดแล้ว Terminal เด้งขึ้นแล้วรันเลย = ถูกต้อง · ปิดเว็บ = ปิดหน้าต่าง Terminal นี้)

cd "$(dirname "$0")"

echo "🚀 กำลังเริ่ม CryptoDash…"

# ติดตั้งไลบรารีครั้งแรก (ถ้ายังไม่มี)
if [ ! -d node_modules ]; then
  echo "📦 ติดตั้งไลบรารีครั้งแรก (รอสักครู่)…"
  npm install
fi

# เปิดเบราว์เซอร์อัตโนมัติหลังเซิร์ฟเวอร์เริ่ม
( sleep 2 && open "http://localhost:8080" ) &

# รันเซิร์ฟเวอร์ (อ่าน .env ถ้ามี เพื่อโหลด API key)
if [ -f .env ]; then
  node --env-file=.env server.js
else
  node server.js
fi
