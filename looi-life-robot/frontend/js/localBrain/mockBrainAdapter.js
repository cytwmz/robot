import { inferGimbalMode } from "../robot/gimbalModes.js";

export class MockBrainAdapter {
  constructor({ logger } = {}) {
    this.logger = logger;
  }

  async isAvailable() {
    return true;
  }

  async think(context = {}) {
    const event = context.triggerEvent ?? latestEvent(context.recentEvents);
    const rawText = extractText(event);
    const text = normalizeText(rawText);
    const classification = event?.payload?.classification ?? null;

    if (["background", "noise"].includes(classification)) {
      return response({ reason: "background_ignored", confidence: 0.72 });
    }

    const scenario = inferScenario(rawText, context);
    if (!scenario) {
      return response({
        text: text && /\b(hello|hi|hey|looi|louie|lui|robot)\b/.test(text) ? "Hi." : null,
        reason: text ? "mock_no_scenario" : "mock_quiet",
        confidence: 0.45
      });
    }

    return response({
      text: scenario.text,
      action: scenario.action ?? (scenario.args
        ? {
            type: "run_scenario",
            args: scenario.args
          }
        : null),
      reason: scenario.reason,
      confidence: scenario.confidence
    });
  }
}

function inferScenario(text, context = {}) {
  if (!String(text ?? "").trim()) {
    return null;
  }

  const gimbalMode = inferGimbalMode(text);
  if (gimbalMode) {
    return {
      args: null,
      action: {
        type: "set_gimbal_mode",
        args: { mode: gimbalMode, reason: "mock_gimbal_mode_request" }
      },
      text: gimbalMode === "curious_idle"
          ? "I will look around on my own."
          : "Automatic gimbal behavior disabled.",
      reason: "gimbal_mode_request",
      confidence: 0.95
    };
  }

  const gimbalDirection = inferGimbalDirection(text);
  if (gimbalDirection) {
    return {
      args: null,
      action: {
        type: "move_gimbal",
        args: { direction: gimbalDirection, reason: "mock_gimbal_move_request" }
      },
      text: gimbalDirection === "left"
        ? "Looking left."
        : gimbalDirection === "right"
          ? "Looking right."
          : gimbalDirection === "up"
            ? "Looking up."
            : gimbalDirection === "down"
              ? "Looking down."
              : "Looking forward.",
      reason: "gimbal_move_request",
      confidence: 0.92
    };
  }

  text = normalizeText(text);

  // DISABLED_ROBOFLOW_FOLLOW: follow/track requests are conversational only.
  if (/\b(follow|track|keep following|keep tracking|stop following|stop tracking|cancel follow|cancel tracking|forget the target)\b/.test(text)) {
    return {
      args: null,
      text: "I can look with my camera, but continuous following is disabled.",
      reason: "follow_disabled",
      confidence: 0.78
    };
  }

  if (/\b(take|snap|shoot|capture)\b.*\b(picture|photo|selfie)\b|\b(picture|photo|selfie)\b.*\b(me|my)\b/.test(text)) {
    return {
      args: { name: "take_picture" },
      text: "Okay, hold still.",
      reason: "take_picture_request",
      confidence: 0.9
    };
  }

  if (/\bcome here\b|\bcome closer\b|\bcome to me\b|\b(move|go|drive|roll)\s+(forward|forwards|ahead|straight)\b|\bforward a little\b/.test(text)) {
    return {
      args: { name: "come_closer" },
      text: "Coming a little closer.",
      reason: "come_closer_request",
      confidence: 0.86
    };
  }

  if (/\bgive me (space|room)\b|\bgo back\b|\bback up\b|\bnot too close\b|\b(move|drive|roll)\s+(back|backward|backwards|reverse)\b|\breverse a little\b/.test(text)) {
    return {
      args: { name: "back_up" },
      text: "I'll give you room.",
      reason: "back_up_request",
      confidence: 0.86
    };
  }

  return null;
}

// DISABLED_ROBOFLOW_FOLLOW: extractFollowLabel kept removed from active mock behavior.

function response({ text = null, action = null, reason = "mock", confidence = 0.8 } = {}) {
  return {
    ok: true,
    source: "mock",
    text,
    action,
    reason,
    confidence,
    shouldRemember: false
  };
}

function latestEvent(events = []) {
  return Array.isArray(events) && events.length ? events[0] : null;
}

function extractText(event = {}) {
  return String(event?.payload?.text ?? event?.text ?? "");
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\w\s'?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferGimbalDirection(text) {
  const raw = String(text ?? "").toLowerCase();
  if (/(?:\u5411\u5de6\u770b|\u5f80\u5de6\u770b|\u770b\u5de6\u8fb9|\u5de6\u770b)/u.test(raw)) return "left";
  if (/(?:\u5411\u53f3\u770b|\u5f80\u53f3\u770b|\u770b\u53f3\u8fb9|\u53f3\u770b)/u.test(raw)) return "right";
  if (/(?:\u5411\u4e0a\u770b|\u5f80\u4e0a\u770b|\u62ac\u5934|\u770b\u4e0a\u9762)/u.test(raw)) return "up";
  if (/(?:\u5411\u4e0b\u770b|\u5f80\u4e0b\u770b|\u4f4e\u5934|\u770b\u4e0b\u9762)/u.test(raw)) return "down";
  if (/(?:\u770b\u524d\u9762|\u770b\u6b63\u524d\u65b9|\u56de\u6b63|\u5c45\u4e2d)/u.test(raw)) return "center";
  if (/\b(?:look|eyes?|head|camera)\s+(?:to\s+the\s+)?left\b/.test(raw)) return "left";
  if (/\b(?:look|eyes?|head|camera)\s+(?:to\s+the\s+)?right\b/.test(raw)) return "right";
  if (/\b(?:look|eyes?|head|camera)\s+up\b/.test(raw)) return "up";
  if (/\b(?:look|eyes?|head|camera)\s+down\b/.test(raw)) return "down";
  if (/\b(?:look|eyes?|head|camera)\s+(?:forward|center|centre)\b/.test(raw)) return "center";
  return "";
}
