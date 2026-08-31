import { WebSocket, WebSocketServer } from "ws";
import {
  buildQwenOmniRealtimeUpstreamUrl,
  getQwenOmniRealtimeEnv
} from "./qwenOmniRealtimeEnv.js";

const DEFAULT_RELAY_PATH = "/api/qwen-omni-realtime/relay";
const MAX_RELAY_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INITIAL_CLIENT_QUEUE_MESSAGES = 12;
const MAX_INITIAL_CLIENT_QUEUE_BYTES = 256 * 1024;
const MAX_UPSTREAM_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;

let relayCounter = 0;

export function createQwenOmniRealtimeRelay({
  env = process.env,
  path = DEFAULT_RELAY_PATH,
  logger = () => {}
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_PAYLOAD_BYTES });

  wss.on("connection", (browserSocket, request) => {
    const relayId = ++relayCounter;
    const config = getQwenOmniRealtimeEnv(env);
    if (!config.enabled || !config.configured) {
      browserSocket.close(1011, "Qwen Omni Realtime relay is not configured.");
      return;
    }

    const upstreamSocket = new WebSocket(buildQwenOmniRealtimeUpstreamUrl(env), {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "x-dashscope-dataInspection": "disable"
      },
      perMessageDeflate: false,
      maxPayload: MAX_RELAY_PAYLOAD_BYTES
    });
    const queue = [];
    let queuedBytes = 0;
    let upstreamOpen = false;
    let closed = false;
    let browserAlive = true;
    let upstreamAlive = true;
    let inputAudioFrames = 0;
    let inputAudioBytes = 0;
    let outputAudioFrames = 0;
    let outputAudioBytes = 0;
    let outputAudioDeltas = 0;
    const clientEventTypes = [];
    const upstreamEventTypes = [];
    const heartbeatTimer = setInterval(() => {
      if (closed) return;
      if (browserSocket.readyState === WebSocket.OPEN) {
        if (!browserAlive) return closePair(1011, "Agent relay client heartbeat timed out.");
        browserAlive = false;
        safePing(browserSocket);
      }
      if (upstreamSocket.readyState === WebSocket.OPEN) {
        if (!upstreamAlive) return closePair(1011, "Agent relay upstream heartbeat timed out.");
        upstreamAlive = false;
        safePing(upstreamSocket);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    logger(`QWEN RELAY ${relayId} open client=${request.socket?.remoteAddress ?? "unknown"} model=${config.model}`);

    upstreamSocket.on("open", () => {
      upstreamOpen = true;
      while (queue.length && upstreamSocket.readyState === WebSocket.OPEN) {
        const entry = queue.shift();
        queuedBytes -= entry.bytes;
        if (entry.droppable && isSocketBackpressured(upstreamSocket)) continue;
        upstreamSocket.send(entry.payload, { binary: entry.isBinary });
      }
    });
    upstreamSocket.on("message", (data, isBinary) => {
      upstreamAlive = true;
      if (isBinary) {
        outputAudioFrames += 1;
        outputAudioBytes += Number(data?.length || 0);
      } else {
        const parsed = safeParse(normalizePayload(data, isBinary));
        const type = String(parsed?.type || "unknown");
        if (type === "response.audio.delta") {
          outputAudioDeltas += 1;
        } else {
          upstreamEventTypes.push(type);
          if (type === "error") {
            logger(`QWEN RELAY ${relayId} upstream ERROR event=${shortLogText(JSON.stringify(parsed?.error ?? parsed), 400)}`, "warn");
          } else {
            logger(`QWEN RELAY ${relayId} upstream->client type=${type}`);
          }
        }
      }
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
    });
    upstreamSocket.on("pong", () => { upstreamAlive = true; });
    upstreamSocket.on("error", (error) => {
      logger(`QWEN RELAY ${relayId} upstream error="${shortLogText(error.message)}"`, "warn");
      closePair(1011, "Agent upstream error.");
    });
    upstreamSocket.on("close", (code, reason) => {
      closePair(code || 1000, normalizeCloseReason(reason) || "Agent upstream closed.");
    });

    browserSocket.on("message", (data, isBinary) => {
      browserAlive = true;
      const payload = normalizePayload(data, isBinary);
      if (!isBinary) {
        const parsed = safeParse(payload);
        const type = String(parsed?.type || "unknown");
        if (type === "input_audio_buffer.append") {
          inputAudioFrames += 1;
          inputAudioBytes += estimatePayloadBytes(payload);
          if (inputAudioFrames === 1) {
            logger(`QWEN RELAY ${relayId} client first mic audio frame received`);
          }
        } else {
          clientEventTypes.push(type);
          logger(`QWEN RELAY ${relayId} client->upstream type=${type}${type === "session.update" ? ` voice=${parsed?.session?.voice ?? "?"} tools=${Array.isArray(parsed?.session?.tools) ? parsed.session.tools.length : 0}` : ""}`);
        }
      } else {
        inputAudioFrames += 1;
        inputAudioBytes += Number(data?.length || 0);
      }
      const droppable = isDroppableRealtimeMedia(payload, isBinary);
      if (upstreamOpen && upstreamSocket.readyState === WebSocket.OPEN) {
        if (droppable && isSocketBackpressured(upstreamSocket)) return;
        upstreamSocket.send(payload, { binary: isBinary });
        return;
      }
      if (droppable) return;
      const bytes = estimatePayloadBytes(payload);
      if (queue.length >= MAX_INITIAL_CLIENT_QUEUE_MESSAGES || queuedBytes + bytes > MAX_INITIAL_CLIENT_QUEUE_BYTES) {
        closePair(1009, "Agent relay queue overflow.");
        return;
      }
      queue.push({ payload, isBinary, bytes, droppable });
      queuedBytes += bytes;
    });
    browserSocket.on("pong", () => { browserAlive = true; });
    browserSocket.on("error", () => closePair(1011, "Agent relay client error."));
    browserSocket.on("close", (code, reason) => {
      closePair(code || 1000, normalizeCloseReason(reason) || "Agent client closed.");
    });

    function closePair(code = 1000, reason = "Agent relay closed.") {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      queue.length = 0;
      queuedBytes = 0;
      safeClose(browserSocket, code, reason);
      safeClose(upstreamSocket, code, reason);
      logger(`QWEN RELAY ${relayId} closed code=${code} reason="${shortLogText(reason)}"`);
      logger(
        `QWEN RELAY ${relayId} SUMMARY clientEvents=[${clientEventTypes.join(",")}] upstreamEvents=[${upstreamEventTypes.join(",")}] micAudio=${inputAudioFrames}frames/${inputAudioBytes}B replyAudio=${outputAudioFrames}binary+${outputAudioDeltas}deltas/${outputAudioBytes}B`
      );
    }
  });

  return {
    path,
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    },
    close(callback) { wss.close(callback); }
  };
}

