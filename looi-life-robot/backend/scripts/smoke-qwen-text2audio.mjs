// 测试：realtime 会话里发文本用户消息，看 Qwen 是否回音频（隔离 VAD 问题）
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";
const vadType = process.argv[2] || "semantic_vad";

const ws = new WebSocket(RELAY_URL);
let done = false;
let audioBytes = 0;

function finish(code) {
  if (!done) { done = true; try { ws.close(1000); } catch {} setTimeout(() => process.exit(code), 300); }
}

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "You are LOOI. Reply in one short sentence.",
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: vadType },
    }
  }));
  console.log(`[TEST] session.update sent (turn_detection=${vadType})`);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { audioBytes += data.length; return; }
  let parsed;
  try { parsed = JSON.parse(String(data)); } catch { return; }
  const t = parsed.type || "?";
  if (t === "response.audio.delta") { audioBytes += 1; return; }
  if (t === "error") { console.log(`[ERROR] ${JSON.stringify(parsed.error || parsed).slice(0, 400)}`); return; }
  console.log(`[MSG] ${t}${t === "response.audio_transcript.done" ? ` transcript="${parsed.transcript}"` : ""}${t === "response.done" ? ` audioBytes=${audioBytes}` : ""}`);
  if (t === "session.updated") {
    console.log("[TEST] sending text user message + response.create");
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "你好，请用一句话介绍自己" }] }
    }));
    ws.send(JSON.stringify({ type: "response.create" }));
  }
  if (t === "response.done") {
    console.log(audioBytes > 0 ? "[RESULT] ✅ 文本进→音频出 正常，问题在 VAD/麦克风音频" : "[RESULT] ❌ 无音频返回");
    finish(0);
  }
});

ws.on("close", (code, reason) => { console.log(`[CLOSED] ${code} ${String(reason || "")}`); finish(0); });
ws.on("error", (e) => { console.log("[WS ERROR]", e.message); finish(1); });
setTimeout(() => { console.log(`[TIMEOUT] 15s, audioBytes=${audioBytes}`); finish(audioBytes > 0 ? 0 : 1); }, 15000);
