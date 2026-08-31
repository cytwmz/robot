const DEFAULT_API2D_BASE_URL = "https://oa.api2d.net/v1";
const DEFAULT_API2D_MODEL = "gpt-4o-mini";

export function getApi2dChatEnv(env = process.env) {
  const baseUrl = trimTrailingSlash(env.API2D_BASE_URL || DEFAULT_API2D_BASE_URL);
  const explicitApiKey = String(env.API2D_API_KEY || "").trim();
  const legacyGeminiUrl = String(env.GEMINI_LIVE_WEBSOCKET_URL || "").trim();
  const canUseLegacyKey = /(^|\.)api2d\.(net|com|site|online)$/i.test(hostnameOf(legacyGeminiUrl));
  const apiKey = explicitApiKey || (canUseLegacyKey ? String(env.GEMINI_API_KEY || "").trim() : "");
  const model = String(env.API2D_MODEL || env.LOCAL_BRAIN_MODEL || DEFAULT_API2D_MODEL).trim();
  const enabled = String(env.API2D_CHAT_ENABLED || "true").trim().toLowerCase() !== "false";

  return {
    enabled,
    configured: Boolean(enabled && apiKey && model),
    apiKey,
    baseUrl,
    model,
    voiceEnabled: String(env.API2D_BROWSER_VOICE_ENABLED || "true").trim().toLowerCase() !== "false",
    voiceLanguage: String(env.API2D_BROWSER_VOICE_LANGUAGE || "zh-CN").trim() || "zh-CN"
  };
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch (_error) {
    return "";
  }
}

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