export function buildQwenOmniRealtimeRelaySession({ request, env = process.env, path = DEFAULT_RELAY_PATH } = {}) {
  const config = getQwenOmniRealtimeEnv(env);
  return {
    ok: true,
    transport: "server_relay",
    provider: "qwen_omni_realtime",
    websocketUrl: buildSameOriginWebSocketUrl(request, path),
    model: config.model,
    voice: config.voice,
    inputAudioFormat: "pcm16;rate=16000",
    outputAudioFormat: "pcm16;rate=24000"
  };
}

function buildSameOriginWebSocketUrl(request, path) {
  const proto = String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (request?.socket?.encrypted ? "https" : "http");
  const host = request?.headers?.["x-forwarded-host"] || request?.headers?.host || "localhost";
  return `${proto === "https" ? "wss" : "ws"}://${host}${path}`;
}

function safeParse(payload) {
  try {
    return typeof payload === "string" ? JSON.parse(payload) : null;
  } catch (_error) {
    return null;
  }
}

function normalizePayload(data, isBinary) {
  if (isBinary || typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data;
}

function isDroppableRealtimeMedia(payload, isBinary) {
  if (isBinary || typeof payload !== "string") return false;
  try {
    return JSON.parse(payload)?.type === "input_audio_buffer.append";
  } catch (_error) {
    return false;
  }
}

function estimatePayloadBytes(payload) {
  return typeof payload === "string" ? Buffer.byteLength(payload) : Number(payload?.byteLength || payload?.length || 0);
}

function isSocketBackpressured(socket) {
  return Number(socket?.bufferedAmount || 0) >= MAX_UPSTREAM_BUFFERED_BYTES;
}

function safePing(socket) {
  try { socket.ping?.(); } catch (_error) { /* close handlers clean up the pair */ }
}

function safeClose(socket, code, reason) {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try {
    socket.close(normalizeCloseCode(code), String(reason || "closed").slice(0, 120));
  } catch (_error) {
    try { socket.terminate?.(); } catch (_terminateError) { /* best effort */ }
  }
}

function normalizeCloseCode(code) {
  const numeric = Number(code);
  return numeric === 1000 || (numeric >= 3000 && numeric <= 4999) ? numeric : 1011;
}

function normalizeCloseReason(reason) {
  return Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
}

function shortLogText(value, maxLength = 180) {
  return normalizeCloseReason(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}
