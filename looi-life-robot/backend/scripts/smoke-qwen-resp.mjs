// 带 tools + 强制 response.create，看响应生成是否触发上游关闭
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";
const HOLD_MS = 35000;

const tools = [
  {
    type: "function",
    function: {
      name: "run_scenario",
      description: "Run one approved local LOOI scenario from explicit user intent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["come_closer", "back_up", "look_left", "look_right", "tell_me_about_yourself"] },
          label: { type: "string" },
          mode: { type: "string", enum: ["gentle", "curious", "cautious"] },
          reason: { type: "string" }
        },
        required: ["name"]
      }
    }
  }
];

const ws = new WebSocket(RELAY_URL);
let start = 0;
const events = [];
let lastMsgAt = 0;
let respCreated = 0;

ws.on("open", () => {
  start = Date.now();
  console.log(`[+0ms] session.update WITH tools (voice=Tina)`);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "你是LOOI，桌面小同伴。用中文简短回复。用户让你动就调 run_scenario。",
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" },
      tools
    }
  }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { events.push("binary"); return; }
  let parsed;
  try { parsed = JSON.parse(String(data)); } catch { return; }
  const t = parsed.type || "?";
  lastMsgAt = Date.now() - start;
  events.push(t);
  if (t === "error") {
    console.log(`[+${lastMsgAt}ms] ❌ ERROR ${JSON.stringify(parsed.error || parsed).slice(0,600)}`);
  } else if (t === "session.updated") {
    console.log(`[+${lastMsgAt}ms] session.updated, 触发 response.create`);
    ws.send(JSON.stringify({ type: "response.create", response: { instructions: "用一句话介绍你自己" } }));
    respCreated++;
  } else if (t.startsWith("response.")) {
    console.log(`[+${lastMsgAt}ms] ${t}${t === "response.function_call_arguments.delta" ? "" : ""}`);
  } else if (t === "response.audio.done" || t === "response.done") {
    console.log(`[+${lastMsgAt}ms] ✅ ${t}`);
  } else {
    console.log(`[+${lastMsgAt}ms] type=${t}`);
  }
});

ws.on("close", (code, reason) => {
  const elapsed = Date.now() - start;
  console.log(`\n[+${elapsed}ms] CLOSED code=${code} reason="${String(reason||"")}"`);
  console.log(`events=[${events.join(",")}] lastMsgAt=+${lastMsgAt}ms respCreated=${respCreated}`);
  console.log(elapsed < HOLD_MS ? `RESULT: ❌ 在 ${elapsed}ms 被关闭（掉线复现）` : `RESULT: ✅ 保持到 ${elapsed}ms`);
  process.exit(0);
});

ws.on("error", (e) => { console.log(`[WS ERROR] ${e.message}`); process.exit(1); });

setTimeout(() => {
  console.log(`\n[+${HOLD_MS}ms] TIMEOUT`);
  try { ws.close(1000); } catch {}
  setTimeout(() => process.exit(0), 500);
}, HOLD_MS);
