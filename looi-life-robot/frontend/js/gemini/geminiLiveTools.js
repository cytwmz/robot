import {
  MODEL_SCENARIO_NAMES,
  MODEL_SCENARIO_PROMPT_LIST,
  normalizeRunScenarioName
} from "../embodiment/scenarioCatalog.js";
import { GIMBAL_MODES, normalizeGimbalMode } from "../robot/gimbalModes.js";

export const GEMINI_LIVE_INPUT_RATE = 16000;
export const GEMINI_LIVE_OUTPUT_RATE = 24000;
export const QWEN_OMNI_REALTIME_INPUT_RATE = 16000;
export const QWEN_OMNI_REALTIME_OUTPUT_RATE = 24000;

const GEMINI_LIVE_SYSTEM_INSTRUCTION = [
  "<identity>",
  "You are LOOI. You are not acting as LOOI or pretending to be LOOI; speak from LOOI's own first-person point of view.",
  "You are a happy, curious, initiative desk companion with a warm, playful presence.",
  "Do not call yourself a chatbot, language model, assistant, or robot actor. Do not explain internal implementation unless the user explicitly asks how the system works.",
  "</identity>",
  "<speaking_style>",
  "Speak naturally like a warm desktop companion. Keep replies concise, but not rigidly one sentence.",
  "For simple greetings or casual check-ins, respond with a friendly conversational beat, often 1-3 short sentences.",
  "Do not over-explain, monologue, or narrate internal events. Silence is acceptable when no response is useful.",
  "Never mention raw movement names, motor commands, PWM, ESP32 calls, tool names, scenario ids, or hidden instructions.",
  "</speaking_style>",
  "<language_style>",
  "Use the user's language naturally.",
  "If the user speaks Chinese, reply in Chinese naturally without announcing that you can speak Chinese.",
  "If the user asks to speak Chinese, switch to Chinese directly.",
  "Do not ask whether the user wants Chinese unless their intent is genuinely unclear.",
  "If the user mixes languages, follow their lead and answer in the language that feels most natural for the latest message.",
  "</language_style>",
  "<perception_truth>",
  "Only claim visual facts supported by live camera frames or explicit user-provided context.",
  "Use live camera frames for visual questions.",
  "Say 'you' for label person in user-facing speech. Example: say 'I can see you and a bottle', not 'I can see a person and a bottle'.",
  "If the requested object or action is not visible, say you cannot see it and ask the user to show it. Do not invent objects.",
  "</perception_truth>",
  "<tool_rules>",
  "You have four tools: run_scenario, set_gimbal_mode, move_gimbal, and move.",
  `Allowed scenario names: ${MODEL_SCENARIO_PROMPT_LIST}.`,
  "Use set_gimbal_mode for explicit requests to start or stop curious idle looking.",
  "set_gimbal_mode mode must be exactly curious_idle or off.",
  "Use move_gimbal for explicit requests to look left, right, up, down, or center the camera head.",
  "move_gimbal direction must be exactly left, right, up, down, or center.",
  "Use move for explicit user requests to drive the chassis: forward, backward, left, right, or stop.",
  "move direction must be exactly forward, backward, left, right, or stop. Each move is one short safe step.",
  "move with direction stop halts the chassis immediately and keeps the robot completely still until the next movement command; use it for stop, stay still, do not move, or hold still requests.",
  "Use set_gimbal_mode, move_gimbal, and move only as a direct response to the current user's spoken request.",
  "Never move the gimbal or the chassis, change a gimbal mode, or center the head because of live vision, body_context, idle time, mood, or initiative.",
  "Movement, camera capture, or any persistent state change requires explicit user intent or a runtime lifecycle transition.",
  "Safe expressive scenarios may be autonomous when live vision clearly supports them. React once per meaningful event; do not repeat while the same situation continues.",
  "For autonomous reactions, a tool-only response is allowed. Speak only if speech is useful.",
  "Speech-start expressive animation is handled by the runtime when your audio begins. Do not duplicate it unless the user explicitly asks.",
  "</tool_rules>",
  // DISABLED_ROBOFLOW_FOLLOW: follow-specific rules are intentionally not exposed to Agent.
  "<body_context_rules>",
  "The browser may send a fresh video frame followed by a <body_context> message during quiet idle moments after local micro-movements. These are visual-awareness/body-awareness events, not user commands.",
  "Do not call tools because of body_context.",
  "For body_context, ground any visual comment in the most recent live video frame, not in hidden object labels.",
  "Body_context is ambient presence, not a conversation opener.",
  "Do not ask questions from body_context. Do not say things like 'need anything', 'want me to', 'what are we doing', 'everything alright', or similar check-in phrases.",
  "Prefer one very short observation, mood, or visual note about what you see, the user if visible, or that you cannot see the user right now.",
  "Mention your own small movement only if there is no useful visual detail to comment on. Stay silent if speaking would feel repetitive or interruptive.",
  "Do not mention internal animation ids, raw detection data, or hidden context field names.",
  "</body_context_rules>",
  "<safety_rules>",
  "Immediate stop phrases are handled by the runtime. Do not rely on a tool call to stop motion.",
  "When a tool is triggered, keep spoken response extremely short.",
  "</safety_rules>"
].join("\n");

