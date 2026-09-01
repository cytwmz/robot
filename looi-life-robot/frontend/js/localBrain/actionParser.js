import { clampNumber } from "../core/runtimeUtils.js";
import {
  normalizeRunScenarioName
} from "../embodiment/scenarioCatalog.js";
import { normalizeGimbalMode } from "../robot/gimbalModes.js";

export const LOCAL_BRAIN_ALLOWED_ACTIONS = new Set([
  "run_scenario",
  "set_gimbal_mode",
  "move_gimbal",
  "move"
]);

const RAW_MOTOR_KEYS = new Set([
  "pwm",
  "raw_pwm",
  "left_pwm",
  "right_pwm",
  "left_motor",
  "right_motor",
  "leftMotor",
  "rightMotor",
  "motor_pwm",
  "motorPwm",
  "code",
  "command",
  "shell",
  "exec",
  "network",
  "url",
  "file",
  "path",
  "filesystem"
]);

export function parseBrainResponse(raw) {
  let value = raw;

  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return safeNoneResponse(`Invalid brain JSON: ${error.message}`);
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return safeNoneResponse("Brain response must be an object.");
  }

  const normalized = normalizeBrainAction(value.action);
  const action = normalized.action ?? { type: "none", args: {}, reason: "no_action" };

  return {
    ok: normalized.errors.length === 0 && value.ok !== false,
    source: normalizeText(value.source, "local_brain"),
    text: typeof value.text === "string" ? value.text : null,
    action,
    reason: normalizeText(value.reason, normalized.errors[0] ?? "brain_response"),
    confidence: clampNumber(value.confidence, 0, 1, 0.5),
    shouldRemember: value.shouldRemember === true,
    errors: normalized.errors,
    raw: value
  };
}

function normalizeBrainAction(action) {
  const errors = [];

  if (!action) {
    return {
      action: null,
      errors
    };
  }

  const result = validateBrainAction(action);

  if (result.ok) {
    return {
      action: result.action,
      errors
    };
  }

  errors.push(`action: ${result.error}`);

  return {
    action: null,
    errors
  };
}

export function validateBrainAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return {
      ok: false,
      error: "Action must be an object."
    };
  }

  const type = normalizeText(action.type, "");

  if (!LOCAL_BRAIN_ALLOWED_ACTIONS.has(type)) {
    return {
      ok: false,
      error: `Unknown action type: ${type || "missing"}`
    };
  }

  const args = action.args ?? {};

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: "Action args must be an object."
    };
  }

  const unsafeKey = findUnsafeMotorKey(args);

  if (unsafeKey) {
    return {
      ok: false,
      error: `Unsafe action field is not allowed: ${unsafeKey}`
    };
  }

  if (type === "run_scenario") {
    const scenario = normalizeRunScenarioName(args.name ?? args.scenario);
    if (!scenario) {
      return {
        ok: false,
        error: "run_scenario requires a valid scenario name."
      };
    }
  }

  if (type === "set_gimbal_mode" && !normalizeGimbalMode(args.mode ?? args.gimbalMode)) {
    return {
      ok: false,
      error: "set_gimbal_mode requires curious_idle or off."
    };
  }

  if (type === "move_gimbal" && !normalizeGimbalDirection(args.direction)) {
    return {
      ok: false,
      error: "move_gimbal requires left, right, up, down, or center."
    };
  }

  if (type === "move" && !normalizeMoveDirection(args.direction)) {
    return {
      ok: false,
      error: "move requires forward, backward, left, right, or stop."
    };
  }

  return {
    ok: true,
    action: sanitizeAllowedAction(action, type, args)
  };
}

function sanitizeAllowedAction(action, type, args) {
  const base = {
    id: typeof action.id === "string" ? action.id.slice(0, 80) : undefined,
    source: normalizeText(action.source, "local_brain"),
    type,
    reason: typeof action.reason === "string" ? action.reason.slice(0, 240) : undefined
  };

  if (type === "run_scenario") {
    const scenario = normalizeRunScenarioName(args.name ?? args.scenario);
    return {
      ...base,
      args: {
        name: scenario,
        label: typeof args.label === "string" ? args.label.slice(0, 80) : "",
        mode: ["gentle", "curious", "cautious"].includes(args.mode) ? args.mode : "gentle",
        reason: typeof args.reason === "string" ? args.reason.slice(0, 120) : ""
      }
    };
  }

  if (type === "set_gimbal_mode") {
    return {
      ...base,
      args: {
        mode: normalizeGimbalMode(args.mode ?? args.gimbalMode),
        reason: typeof args.reason === "string" ? args.reason.slice(0, 120) : ""
      }
    };
  }

  if (type === "move_gimbal") {
    return {
      ...base,
      args: {
        direction: normalizeGimbalDirection(args.direction),
        degrees: normalizeGimbalDegrees(args.degrees),
        reason: typeof args.reason === "string" ? args.reason.slice(0, 120) : ""
      }
    };
  }

  if (type === "move") {
    return {
      ...base,
      args: {
        direction: normalizeMoveDirection(args.direction),
        durationMs: normalizeMoveDurationMs(args.durationMs),
        speed: normalizeMoveSpeed(args.speed),
        reason: typeof args.reason === "string" ? args.reason.slice(0, 120) : ""
      }
    };
  }

  return {
    ...base,
    args: {}
  };
}

function safeNoneResponse(error) {
  return {
    ok: false,
    source: "parser",
    text: null,
    action: {
      type: "none",
      args: {},
      reason: error
    },
    reason: error,
    confidence: 0,
    shouldRemember: false,
    errors: [error],
    raw: null
  };
}

function normalizeGimbalDirection(value) {
  const direction = String(value ?? "").trim().toLowerCase();
  return ["left", "right", "up", "down", "center"].includes(direction)
    ? direction
    : "";
}

function normalizeMoveDirection(value) {
  const direction = String(value ?? "").trim().toLowerCase();
  return ["forward", "backward", "left", "right", "stop"].includes(direction)
    ? direction
    : "";
}

function normalizeMoveDurationMs(value) {
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) ? Math.min(1000, Math.max(50, numeric)) : 600;
}

function normalizeMoveSpeed(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(0.12, Math.max(0.05, numeric)) : 0.1;
}

function normalizeGimbalDegrees(value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? Math.min(45, Math.max(1, Math.round(degrees))) : undefined;
}

function findUnsafeMotorKey(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (RAW_MOTOR_KEYS.has(key)) {
      return key;
    }

    const nested = findUnsafeMotorKey(child);

    if (nested) {
      return nested;
    }
  }

  return null;
}

function normalizeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
