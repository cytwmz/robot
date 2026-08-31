// 长连接测试：发 session.update 后保持 45s，观察百炼是否主动关闭、close code/reason
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";
const HOLD_MS = Number(process.argv[2] || 45000);

const ws = new WebSocket(RELAY_URL);
let start = 0;
let lastMsgAt = 0;
const events = [];

ws.on("open", () => {
  start = Date.now();
  console.log(`[+0ms] connected, sending session.update (voice=Tina, no tools)`);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "You are LOOI. Reply briefly in Chinese.",
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" }
    }
  }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { console.log(`[+${Date.now()-start}ms] binary frame ${data.length}B`); return; }
  let parsed;
  try { parsed = JSON.parse(String(data)); } catch { console.log(`[+${Date.now()-start}ms] RAW ${String(data).slice(0,200)}`); return; }
  const t = parsed.type || "?";
  lastMsgAt = Date.now() - start;
  events.push(t);
  if (t === "error") {
    console.log(`[+${lastMsgAt}ms] ❌ ERROR ${JSON.stringify(parsed.error || parsed).slice(0,500)}`);
  } else {
    console.log(`[+${lastMsgAt}ms] type=${t}`);
  }
});

ws.on("close", (code, reason) => {
  const elapsed = Date.now() - start;
  console.log(`\n[+${elapsed}ms] CLOSED code=${code} reason="${String(reason||"")}"`);
  console.log(`events=[${events.join(",")}] lastMsgAt=+${lastMsgAt}ms`);
  console.log(elapsed < HOLD_MS && code !== 1000 ? `RESULT: ❌ 上游在 ${elapsed}ms 主动关闭（这就是掉线原因）` : `RESULT: ✅ 保持到 ${elapsed}ms`);
  process.exit(0);
});

ws.on("error", (e) => { console.log(`[WS ERROR] ${e.message}`); process.exit(1); });

setTimeout(() => {
  console.log(`\n[+${HOLD_MS}ms] TIMEOUT reached, closing cleanly`);
  try { ws.close(1000); } catch {}
  setTimeout(() => process.exit(0), 500);
}, HOLD_MS);