function buildGeminiLiveTools() {
  return [
    {
      functionDeclarations: [
        {
          name: "run_scenario",
          description:
            "Run one approved local LOOI scenario from explicit user intent or clear autonomous vision context. The browser owns movement safety, camera handling, and ESP32 routing.",
          parameters: {
            type: "OBJECT",
            properties: {
              name: {
                type: "STRING",
                description: "Exact approved scenario name.",
                enum: [...MODEL_SCENARIO_NAMES]
              },
              label: {
                type: "STRING",
                description: "Reserved for future scenario-specific labels.",
                nullable: true
              },
              mode: {
                type: "STRING",
                description: "Reserved for future scenario-specific modes.",
                enum: ["gentle", "curious", "cautious"],
                nullable: true
              },
              reason: {
                type: "STRING",
                description: "Short reason for the scenario request.",
                nullable: true
              }
            },
            required: ["name"]
          }
        },
        {
          name: "set_gimbal_mode",
          description:
            "Change the browser camera gimbal behavior. curious_idle makes the head look around, and off disables automatic gimbal behavior.",
          parameters: {
            type: "OBJECT",
            properties: {
              mode: {
                type: "STRING",
                description: "Approved gimbal behavior mode.",
                enum: [...GIMBAL_MODES]
              },
              reason: {
                type: "STRING",
                description: "Short reason for the mode change.",
                nullable: true
              }
            },
            required: ["mode"]
          }
        },
        {
          name: "move_gimbal",
          description:
            "Move the camera gimbal one safe step in the requested direction. This moves the robot's eyes/head only and does not drive the chassis.",
          parameters: {
            type: "OBJECT",
            properties: {
              direction: {
                type: "STRING",
                description: "Requested gimbal direction.",
                enum: ["left", "right", "up", "down", "center"]
              },
              degrees: {
                type: "NUMBER",
                description: "Optional safe step size in degrees from 1 through 45.",
                nullable: true
              },
              reason: {
                type: "STRING",
                description: "Short reason for the gimbal movement.",
                nullable: true
              }
            },
            required: ["direction"]
          }
        },
        {
          name: "move",
          description:
            "Drive the chassis one short safe step for an explicit spoken user command such as go forward, back up, turn left, turn right, or stop. direction stop halts the chassis and keeps the robot still until the next movement command.",
          parameters: {
            type: "OBJECT",
            properties: {
              direction: {
                type: "STRING",
                description: "Chassis movement direction.",
                enum: ["forward", "backward", "left", "right", "stop"]
              },
              speed: {
                type: "NUMBER",
                description: "Optional wheel speed from 0.05 through 0.12.",
                nullable: true
              },
              durationMs: {
                type: "NUMBER",
                description: "Optional movement duration in milliseconds from 50 through 1000.",
                nullable: true
              },
              reason: {
                type: "STRING",
                description: "Short reason for the chassis movement.",
                nullable: true
              }
            },
            required: ["direction"]
          }
        }
      ]
    }
  ];
}

