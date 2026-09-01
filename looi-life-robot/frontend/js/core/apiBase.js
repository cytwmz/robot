let backendBaseUrl = "";

export function configureBackendBaseUrl(value = "") {
  backendBaseUrl = normalizeBackendBaseUrl(
    value ||
    globalThis.LOOI_BACKEND_BASE_URL ||
    globalThis.LOOI_RUNTIME_CONFIG?.backendBaseUrl ||
    ""
  );
}

export function getBackendBaseUrl() {
  return backendBaseUrl;
}

export function apiUrl(path = "/") {
  const cleanPath = String(path || "/");
  const normalizedPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;

  if (!backendBaseUrl) {
    return normalizedPath;
  }

  return `${backendBaseUrl}${normalizedPath}`;
}

export function normalizeBackendBaseUrl(value = "") {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return "";
  }

  const url = new URL(raw, globalThis.location?.href || "http://localhost/");

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Backend URL must use http:// or https://.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";

  return url.href.replace(/\/+$/, "");
}

export function websocketUrlFromHttpBase(path = "/") {
  const httpUrl = new URL(apiUrl(path), globalThis.location?.href || "http://localhost/");
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.href;
}

// ngrok 免费版会对浏览器请求插入一次警告页；带上此头可跳过。
// 仅当后端域名是 ngrok 时才加，本地/其他部署不受影响。
export function backendTunnelHeaders(extra = {}) {
  const headers = { ...extra };

  try {
    const host = new URL(
      backendBaseUrl || globalThis.location?.href || "http://localhost/"
    ).hostname;

    if (/(\.|^)ngrok(-free)?\.(app|io|dev)$/.test(host)) {
      headers["ngrok-skip-browser-warning"] = "true";
    }
  } catch (_error) {
    // URL 解析失败时按无隧道处理即可。
  }

  return headers;
}
