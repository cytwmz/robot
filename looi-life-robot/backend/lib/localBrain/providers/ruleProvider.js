import { inferGimbalMode } from "../../../../frontend/js/robot/gimbalModes.js";

export class RuleProvider {
  constructor({ model = "rule" } = {}) {
    this.model = model || "rule";
  }

  getName() {
    return "rule";
  }

  async status() {
    return {
      ok: true,
      provider: this.getName(),
      model: this.model,
      available: true,
      details: {
        deterministic: true
      }
    };
  }

  async think({ context } = {}) {
    const text = latestText(context);
    const classification = classifyText(text);

    switch (classification) {
      case "gimbal_face_follow":
        return gimbalResponse("face_follow", "Face tracking enabled.", classification);
      case "gimbal_curious_idle":
        return gimbalResponse("curious_idle", "I will look around on my own.", classification);
      case "gimbal_off":
        return gimbalResponse("off", "Automatic gimbal behavior disabled.", classification);
      case "gimbal_move_left":
      case "gimbal_move_right":
      case "gimbal_move_up":
      case "gimbal_move_down":
      case "gimbal_move_center":
        return gimbalMoveResponse(classification.replace("gimbal_move_", ""), classification);
      case "follow_disabled":
        return brainResponse({
          text: "I can look with my camera, but continuous following is disabled.",
          action: null,
          reason: classification,
          confidence: 0.78
        });
      case "scenario_take_picture":
        return brainResponse({
          text: "Okay, hold still.",
          action: scenarioAction("take_picture"),
          reason: classification,
          confidence: 0.9
        });
      case "scenario_come_closer":
        return brainResponse({
          text: "Coming a little closer.",
          action: scenarioAction("come_closer"),
          reason: classification,
          confidence: 0.86
        });
      case "scenario_back_up":
        return brainResponse({
          text: "I'll give you room.",
          action: scenarioAction("back_up"),
          reason: classification,
          confidence: 0.86
        });
      case "scenario_look_left":
        return brainResponse({
          text: "Looking left.",
          action: scenarioAction("look_left"),
          reason: classification,
          confidence: 0.82
        });
      case "scenario_look_right":
        return brainResponse({
          text: "Looking right.",
          action: scenarioAction("look_right"),
          reason: classification,
          confidence: 0.82
        });
      case "greeting":
        return brainResponse({
          text: "Hi.",
          action: null,
          reason: classification,
          confidence: 0.7
        });
      case "direct_question":
      case "safety_stop":
      case "background":
      case "unknown":
      default:
        return brainResponse({
          text: classification === "safety_stop" ? "Stopping." : null,
          action: null,
          reason: classification,
          confidence: classification === "background" ? 0.35 : 0.5
        });
    }
  }
}

