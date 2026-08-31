import assert from "node:assert/strict";
import { getQwenOmniRealtimeEnv, buildQwenOmniRealtimeUpstreamUrl } from "../lib/qwen/qwenOmniRealtimeEnv.js";
import { buildQwenOmniRealtimeRelaySession } from "../lib/qwen/qwenOmniRealtimeRelay.js";
import { GeminiLiveRuntime, arrayBufferToBase64, float32ToPcm16 } from "../../frontend/js/gemini/geminiLiveRuntime.js";
import { buildQwenOmniRealtimeSetup } from "../../frontend/js/gemini/geminiLiveTools.js";

if (typeof globalThis.btoa !== "function") {
  globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
}
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

const env = {
  DASHSCOPE_API_KEY: "test-key",
  QWEN_OMNI_REALTIME_ENABLED: "true"
};
const config = getQwenOmniRealtimeEnv(env);
assert.equal(config.enabled, true);
assert.equal(config.configured, true);
assert.equal(config.model, "qwen3.5-omni-flash-realtime");
assert.equal(buildQwenOmniRealtimeUpstreamUrl(env),
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime");

const relaySession = buildQwenOmniRealtimeRelaySession({
  request: { headers: { host: "looi.example.test" }, socket: {} },
  env
});
assert.equal(relaySession.websocketUrl, "ws://looi.example.test/api/qwen-omni-realtime/relay");
assert.equal("apiKey" in relaySession, false);

const setup = buildQwenOmniRealtimeSetup();
assert.equal(setup.type, "session.update");
assert.equal(setup.session.input_audio_format, "pcm");
assert.equal(setup.session.output_audio_format, "pcm");
assert.equal(setup.session.turn_detection.type, "semantic_vad");
assert.equal(setup.session.tools[0].function.name, "run_scenario");

class FakeAudioContext {
  static instances = [];

  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48_000;
    this.state = "running";
    this.destination = {};
    FakeAudioContext.instances.push(this);
  }

  createBuffer(_channels, length, sampleRate) {
    return { duration: length / sampleRate, copyToChannel() {} };
  }

  createBufferSource() {
    return {
      connect() {},
      start() { setTimeout(() => this.onended?.(), 0); },
      stop() { this.onended?.(); },
      onended: null
    };
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createScriptProcessor() {
    const processor = {
      connect() {},
      disconnect() {},
      onaudioprocess: null,
      emit(samples) {
        this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    };
    this.inputProcessor = processor;
    return processor;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  resume() { return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

const sent = [];
const actions = [];
const runtime = new GeminiLiveRuntime({
  fetchToken: async () => ({
    ok: true,
    transport: "server_relay",
    provider: "qwen_omni_realtime",
    websocketUrl: "wss://example.invalid/api/qwen-omni-realtime/relay",
    model: "qwen3.5-omni-flash-realtime",
    voice: "Ethan"
  }),
  transportFactory: ({ onOpen, onMessage }) => {
    const transport = {
      readyState: 1,
      bufferedAmount: 0,
      send(data) {
        const event = JSON.parse(data);
        sent.push(event);
        if (event.type === "session.update") {
          setTimeout(() => onMessage({ data: JSON.stringify({ type: "session.updated" }) }), 0);
        }
      },
      close() { this.readyState = 3; }
    };
    setTimeout(() => onOpen({}), 0);
    runtimeReceive = (event) => onMessage({ data: JSON.stringify(event) });
    return transport;
  },
  mediaDevices: {
    getUserMedia: async () => ({
      getTracks: () => [{ readyState: "live", stop() { this.readyState = "ended"; } }]
    })
  },
  audioContextFactory: () => FakeAudioContext,
  toolExecutor: {
    executeAction: async (action) => {
      actions.push(action);
      return { status: "completed", executed: true, physical: true, message: "ok" };
    }
  }
});
let runtimeReceive = () => {};

runtime.configure({
  qwenOmniRealtimeEnabled: true,
  qwenOmniRealtimeConfigured: true,
  qwenOmniRealtimeModel: "qwen3.5-omni-flash-realtime",
  qwenOmniRealtimeVoice: "Ethan"
});
await runtime.start({ captureAudio: true });
await wait(10);
assert.equal(runtime.getStatus().setupComplete, true);
assert.ok(sent.some((event) => event.type === "session.update"));
assert.equal(sent.find((event) => event.type === "session.update").session.voice, "Ethan");

FakeAudioContext.instances.at(-1).inputProcessor.emit(new Float32Array([0.1, -0.1, 0.2, -0.2]));
assert.ok(sent.some((event) => event.type === "input_audio_buffer.append" && event.audio));

const pcm = float32ToPcm16(new Float32Array([0, 0.2, -0.2, 0.1]));
runtimeReceive({
  type: "conversation.item.input_audio_transcription.completed",
  transcript: "向左看"
});
runtimeReceive({ type: "response.audio_transcript.done", transcript: "好的。" });
runtimeReceive({ type: "response.audio.delta", delta: arrayBufferToBase64(pcm.buffer) });
runtimeReceive({
  type: "response.function_call_arguments.done",
  call_id: "call_left",
  name: "move_gimbal",
  arguments: JSON.stringify({ direction: "left", degrees: 10 })
});
await wait(20);
assert.equal(runtime.getStatus().lastInputTranscript, "向左看");
assert.equal(runtime.getStatus().lastOutputTranscript, "好的。");
assert.equal(actions.at(-1).type, "move_gimbal");
assert.equal(actions.at(-1).args.direction, "left");
assert.ok(sent.some((event) => event.type === "conversation.item.create" && event.item.call_id === "call_left"));
assert.ok(sent.filter((event) => event.type === "response.create").length >= 1);

runtimeReceive({ type: "response.done" });
await wait(10);
assert.equal(runtime.getStatus().turnActive, false);
await runtime.stop("smoke_done");

console.log("smoke:qwen-omni-realtime passed");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
