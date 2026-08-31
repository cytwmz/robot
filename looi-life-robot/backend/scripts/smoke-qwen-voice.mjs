// 验证 Qwen-Omni Realtime 中继是否能用 voice=Tina 成功握手
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";
const VOICE = process.argv[2] || "Tina";

const ws = new WebSocket(RELAY_URL);
let closed = false;
let setupOk = false;
let firstError = null;

ws.on("open", () => {
  console.log(`[CLIENT] connected relay, sending session.update voice=${VOICE}`);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "You are a helpful assistant.",
      voice: VOICE,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" }
    }
  }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) return; // 音频帧不打印
  const text = String(data);
  let parsed;
  try { parsed = JSON.parse(text); } catch { console.log("[MSG-RAW]", text.slice(0, 200)); return; }
  const t = parsed.type || parsed.event || "?";
  console.log(`[MSG] type=${t}`);
  if (parsed.type === "session.updated" || parsed.type === "ready" || parsed.type === "session.update") {
    setupOk = true;
    console.log("[RESULT] ✅ 握手成功，音色", VOICE, "被接受");
  }
  if (parsed.type === "error" || parsed.error) {
    firstError = parsed.error?.message || parsed.error || JSON.stringify(parsed).slice(0, 300);
    console.log(`[ERR] ${firstError}`);
  }
});

ws.on("close", (code, reason) => {
  closed = true;
  const r = String(reason || "");
  console.log(`[CLOSED] code=${code} reason="${r}"`);
  if (code === 1007 || /not supported|InvalidParameter/i.test(r)) {
    console.log(`[RESULT] ❌ 音色 ${VOICE} 被百炼拒绝`);
  } else if (code === 1000 && setupOk) {
    console.log("[RESULT] ✅ 正常关闭");
  }
  process.exit(0);
});

ws.on("error", (e) => { console.log("[WS ERROR]", e.message); });

// 5 秒后主动收尾（握手成功就够说明问题）
setTimeout(() => {
  if (!closed) {
    console.log(`[RESULT] ${setupOk ? "✅ 握手成功" : "⚠️ 5秒内未收到 session.updated，但连接未断（可能正常）"}`);
    ws.close(1000, "test done");
  }
}, 5000);
