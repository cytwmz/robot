import assert from "node:assert/strict";
import { createLocalBrainServerFromEnv } from "../lib/localBrain/localBrainServer.js";
import { OpenAIResponsesProvider } from "../lib/localBrain/providers/openAIResponsesProvider.js";
import {
  normalizeBrainResponse,
  parseBrainResponse,
  stripMarkdownCodeFence,
  validateBrainAction
} from "../lib/localBrain/brainResponseParser.js";
import { sanitizeBrainContext } from "../lib/localBrain/brainContextSanitizer.js";
import { sanitizeBrainRequestValue } from "../../frontend/js/localBrain/localServerBrainAdapter.js";

process.env.LOCAL_BRAIN_ENABLED = "true";
process.env.LOCAL_BRAIN_PROVIDER = "mock";
process.env.LOCAL_BRAIN_MODEL = "";

const localBrain = createLocalBrainServerFromEnv(process.env, () => {});
const status = await localBrain.status();
assert.equal(status.enabled, true);
assert.equal(status.provider, "mock");
assert.equal(status.available, true);

const cases = [
  ["come here", "run_scenario", "come_closer"],
  ["move forward", "run_scenario", "come_closer"],
  ["give me space", "run_scenario", "back_up"],
  ["look left", "move_gimbal", "left"],
  ["向左看", "move_gimbal", "left"],
  ["向右看", "move_gimbal", "right"]
];

for (const [text, expectedType, expectedValue] of cases) {
  const response = await localBrain.think({
    reason: "manual",
    triggerEvent: {
      type: "user_text",
      payload: { text }
    },
    context: {
      lifeState: { mood: "curious", energy: 0.8, boredom: 0.4 },
      policy: {
        localMotionArmed: true
      }
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.provider, "mock");
  assert.equal(response.action.type, expectedType);
  assert.equal(
    expectedType === "move_gimbal" ? response.action.args.direction : response.action.args.name,
    expectedValue
  );
}

const pictureResponse = await localBrain.think({
  reason: "manual",
  triggerEvent: {
    type: "user_text",
    payload: { text: "take a picture of me" }
  },
  context: {
    policy: {
      localMotionArmed: true
    }
  }
});
assert.equal(pictureResponse.ok, true);
assert.equal(pictureResponse.action.type, "run_scenario");
assert.equal(pictureResponse.action.args.name, "take_picture");

const faceTrackingResponse = await localBrain.think({
  reason: "manual",
  triggerEvent: {
    type: "user_text",
    payload: { text: "打开人脸跟踪" }
  },
  context: { policy: { localMotionArmed: false } }
});
assert.equal(faceTrackingResponse.ok, true);
assert.equal(faceTrackingResponse.action.type, "set_gimbal_mode");
assert.equal(faceTrackingResponse.action.args.mode, "face_follow");

const fallbackServer = createLocalBrainServerFromEnv({
  LOCAL_BRAIN_ENABLED: "true",
  LOCAL_BRAIN_PROVIDER: "bad-provider"
}, () => {});
const fallbackStatus = await fallbackServer.status();
assert.equal(fallbackStatus.provider, "mock");
assert.equal(fallbackStatus.available, true);

const groqServer = createLocalBrainServerFromEnv({
  LOCAL_BRAIN_ENABLED: "true",
  LOCAL_BRAIN_PROVIDER: "groq",
  LOCAL_BRAIN_MODEL: "llama-3.1-8b-instant",
  GROQ_API_KEY: ""
}, () => {});
const groqStatus = await groqServer.status();
assert.equal(groqStatus.provider, "groq");
assert.equal(groqStatus.model, "llama-3.1-8b-instant");
assert.equal(groqStatus.available, false);
assert.match(groqStatus.details.error, /GROQ_API_KEY/);

const fireworksServer = createLocalBrainServerFromEnv({
  LOCAL_BRAIN_ENABLED: "true",
  LOCAL_BRAIN_PROVIDER: "fireworks",
  LOCAL_BRAIN_MODEL: "accounts/fireworks/models/gpt-oss-20b",
  FIREWORKS_API_KEY: ""
}, () => {});
const fireworksStatus = await fireworksServer.status();
assert.equal(fireworksStatus.provider, "fireworks");
assert.equal(fireworksStatus.model, "accounts/fireworks/models/gpt-oss-20b");
assert.equal(fireworksStatus.available, false);
assert.match(fireworksStatus.details.error, /FIREWORKS_API_KEY/);

const openaiServer = createLocalBrainServerFromEnv({
  LOCAL_BRAIN_ENABLED: "true",
  LOCAL_BRAIN_PROVIDER: "openai-responses",
  LOCAL_BRAIN_MODEL: "gpt-5.6-sol",
  OPENAI_API_KEY: ""
}, () => {});
const openaiStatus = await openaiServer.status();
assert.equal(openaiStatus.provider, "openai-responses");
assert.equal(openaiStatus.model, "gpt-5.6-sol");
assert.equal(openaiStatus.available, false);
assert.match(openaiStatus.details.error, /OPENAI_API_KEY/);

const openaiRequests = [];
const openaiProvider = new OpenAIResponsesProvider({
  apiKey: "test-key",
  model: "gpt-5.6-sol",
  reasoningEffort: "none",
  fetchImpl: async (url, options) => {
    openaiRequests.push({ url, options });
    if (url.endsWith("/models/gpt-5.6-sol")) {
      return new Response(JSON.stringify({ id: "gpt-5.6-sol" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: '{"text":"Looking left.","action":{"type":"move_gimbal","args":{"direction":"left"}},"reason":"user_request","confidence":0.9}'
        }]
      }]
    }), { status: 200 });
  }
});
assert.equal((await openaiProvider.status()).available, true);
const openaiText = await openaiProvider.think({
  messages: [
    { role: "system", content: "Return JSON only." },
    { role: "user", content: "Look left." }
  ]
});
assert.match(openaiText, /Looking left/);
const openaiRequest = JSON.parse(openaiRequests.at(-1).options.body);
assert.equal(openaiRequests.at(-1).url, "https://api.openai.com/v1/responses");
assert.equal(openaiRequest.model, "gpt-5.6-sol");
assert.equal(openaiRequest.reasoning.effort, "none");
assert.equal(openaiRequest.input[0].content, "Look left.");