function classifyText(text) {
  const gimbalMode = inferGimbalMode(text);
  if (gimbalMode) return `gimbal_${gimbalMode}`;

  const gimbalDirection = inferGimbalDirection(text);
  if (gimbalDirection) return `gimbal_move_${gimbalDirection}`;

  const normalized = normalizeText(text);

  if (!normalized) return "background";
  if (!/\bstopping\b|\bstop by\b/.test(normalized) && (/\b(stop|freeze|halt)\b/.test(normalized) || /\bdon'?t move\b|\bdo not move\b|\bstay still\b/.test(normalized))) return "safety_stop";
  // DISABLED_ROBOFLOW_FOLLOW: follow/track requests are conversational only.
  if (/\b(follow|track|stop following|stop tracking|cancel follow|cancel tracking|forget the target)\b/.test(normalized)) return "follow_disabled";
  if (/\b(take|snap|shoot|capture)\b.*\b(picture|photo|selfie)\b|\b(picture|photo|selfie)\b.*\b(me|my)\b/.test(normalized)) return "scenario_take_picture";
  if (/\bcome here\b|\bcome closer\b|\bcome to me\b|\b(move|go|drive|roll)\s+(forward|forwards|ahead|straight)\b|\bforward a little\b/.test(normalized)) return "scenario_come_closer";
  if (/\bgive me (space|room)\b|\bgo back\b|\bback up\b|\bnot too close\b|\b(move|drive|roll)\s+(back|backward|backwards|reverse)\b|\breverse a little\b/.test(normalized)) return "scenario_back_up";
  if (/\b(hello|hi|hey|looi|louie|lui|robot)\b/.test(normalized)) return "greeting";
  if (normalized.endsWith("?") || /^(why|what|who|how|can you|are you)\b/.test(normalized)) return "direct_question";
  return "unknown";
}

function gimbalResponse(mode, text, reason) {
  return brainResponse({
    text,
    action: {
      type: "set_gimbal_mode",
      args: { mode, reason }
    },
    reason,
    confidence: 0.95
  });
}

function gimbalMoveResponse(direction, reason) {
  const text = {
    left: "Looking left.",
    right: "Looking right.",
    up: "Looking up.",
    down: "Looking down.",
    center: "Looking forward."
  }[direction] ?? "Moving my view.";

  return brainResponse({
    text,
    action: {
      type: "move_gimbal",
      args: { direction, reason }
    },
    reason,
    confidence: 0.92
  });
}

function scenarioAction(name, args = {}) {
  return {
    type: "run_scenario",
    args: {
      name,
      ...args
    }
  };
}

function brainResponse({ text = null, action = null, reason = "rule", confidence = 0.5 } = {}) {
  return {
    ok: true,
    text,
    action,
    reason,
    confidence
  };
}

function extractFollowLabel(text, context = {}) {
  const normalized = normalizeText(text);
  const explicit = normalized.match(/\b(?:follow|track)\s+(?:the\s+|this\s+|that\s+)?([a-z][a-z -]{1,40})\b/);
  const label = explicit?.[1]?.replace(/\b(please|now|for me)\b/g, "").trim();
  if (label && !["it", "this", "that", "me"].includes(label)) {
    return label;
  }

  return String(
    context?.recentObjectReference?.label ??
      context?.vision?.activeTarget?.label ??
      context?.vision?.objects?.find?.((object) => object?.visible)?.label ??
      ""
  ).trim();
}

function latestText(context = {}) {
  return String(
    context.triggerEvent?.payload?.text ??
      context.triggerEvent?.text ??
      context.recentEvents?.[0]?.text ??
      ""
  );
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\w\s'?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferGimbalDirection(value) {
  const text = String(value ?? "").toLowerCase();

  if (/(?:\u5411\u5de6\u770b|\u5f80\u5de6\u770b|\u770b\u5de6\u8fb9|\u5de6\u770b)/u.test(text)) return "left";
  if (/(?:\u5411\u53f3\u770b|\u5f80\u53f3\u770b|\u770b\u53f3\u8fb9|\u53f3\u770b)/u.test(text)) return "right";
  if (/(?:\u5411\u4e0a\u770b|\u5f80\u4e0a\u770b|\u62ac\u5934|\u770b\u4e0a\u9762)/u.test(text)) return "up";
  if (/(?:\u5411\u4e0b\u770b|\u5f80\u4e0b\u770b|\u4f4e\u5934|\u770b\u4e0b\u9762)/u.test(text)) return "down";
  if (/(?:\u770b\u524d\u9762|\u770b\u6b63\u524d\u65b9|\u56de\u6b63|\u5c45\u4e2d)/u.test(text)) return "center";
  if (/\b(?:turn|rotate|look|eyes?|head|camera)\s+(?:to\s+the\s+)?left\b/.test(text)) return "left";
  if (/\b(?:turn|rotate|look|eyes?|head|camera)\s+(?:to\s+the\s+)?right\b/.test(text)) return "right";
  if (/\b(?:look|eyes?|head|camera)\s+up\b/.test(text)) return "up";
  if (/\b(?:look|eyes?|head|camera)\s+down\b/.test(text)) return "down";
  if (/\b(?:look|eyes?|head|camera)\s+(?:forward|center|centre)\b/.test(text)) return "center";
  return "";
}
