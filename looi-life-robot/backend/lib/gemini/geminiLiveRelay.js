import { WebSocket, WebSocketServer } from "ws";
import { getGeminiLiveEnv } from "./geminiLiveToken.js";

const DEFAULT_API_VERSION = "v1beta";
const DEFAULT_WEBSOCKET_BASE_URL = "wss://generativelanguage.googleapis.com";
const DEFAULT_RELAY_PATH = "/api/gemini-live/relay";
const MAX_RELAY_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INITIAL_CLIENT_QUEUE_MESSAGES = 12;
const MAX_INITIAL_CLIENT_QUEUE_BYTES = 256 * 1024;
const MAX_UPSTREAM_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;

let relayCounter = 0;

export function createGeminiLiveRelay({
  env = process.env,
  path = DEFAULT_RELAY_PATH,
  logger = () => {}
} = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_PAYLOAD_BYTES
  });

  wss.on("connection", (browserSocket, request) => {
    const relayId = ++relayCounter;
    const config = getGeminiLiveEnv(env);

    if (!config.enabled || !config.configured) {
      browserSocket.close(1011, "Agent relay is not configured.");
      return;
    }

    const upstream = buildGeminiLiveServerWebSocketConnection(env);
    const upstreamSocket = new WebSocket(upstream.url, {
      headers: upstream.headers,
      perMessageDeflate: false,
      maxPayload: MAX_RELAY_PAYLOAD_BYTES
    });
    const queuedClientMessages = [];
    let queuedClientBytes = 0;
    let droppedClientMediaMessages = 0;
    let upstreamOpen = false;
    let closed = false;
    let browserAlive = true;
    let upstreamAlive = true;
    const heartbeatTimer = setInterval(() => {
      if (closed) {
        return;
      }

      if (browserSocket.readyState === WebSocket.OPEN) {
        if (!browserAlive) {
          closePair(1011, "Agent relay client heartbeat timed out.");
          return;
        }
        browserAlive = false;
        safePing(browserSocket);
      }

      if (upstreamSocket.readyState === WebSocket.OPEN) {
        if (!upstreamAlive) {
          closePair(1011, "Agent relay upstream heartbeat timed out.");
          return;
        }
        upstreamAlive = false;
        safePing(upstreamSocket);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    logger(
      `RELAY ${relayId} open client=${request.socket?.remoteAddress ?? "unknown"} model=${config.model}`
    );

    upstreamSocket.on("open", () => {
      upstreamOpen = true;
      logger(`RELAY ${relayId} upstream open queued=${queuedClientMessages.length}`, "debug");

      while (queuedClientMessages.length && upstreamSocket.readyState === WebSocket.OPEN) {
        const entry = queuedClientMessages.shift();
        queuedClientBytes -= entry.bytes;
        if (entry.droppable && isSocketBackpressured(upstreamSocket)) {
          recordDroppedClientMedia("upstream_backpressure");
          continue;
        }
        upstreamSocket.send(entry.payload, { binary: entry.isBinary });
      }
    });

    upstreamSocket.on("message", (data, isBinary) => {
      upstreamAlive = true;
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(data, { binary: isBinary });
      }
    });

    upstreamSocket.on("pong", () => {
      upstreamAlive = true;
    });

    upstreamSocket.on("error", (error) => {
      logger(`RELAY ${relayId} upstream error="${shortLogText(error.message)}"`, "warn");
      closePair(1011, "Agent upstream error.");
    });

    upstreamSocket.on("close", (code, reason) => {
      logger(`RELAY ${relayId} upstream close code=${code} reason="${shortLogText(reason)}"`, "debug");
      closePair(code || 1000, normalizeCloseReason(reason) || "Agent upstream closed.");
    });

    browserSocket.on("message", (data, isBinary) => {
      browserAlive = true;
      const payload = normalizePayload(data, isBinary);
      const droppable = isDroppableRealtimeMedia(payload, isBinary);

      if (upstreamOpen && upstreamSocket.readyState === WebSocket.OPEN) {
        if (droppable && isSocketBackpressured(upstreamSocket)) {
          recordDroppedClientMedia("upstream_backpressure");
          return;
        }
        upstreamSocket.send(payload, { binary: isBinary });
        return;
      }

      // Audio/video is stale once the upstream session has not opened yet. Keeping it
      // would turn a short network outage into seconds of delayed conversation.
      if (droppable) {
        recordDroppedClientMedia("upstream_not_ready");
        return;
      }

      const bytes = estimatePayloadBytes(payload);
      if (
        queuedClientMessages.length >= MAX_INITIAL_CLIENT_QUEUE_MESSAGES ||
        queuedClientBytes + bytes > MAX_INITIAL_CLIENT_QUEUE_BYTES
      ) {
        logger(`RELAY ${relayId} client queue overflow`, "warn");
        closePair(1009, "Agent relay queue overflow.");
        return;
      }

      queuedClientMessages.push({ payload, isBinary, bytes, droppable });
      queuedClientBytes += bytes;
    });

    browserSocket.on("pong", () => {
      browserAlive = true;
    });

    browserSocket.on("error", (error) => {
      logger(`RELAY ${relayId} client error="${shortLogText(error.message)}"`, "debug");
      closePair(1011, "Agent relay client error.");
    });

    browserSocket.on("close", (code, reason) => {
      logger(`RELAY ${relayId} client close code=${code} reason="${shortLogText(reason)}"`, "debug");
      closePair(code || 1000, normalizeCloseReason(reason) || "Agent client closed.");
    });

    function closePair(code = 1000, reason = "Agent relay closed.") {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeatTimer);
      safeClose(browserSocket, code, reason);
      safeClose(upstreamSocket, code, reason);
      queuedClientMessages.length = 0;
      queuedClientBytes = 0;
      logger(`RELAY ${relayId} closed code=${code} reason="${shortLogText(reason)}"`, "debug");
    }

    function recordDroppedClientMedia(reason) {
      droppedClientMediaMessages += 1;
      if (droppedClientMediaMessages === 1 || droppedClientMediaMessages % 32 === 0) {
        logger(
          `RELAY ${relayId} dropped stale client media count=${droppedClientMediaMessages} reason=${reason}`,
          "debug"
        );
      }
    }
  });

  return {
    path,
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit("connection", websocket, request);
      });
    },
    close(callback) {
      wss.close(callback);
    }
  };
}

