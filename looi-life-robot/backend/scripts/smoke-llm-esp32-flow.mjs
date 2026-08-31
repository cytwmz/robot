import assert from "node:assert/strict";
import { LocalEventBus } from "../../frontend/js/core/localEventBus.js";
import { EmbodiedActionRouter } from "../../frontend/js/embodiment/embodiedActionRouter.js";
import { PriorityScheduler } from "../../frontend/js/embodiment/priorityScheduler.js";
import { ScenarioFrameSequencer } from "../../frontend/js/embodiment/scenarioFrameSequencer.js";
import { LocalBrainEngine } from "../../frontend/js/localBrain/localBrainEngine.js";
import { MockBrainAdapter } from "../../frontend/js/localBrain/mockBrainAdapter.js";
import { RuleBrainFallback } from "../../frontend/js/localBrain/ruleBrainFallback.js";
import { clampBrainPolicy, createDefaultBrainPolicy } from "../../frontend/js/localBrain/brainPolicy.js";
import { ToolExecutor } from "../../frontend/js/robot/toolExecutor.js";
import { CommandQueue } from "../../frontend/js/robot/commandQueue.js";

const outbound = [];
const robotClient = {
  isConnected: () => true,
  sendJson: (payload) => {
    outbound.push({ ...payload });
    return payload.id ?? `smoke_${outbound.length}`;
  },
  sendMotion: ({ linear = 0, angular = 0, durationMs = 0, rampMs, label }) => {
    const payload = {
      type: "motion",
      left_speed: linear - angular,
      right_speed: linear + angular,
      duration_ms: durationMs,
      ramp_ms: rampMs,
      label
    };
    outbound.push(payload);
    return `motion_${outbound.length}`;
  },
  stop: (reason) => {
    outbound.push({ type: "stop", reason });
    return `stop_${outbound.length}`;
  }
};

const lifeState = {
  mood: "neutral",
  obstacle: false,
  connectionState: "connected",
  stopRespectUntil: 0
};
const lifeEngine = {
  getState: () => lifeState,
  patchState: (partial) => Object.assign(lifeState, partial),
  receiveEvent: () => {},
  setSpeaking: () => {}
};
const face = {
  setExpression: () => {},
  setEyeDirection: () => {},
  setSpeaking: () => {},
  blink: () => {},
  dismissPhoto: () => {}
};
const logs = [];
const commandQueue = new CommandQueue({
  robotClient,
  maxSpeed: 0.15,
  minDurationMs: 0,
  maxDurationMs: 1000,
  logger: (message) => logs.push(message)
});
const frameSequencer = new ScenarioFrameSequencer({
  face,
  commandQueue,
  lifeEngine,
  logger: (message) => logs.push(message)
});
const embodiedActionRouter = new EmbodiedActionRouter({
  frameSequencer,
  priorityScheduler: new PriorityScheduler(),
  lifeEngine,
  logger: (message) => logs.push(message)
});

let policy = createDefaultBrainPolicy();
const toolExecutor = new ToolExecutor({
  lifeEngine,
  face,
  robotClient,
  commandQueue,
  embodiedActionRouter,
  logger: (message) => logs.push(message),
  getRuntimeContext: () => ({
    robotConnected: robotClient.isConnected(),
    lifeState
  }),
  getExecutionPolicy: () => policy
});
const engine = new LocalBrainEngine({
  eventBus: new LocalEventBus({ logger: () => {} }),
  lifeEngine,
  toolExecutor,
  getRuntimeContext: () => ({ robotConnected: robotClient.isConnected(), lifeState }),
  getPolicy: () => policy,
  adapter: new MockBrainAdapter(),
  fallback: new RuleBrainFallback(),
  logger: (message) => logs.push(message)
});

const userRequest = {
  type: "user_text",
  payload: { text: "come here" }
};
const disarmedThought = await engine.thinkNow("manual", userRequest);
assert.equal(disarmedThought.actionType, "run_scenario");
assert.equal(disarmedThought.results[0].status, "rejected");
assert.equal(disarmedThought.results[0].message.includes("not_armed"), true);
assert.equal(outbound.some((message) => message.type === "motion"), false);

policy = clampBrainPolicy({ ...policy, localMotionArmed: true });
const armedThought = await engine.thinkNow("manual", userRequest);
assert.equal(armedThought.actionType, "run_scenario");
assert.ok(["queued", "completed"].includes(armedThought.results[0].status));
await new Promise((resolve) => setTimeout(resolve, 700));

const motionMessages = outbound.filter((message) => message.type === "motion");
assert.ok(motionMessages.length > 0, "The model action did not reach the ESP32 client.");
for (const message of motionMessages) {
  assert.ok(Number.isFinite(message.left_speed));
  assert.ok(Number.isFinite(message.right_speed));
  assert.ok(Math.abs(message.left_speed) <= 0.15);
  assert.ok(Math.abs(message.right_speed) <= 0.15);
  assert.ok(message.duration_ms >= 50 && message.duration_ms <= 1000);
}

console.log(JSON.stringify({
  ok: true,
  disarmed: disarmedThought.results[0].status,
  armed: armedThought.results[0].status,
  motionMessages: motionMessages.length,
  sampleMotion: motionMessages[0]
}));
