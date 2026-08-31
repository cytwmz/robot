// 模拟前端推音频：session.update → 流式推 PCM16@16kHz → commit，复现 30s 掉线
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";
const HOLD_MS = 40000;
const FRAME_MS = 200;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = Math.round(SAMPLE_RATE * FRAME_MS / 1000); // 3200 samples

const ws = new WebSocket(RELAY_URL);
let start = 0;
const events = [];
let lastMsgAt = 0;
let audioFramesSent = 0;
let audioDeltas = 0;

ws.on("open", () => {
  start = Date.now();
  console.log(`[+0ms] connected, sending session.update (voice=Tina, semantic_vad)`);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "你是LOOI，一个桌面小同伴，简短中文回复。",
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" }
    }
  }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { audioDeltas++; return; }
  let parsed;
  try { parsed = JSON.parse(String(data)); } catch { return; }
  const t = parsed.type || "?";
  lastMsgAt = Date.now() - start;
  events.push(t);
  if (t === "error") {
    console.log(`[+${lastMsgAt}ms] ❌ ERROR ${JSON.stringify(parsed.error || parsed).slice(0,600)}`);
  } else if (t === "session.updated") {
    console.log(`[+${lastMsgAt}ms] session.updated voice=${parsed.session?.voice}, 开始推静音音频帧`);
    startStreaming();
  } else if (t === "response.audio.delta") {
    // counted via binary
  } else if (t === "response.audio.done" || t === "response.done" || t === "response.cancelled") {
    console.log(`[+${lastMsgAt}ms] ${t}`);
  } else if (t.startsWith("response.")) {
    console.log(`[+${lastMsgAt}ms] ${t}`);
  } else {
    console.log(`[+${lastMsgAt}ms] type=${t}`);
  }
});

ws.on("close", (code, reason) => {
  const elapsed = Date.now() - start;
  console.log(`\n[+${elapsed}ms] CLOSED code=${code} reason="${String(reason||"")}"`);
  console.log(`events=[${events.join(",")}] audioSent=${audioFramesSent}frames audioDeltas=${audioDeltas} lastMsgAt=+${lastMsgAt}ms`);
  console.log(elapsed < HOLD_MS ? `RESULT: ❌ 在 ${elapsed}ms 被关闭（掉线复现）` : `RESULT: ✅ 保持到 ${elapsed}ms`);
  process.exit(0);
});

ws.on("error", (e) => { console.log(`[WS ERROR] ${e.message}`); process.exit(1); });

function startStreaming() {
  // 静音 PCM16 帧（小端 16-bit 有符号），模拟麦克风持续推流
  const frame = Buffer.alloc(FRAME_SAMPLES * 2, 0);
  const b64 = frame.toString("base64");

  const timer = setInterval(() => {
    if (Date.now() - start > HOLD_MS) { clearInterval(timer); try { ws.close(1000); } catch {} return; }
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(timer); return; }
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    audioFramesSent++;
    // 每 2 秒 commit 一次，触发响应
    if (audioFramesSent % 10 === 0) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log(`[+${Date.now()-start}ms] pushed ${audioFramesSent} frames, sent commit`);
    }
  }, FRAME_MS);
}

setTimeout(() => {
  console.log(`\n[+${HOLD_MS}ms] TIMEOUT reached`);
  try { ws.close(1000); } catch {}
  setTimeout(() => process.exit(0), 500);
}, HOLD_MS);