export function buildGeminiLiveRelaySession({
  request,
  env = process.env,
  path = DEFAULT_RELAY_PATH
} = {}) {
  const config = getGeminiLiveEnv(env);

  return {
    ok: true,
    transport: "server_relay",
    websocketUrl: buildSameOriginWebSocketUrl(request, path),
    model: config.model,
    voice: config.voice,
    thinkingLevel: config.thinkingLevel,
    contextCompression: config.contextCompression,
    sessionResumption: config.sessionResumption,
    slidingWindowTokens: config.slidingWindowTokens,
    apiVersion: String(env.GEMINI_LIVE_API_VERSION || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION
  };
}

export function buildGeminiLiveServerWebSocketUrl(env = process.env) {
  return buildGeminiLiveServerWebSocketConnection(env).url;
}

export function buildGeminiLiveServerWebSocketConnection(env = process.env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();

  if (!apiKey) {
    throw Object.assign(new Error("Agent API key is not configured."), {
      statusCode: 503
    });
  }

  const configuredWebSocketUrl = String(env.GEMINI_LIVE_WEBSOCKET_URL || "").trim();
  const apiVersion = String(env.GEMINI_LIVE_API_VERSION || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;
  const rawUrl = configuredWebSocketUrl || buildDefaultGeminiLiveWebSocketUrl({
    baseUrl: env.GEMINI_LIVE_WEBSOCKET_BASE_URL,
    apiVersion
  });
  const url = new URL(normalizeWebSocketProtocol(rawUrl));
  const authMode = normalizeGeminiLiveAuthMode(env.GEMINI_LIVE_AUTH_MODE);
  const headers = {};

  if (authMode === "query") {
    const queryParam = String(env.GEMINI_LIVE_API_KEY_QUERY_PARAM || "key").trim() || "key";
    url.searchParams.set(queryParam, apiKey);
  } else if (authMode === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authMode === "x-goog-api-key") {
    headers["x-goog-api-key"] = apiKey;
  }

  return { url: url.href, headers, authMode };
}

function buildDefaultGeminiLiveWebSocketUrl({ baseUrl, apiVersion }) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_WEBSOCKET_BASE_URL).trim().replace(/\/+$/, "");
  return `${normalizedBaseUrl}/ws/google.ai.generativelanguage.${encodeURIComponent(apiVersion)}.GenerativeService.BidiGenerateContent`;
}

function normalizeWebSocketProtocol(value) {
  const url = new URL(String(value || "").trim());

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw Object.assign(new Error("Gemini Live WebSocket URL must use ws://, wss://, http://, or https://."), {
      statusCode: 500
    });
  }

  return url.href;
}

function normalizeGeminiLiveAuthMode(value) {
  const mode = String(value || "query").trim().toLowerCase();
  if (["query", "bearer", "x-goog-api-key", "none"].includes(mode)) {
    return mode;
  }

  throw Object.assign(new Error("GEMINI_LIVE_AUTH_MODE must be query, bearer, x-goog-api-key, or none."), {
    statusCode: 500
  });
}

function buildSameOriginWebSocketUrl(request, path) {
  const proto = String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (request?.socket?.encrypted ? "https" : "http");
  const host = request?.headers?.["x-forwarded-host"] || request?.headers?.host || "localhost";
  const wsProto = proto === "https" ? "wss" : "ws";

  return `${wsProto}://${host}${path}`;
}

function normalizePayload(data, isBinary) {
  if (isBinary) {
    return data;
  }

  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return data;
}

function isDroppableRealtimeMedia(payload, isBinary) {
  if (isBinary || typeof payload !== "string") {
    return false;
  }

  try {
    const message = JSON.parse(payload);
    return Boolean(message?.realtimeInput?.audio || message?.realtimeInput?.video);
  } catch (_error) {
    return false;
  }
}

function estimatePayloadBytes(payload) {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload);
  }

  return Number(payload?.byteLength || payload?.length || 0);
}

function isSocketBackpressured(socket) {
  return Number(socket?.bufferedAmount || 0) >= MAX_UPSTREAM_BUFFERED_BYTES;
}

function safePing(socket) {
  try {
    socket.ping?.();
  } catch (_error) {
    // The close/error handlers will finish cleanup if the socket is no longer writable.
  }
}

function safeClose(socket, code, reason) {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  try {
    socket.close(normalizeCloseCode(code), String(reason || "closed").slice(0, 120));
  } catch (_error) {
    try {
      socket.terminate?.();
    } catch (_terminateError) {
      // Best-effort relay cleanup only.
    }
  }
}

function normalizeCloseCode(code) {
  const numeric = Number(code);

  if (numeric === 1000 || (numeric >= 3000 && numeric <= 4999)) {
    return numeric;
  }

  return 1011;
}

function normalizeCloseReason(reason) {
  if (!reason) {
    return "";
  }

  if (Buffer.isBuffer(reason)) {
    return reason.toString("utf8");
  }

  return String(reason);
}

function shortLogText(value, maxLength = 180) {
  return normalizeCloseReason(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}