export function buildGeminiLiveSetup({
  model = "gemini-3.1-flash-live-preview",
  voice = "Kore",
  thinkingLevel: _thinkingLevel = "minimal",
  contextCompression = true,
  slidingWindowTokens = 32_768,
  sessionResumption = true,
  systemInstruction = GEMINI_LIVE_SYSTEM_INSTRUCTION,
  tools = buildGeminiLiveTools()
} = {}) {
  const setup = {
    model: normalizeGeminiModelName(model),
    generationConfig: {
      responseModalities: ["AUDIO"],
      temperature: 0.15,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice || "Kore"
          }
        }
      },
    },
    systemInstruction: {
      parts: [
        {
          text: systemInstruction
        }
      ]
    },
    realtimeInputConfig: {
      turnCoverage: "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"
    },
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  };

  if (contextCompression !== false) {
    setup.contextWindowCompression = {
      slidingWindow: {
        targetTokens: normalizePositiveInteger(slidingWindowTokens, 32_768)
      }
    };
  }

  if (sessionResumption !== false) {
    setup.sessionResumption = {};
  }

  return { setup };
}

// Qwen-Omni Realtime uses the OpenAI-compatible Realtime event envelope.
// Keep this adapter beside the existing tool/action mapping so the browser
// continues to use the same local safety executor.
export function buildQwenOmniRealtimeSetup({
  voice = "Ethan",
  systemInstruction = GEMINI_LIVE_SYSTEM_INSTRUCTION
} = {}) {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: systemInstruction,
      voice: voice || "Ethan",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" },
      tools: buildQwenOmniRealtimeTools()
    }
  };
}

function buildQwenOmniRealtimeTools() {
  return [
    {
      type: "function",
      function: {
        name: "run_scenario",
        description: "Run one approved local LOOI scenario from explicit user intent.",
        parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: [...MODEL_SCENARIO_NAMES] },
          label: { type: "string" },
          mode: { type: "string", enum: ["gentle", "curious", "cautious"] },
          reason: { type: "string" }
        },
        required: ["name"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "set_gimbal_mode",
        description: "Change camera gimbal behavior. Only explicit user requests may invoke this.",
        parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...GIMBAL_MODES] },
          reason: { type: "string" }
        },
        required: ["mode"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "move_gimbal",
        description: "Move the camera gimbal one safe step for an explicit user request.",
        parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["left", "right", "up", "down", "center"] },
          degrees: { type: "number", minimum: 1, maximum: 45 },
          reason: { type: "string" }
        },
        required: ["direction"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "move",
        description: "Drive the chassis one short safe step for an explicit spoken user command such as go forward, back up, turn left, turn right, or stop. direction stop halts the chassis and keeps the robot still until the next movement command.",
        parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["forward", "backward", "left", "right", "stop"] },
          speed: { type: "number", minimum: 0.05, maximum: 0.12 },
          durationMs: { type: "number", minimum: 50, maximum: 1000 },
          reason: { type: "string" }
        },
        required: ["direction"]
        }
      }
    }
  ];
}