assert.equal(parseBrainResponse({ text: null, action: null }).action, null);
assert.equal(parseBrainResponse('{"action":{"type":"run_scenario","args":{"name":"still"}}}').action.type, "run_scenario");
const scenarioResponse = normalizeBrainResponse(parseBrainResponse({
  action: {
    type: "run_scenario",
    args: {
      name: "take_picture",
      reason: "photo_request"
    }
  }
}), { provider: "test", model: "test" });
assert.equal(scenarioResponse.ok, true);
assert.equal(scenarioResponse.action.type, "run_scenario");
assert.equal(scenarioResponse.action.args.name, "take_picture");
const rejectedPerformResponse = normalizeBrainResponse(parseBrainResponse({
  action: {
    type: "perform",
    args: {
      movement: ["look_left"]
    }
  }
}), { provider: "test", model: "test" });
assert.equal(rejectedPerformResponse.ok, false);
assert.equal(rejectedPerformResponse.action, null);
assert.match(rejectedPerformResponse.reason, /Unknown action type/);
assert.equal(stripMarkdownCodeFence("```json\n{\"ok\":true}\n```"), '{"ok":true}');
assert.equal(parseBrainResponse("```json\n{\"action\":{\"type\":\"run_scenario\",\"args\":{\"name\":\"still\"}}}\n```").action.type, "run_scenario");
const invalid = normalizeBrainResponse(parseBrainResponse("not json"), { provider: "test", model: "test" });
assert.equal(invalid.ok, true);
assert.equal(invalid.action, null);
assert.equal(invalid.reason, "invalid_json_from_model");
const unsafeAction = validateBrainAction({
  type: "run_scenario",
  args: {
    name: "come_closer",
    left_motor: 1
  }
});
assert.equal(unsafeAction.ok, false);
assert.match(unsafeAction.error, /unsafe/i);
assert.equal(validateBrainAction({
  type: "set_gimbal_mode",
  args: { mode: "off" }
}).ok, true);
assert.equal(validateBrainAction({
  type: "set_gimbal_mode",
  args: { mode: "raw_pwm" }
}).ok, false);

const sanitized = sanitizeBrainContext({
  triggerEvent: {
    type: "user_text",
    payload: {
      text: "hello",
      dataUrl: "data:image/jpeg;base64,AAAA"
    }
  },
  camera: {
    running: true,
    latestObservation: {
      userVisible: true,
      dataUrl: "data:image/jpeg;base64,BBBB"
    }
  },
  recentEvents: Array.from({ length: 30 }, (_, index) => ({
    type: "system",
    payload: {
      text: `event ${index}`,
      dataUrl: "data:image/jpeg;base64,CCCC"
    }
  })),
  secret: "api key should be removed"
});
assert.equal(JSON.stringify(sanitized).includes("data:image"), false);
assert.equal(JSON.stringify(sanitized).includes("api key"), false);
assert.equal(sanitized.recentEvents.length, 20);

const browserSanitized = sanitizeBrainRequestValue({
  recentThoughts: [
    {
      results: [
        {
          detail: {
            snapshot: {
              width: 640,
              dataUrl: `data:image/jpeg;base64,${"A".repeat(160000)}`
            }
          }
        }
      ]
    }
  ]
});
assert.equal(JSON.stringify(browserSanitized).includes("data:image"), false);
assert.equal("dataUrl" in browserSanitized.recentThoughts[0].results[0].detail.snapshot, false);

const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const statusResponse = await fetch(`${baseUrl}/api/local-brain/status`);
  const statusPayload = await statusResponse.json();
  assert.equal(statusResponse.ok, true);
  assert.equal(statusPayload.ok, true);
  assert.equal(statusPayload.brain.provider, "mock");

  const thinkResponse = await fetch(`${baseUrl}/api/local-brain/think`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: "manual",
      triggerEvent: {
        type: "user_text",
        payload: { text: "come here" }
      },
      context: {
        lifeState: { mood: "curious", energy: 0.8 },
        policy: { localMotionArmed: true }
      }
    })
  });
  const thinkPayload = await thinkResponse.json();
  assert.equal(thinkResponse.ok, true);
  assert.equal(thinkPayload.ok, true);
  assert.equal(thinkPayload.action.type, "run_scenario");
  assert.equal(thinkPayload.action.args.name, "come_closer");

  const chatResponse = await fetch(`${baseUrl}/api/local-brain/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "look left",
      context: {
        policy: { localMotionArmed: true }
      }
    })
  });
  const chatPayload = await chatResponse.json();
  assert.equal(chatResponse.ok, true);
  assert.equal(chatPayload.action.type, "move_gimbal");
  assert.equal(chatPayload.action.args.direction, "left");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(
  JSON.stringify({
    ok: true,
    provider: status.provider,
    parser: true,
    sanitizer: true
  })
);
