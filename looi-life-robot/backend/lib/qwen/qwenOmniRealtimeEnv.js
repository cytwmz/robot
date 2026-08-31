const DEFAULT_MODEL = "qwen3.5-omni-flash-realtime";
const DEFAULT_VOICE = "Ethan";
const DEFAULT_WEBSOCKET_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

export function getQwenOmniRealtimeEnv(env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || env.QWEN_OMNI_REALTIME_API_KEY || "").trim();
  const model = String(env.QWEN_OMNI_REALTIME_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const voice = String(env.QWEN_OMNI_REALTIME_VOICE || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const configuredUrl = String(env.QWEN_OMNI_REALTIME_URL || "").trim();
  const workspaceId = String(env.DASHSCOPE_WORKSPACE_ID || "").trim();
  const websocketUrl = configuredUrl || (
    workspaceId
      ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
      : DEFAULT_WEBSOCKET_URL
  );

  return {
    enabled:
      env.QWEN_OMNI_REALTIME_ENABLED !== "false" &&
      (env.QWEN_OMNI_REALTIME_ENABLED === "true" || Boolean(apiKey)),
    configured: Boolean(apiKey),
    apiKey,
    model,
    voice,
    websocketUrl
  };
}

export function buildQwenOmniRealtimeUpstreamUrl(env = process.env) {
  const config = getQwenOmniRealtimeEnv(env);

  if (!config.apiKey) {
    throw Object.assign(new Error("Qwen Omni Realtime API key is not configured."), {
      statusCode: 503
    });
  }

  const url = new URL(config.websocketUrl);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw Object.assign(new Error("Qwen Omni Realtime URL must use ws:// or wss://."), {
      statusCode: 500
    });
  }
  url.searchParams.set("model", config.model);
  return url.href;
}
