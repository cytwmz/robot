const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export class OpenAIResponsesProvider {
  constructor({
    baseUrl = DEFAULT_OPENAI_BASE_URL,
    apiKey = "",
    model = DEFAULT_OPENAI_MODEL,
    timeoutMs = 20000,
    maxOutputTokens = 192,
    reasoningEffort = "none",
    logger,
    trace = false,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.apiKey = String(apiKey ?? "").trim();
    this.model = String(model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
    this.timeoutMs = Number(timeoutMs) || 20000;
    this.maxOutputTokens = Number(maxOutputTokens) || 192;
    this.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
    this.logger = logger;
    this.trace = Boolean(trace);
    this.fetchImpl = fetchImpl;
  }

  getName() {
    return "openai-responses";
  }

  async status() {
    if (!this.apiKey) {
      return unavailable(this.getName(), this.model, "OPENAI_API_KEY is required.");
    }

    try {
      const startedAt = Date.now();
      const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/models/${encodeURIComponent(this.model)}`, {
        method: "GET",
        timeoutMs: Math.min(this.timeoutMs, 5000),
        headers: this.headers()
      });
      this.traceLog(
        `PROVIDER_STATUS provider=${this.getName()} model=${this.model} status=${response.status} duration=${Date.now() - startedAt}ms`
      );

      return {
        ok: true,
        provider: this.getName(),
        model: this.model,
        available: response.ok,
        details: {
          baseUrl: this.baseUrl,
          status: response.status
        }
      };
    } catch (error) {
      this.traceLog(`PROVIDER_STATUS failed provider=${this.getName()} error="${shortLogText(error.message)}"`, "warn");
      return unavailable(this.getName(), this.model, error.message);
    }
  }

  async think({ messages } = {}) {
    if (!this.apiKey) {
      return {
        ok: false,
        error: "OPENAI_API_KEY is required.",
        reason: "provider_error"
      };
    }

    const requestBody = buildResponseRequest({
      model: this.model,
      messages,
      maxOutputTokens: this.maxOutputTokens,
      reasoningEffort: this.reasoningEffort
    });
    const startedAt = Date.now();
    this.traceLog(
      `PROVIDER_HTTP start provider=${this.getName()} model=${this.model} url=${this.baseUrl}/responses timeout=${this.timeoutMs}ms`
    );

    try {
      const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/responses`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: this.headers(),
        body: JSON.stringify(requestBody)
      });
      const payload = await response.json().catch(() => ({}));
      const durationMs = Date.now() - startedAt;
      this.traceLog(
        `PROVIDER_HTTP response provider=${this.getName()} status=${response.status} duration=${durationMs}ms`
      );

      if (!response.ok) {
        const error = payload.error?.message ?? payload.error ?? `OpenAI Responses HTTP ${response.status}`;
        this.traceLog(`PROVIDER_HTTP error provider=${this.getName()} message="${shortLogText(error)}"`, "warn");
        return { ok: false, error, reason: "provider_error" };
      }

      const text = extractOutputText(payload);
      if (!text) {
        return {
          ok: false,
          error: "OpenAI response did not contain output text.",
          reason: "provider_error"
        };
      }

      return text;
    } catch (error) {
      this.traceLog(`PROVIDER_HTTP failed provider=${this.getName()} error="${shortLogText(error.message)}"`, "warn");
      return { ok: false, error: error.message, reason: "provider_error" };
    }
  }

  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  traceLog(message, level = "info") {
    if (this.trace && typeof this.logger === "function") {
      this.logger(message, level);
    }
  }
}

function buildResponseRequest({ model, messages, maxOutputTokens, reasoningEffort }) {
  const entries = Array.isArray(messages) ? messages : [];
  const instructions = entries
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => String(message.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const input = entries
    .filter((message) => message?.role !== "system" && message?.role !== "developer")
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: String(message?.content ?? "")
    }));

  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: Math.max(1, Math.round(maxOutputTokens)),
    reasoning: { effort: reasoningEffort }
  };
}

function extractOutputText(payload = {}) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts = [];
  output.forEach((item) => {
    if (!Array.isArray(item?.content)) {
      return;
    }
    item.content.forEach((part) => {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        parts.push(part.text);
      }
    });
  });

  return parts.join("\n").trim();
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "none").trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "none";
}

function unavailable(provider, model, error) {
  return {
    ok: true,
    provider,
    model,
    available: false,
    details: { error }
  };
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs, ...options } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is unavailable for the OpenAI provider.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" || /aborted/i.test(error?.message ?? "")) {
      throw new Error(`openai_responses_timeout_after_${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function shortLogText(value, maxLength = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
