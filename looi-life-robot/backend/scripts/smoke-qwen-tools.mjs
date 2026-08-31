// 复现前端完整 session.update（含 tools，嵌套 function 格式），观察百炼所有事件
import { WebSocket } from "ws";

const RELAY_URL = "ws://localhost:3002/api/qwen-omni-realtime/relay";

// 与前端 buildQwenOmniRealtimeSetup 完全一致的结构（嵌套 function 格式）
const nestedTools = [
  {
    type: "function",
    function: {
      name: "run_scenario",
      description: "Run one approved local LOOI scenario from explicit user intent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          label: { type: "string" },
          mode: { type: "string", enum: ["gentle", "curious", "cautious"] },
          reason: { type: "string" }
        },
        required: ["name"]
      }
    }
  }
];

// OpenAI Realtime 规范的扁平格式
const flatTools = [
  {
    type: "function",
    name: "run_scenario",
    description: "Run one approved local LOOI scenario from explicit user intent.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string" },
        mode: { type: "string", enum: ["gentle", "curious", "cautious"] },
        reason: { type: "string" }
      },
      required: ["name"]
    }
  }
];

const useFlat = process.argv[2] === "flat";
const tools = useFlat ? flatTools : nestedTools;
console.log(`[TEST] tools format = ${useFlat ? "FLAT (OpenAI Realtime 规范)" : "NESTED (前端当前格式)"}`);

const ws = new WebSocket(RELAY_URL);
let done = false;

function finish(code) {
  if (!done) { done = true; try { ws.close(1000); } catch {} setTimeout(() => process.exit(code), 300); }
}

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: "You are LOOI, a friendly desktop companion. Reply briefly.",
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" },
      tools
    }
  }));
  console.log("[TEST] sent session.update with tools");
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { console.log("[MSG] binary frame", data.length, "bytes"); return; }
  let parsed;
  try { parsed = JSON.parse(String(data)); } catch { console.log("[MSG-RAW]", String(data).slice(0, 300)); return; }
  const t = parsed.type || "?";
  if (t === "error") {
    console.log(`[ERROR EVENT] ${JSON.stringify(parsed.error || parsed).slice(0, 500)}`);
    console.log(`[RESULT] ❌ ${useFlat ? "扁平格式也被拒绝" : "嵌套格式被拒绝（这就是对话失败的原因）"}`);
    finish(1);
    return;
  }
  console.log(`[MSG] type=${t}${t === "session.updated" ? ` voice=${parsed.session?.voice} tools=${Array.isArray(parsed.session?.tools) ? parsed.session.tools.length : "none"}` : ""}`);
  if (t === "session.updated") {
    console.log(`[RESULT] ✅ ${useFlat ? "扁平格式" : "嵌套格式"}被接受，session 配置成功`);
  }
});

ws.on("close", (code, reason) => {
  console.log(`[CLOSED] code=${code} reason="${String(reason || "")}"`);
  finish(0);
});

ws.on("error", (e) => { console.log("[WS ERROR]", e.message); finish(1); });

setTimeout(() => { console.log("[TIMEOUT] 6s no close"); finish(0); }, 6000);