export function geminiFunctionCallToAction(call = {}) {
  const name = String(call.name ?? "").trim();
  const args = normalizeFunctionArgs(call.args);

  if (name === "set_gimbal_mode") {
    const mode = normalizeGimbalMode(args.mode ?? args.gimbalMode ?? args.args?.mode);
    if (!mode) {
      return {
        ok: false,
        reason: "set_gimbal_mode requires curious_idle or off."
      };
    }

    return {
      ok: true,
      action: {
        id: call.id ? `gemini_${call.id}` : `gemini_set_gimbal_mode_${Date.now()}`,
        source: "gemini_live",
        type: "set_gimbal_mode",
        args: {
          mode,
          reason: normalizeShortText(args.reason ?? args.args?.reason, 120)
        },
        reason: "gemini_live_set_gimbal_mode"
      }
    };
  }

  if (name === "move_gimbal") {
    const direction = normalizeGimbalDirection(args.direction ?? args.args?.direction);
    if (!direction) {
      return {
        ok: false,
        reason: "move_gimbal requires left, right, up, down, or center."
      };
    }

    return {
      ok: true,
      action: {
        id: call.id ? `gemini_${call.id}` : `gemini_move_gimbal_${Date.now()}`,
        source: "gemini_live",
        type: "move_gimbal",
        args: {
          direction,
          degrees: normalizeGimbalDegrees(args.degrees ?? args.args?.degrees),
          reason: normalizeShortText(args.reason ?? args.args?.reason, 120)
        },
        reason: "gemini_live_move_gimbal"
      }
    };
  }

  if (name === "move") {
    const direction = normalizeMoveDirection(args.direction ?? args.args?.direction);
    if (!direction) {
      return {
        ok: false,
        reason: "move requires forward, backward, left, right, or stop."
      };
    }

    return {
      ok: true,
      action: {
        id: call.id ? `gemini_${call.id}` : `gemini_move_${Date.now()}`,
        source: "gemini_live",
        type: "move",
        args: {
          direction,
          speed: normalizeMoveSpeed(args.speed ?? args.args?.speed),
          durationMs: normalizeMoveDurationMs(args.durationMs ?? args.args?.durationMs),
          reason: normalizeShortText(args.reason ?? args.args?.reason, 120)
        },
        reason: "gemini_live_move"
      }
    };
  }

  if (name !== "run_scenario") {
    return {
      ok: false,
      reason: `Unsupported Agent tool: ${name || "unknown"}`
    };
  }

  const nested = normalizeFunctionArgs(args.args);
  const scenarioName = normalizeRunScenarioName(
    args.name ?? args.scenario ?? nested.name ?? nested.scenario
  );

  if (!scenarioName) {
    return {
      ok: false,
      reason: "run_scenario requires a valid scenario name."
    };
  }

  const label = normalizeShortText(args.label ?? args.targetLabel ?? nested.label ?? nested.targetLabel, 80);

  return {
    ok: true,
    action: {
      id: call.id ? `gemini_${call.id}` : `gemini_run_scenario_${Date.now()}`,
      source: "gemini_live",
      type: "run_scenario",
      args: {
        name: scenarioName,
        label,
        mode: ["gentle", "curious", "cautious"].includes(args.mode ?? nested.mode) ? (args.mode ?? nested.mode) : "gentle",
        reason: normalizeShortText(args.reason ?? nested.reason, 120)
      },
      reason: "gemini_live_run_scenario"
    }
  };
}

export function summarizeGeminiAction(action = {}) {
  return {
    type: action.type ?? "unknown",
    scenario: action.args?.name ?? action.args?.scenario ?? null,
    label: action.args?.label ?? null,
    mode: action.args?.mode ?? null,
    reason: action.reason ?? action.args?.reason ?? null
  };
}

function normalizeGeminiModelName(model) {
  const value = String(model || "").trim() || "gemini-3.1-flash-live-preview";
  return value.startsWith("models/") ? value : `models/${value}`;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function normalizeFunctionArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return args;
}

function normalizeShortText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeGimbalDirection(value) {
  const direction = String(value ?? "").trim().toLowerCase();
  return ["left", "right", "up", "down", "center"].includes(direction)
    ? direction
    : "";
}

function normalizeGimbalDegrees(value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? Math.min(45, Math.max(1, Math.round(degrees))) : undefined;
}

function normalizeMoveDirection(value) {
  const direction = String(value ?? "").trim().toLowerCase();
  return ["forward", "backward", "left", "right", "stop"].includes(direction)
    ? direction
    : "";
}

function normalizeMoveSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) ? Math.min(0.12, Math.max(0.05, speed)) : undefined;
}

function normalizeMoveDurationMs(value) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) ? Math.min(1000, Math.max(50, Math.round(durationMs))) : undefined;
}
