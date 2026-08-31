import assert from "node:assert/strict";
import fs from "node:fs";
import { GimbalBehaviorController } from "../../frontend/js/robot/gimbalBehaviorController.js";

const idleSchedulerSource = fs.readFileSync(
  new URL("../../frontend/js/idle/idleScenarioScheduler.js", import.meta.url),
  "utf8"
);
assert.match(idleSchedulerSource, /AUTONOMOUS_PITCH_ENABLED = false/);
assert.match(idleSchedulerSource, /Idle head pitch suppressed/);

const sent = [];
const robotClient = {
  isConnected() {
    return true;
  },
  sendHeadYaw(command) {
    sent.push({ axis: "yaw", ...command });
    return "yaw";
  },
  sendHeadPitch(command) {
    sent.push({ axis: "pitch", ...command });
    return "pitch";
  },
  sendGimbalMove(command) {
    sent.push({ axis: "move", ...command });
    return "move";
  }
};

const controller = new GimbalBehaviorController({ robotClient });
controller.resetToConnectionZero();
assert.equal(controller.getStatus().lastYaw, 0);
assert.equal(controller.getStatus().lastPitch, 0);

controller.setMode("off");
assert.equal(sent.length, 0, "changing automatic mode must not reposition either servo");

assert.deepEqual(
  controller.move("left", { degrees: 20, label: "user_left", userInitiated: true }),
  { ok: true, messageId: "move", direction: "left", physicalDirection: "left" }
);
assert.deepEqual(
  sent.at(-1),
  { axis: "move", direction: "left", degrees: 20, durationMs: 90, label: "user_left", pitchAuthority: undefined }
);
assert.deepEqual(controller.move("invalid"), { ok: false, reason: "invalid_gimbal_direction" });
assert.deepEqual(
  controller.move("up", { label: "agent_gimbal_up" }),
  { ok: false, reason: "gimbal_move_requires_user_command" }
);
assert.deepEqual(
  controller.move("up", { label: "user_up", userInitiated: true }),
  { ok: true, messageId: "move", direction: "up", physicalDirection: "up" }
);
assert.equal(sent.at(-1).pitchAuthority, "user_command");

controller.resetToConnectionZero();
const commandsBeforeObservation = sent.length;
controller.handleObservation({
  cameraRunning: true,
  userVisible: true,
  faceCenterX: 0,
  faceCenterY: 1
});
assert.equal(sent.length, commandsBeforeObservation, "camera observations must never move the gimbal");

controller.setMode("curious_idle");
controller.tick(10_000);
const curiousMove = sent.at(-1);
assert.equal(curiousMove.axis, "yaw");
assert.equal(curiousMove.label, "curious_scan");
assert.equal(curiousMove.angle, 75);

const gimbalCommands = sent.filter((command) => command.axis === "yaw" || command.axis === "pitch");
assert.ok(gimbalCommands.every((command) => Number.isFinite(command.angle)));
assert.ok(gimbalCommands.filter((command) => command.axis === "yaw").every((command) => command.angle >= 0 && command.angle <= 180));
assert.ok(gimbalCommands.filter((command) => command.axis === "pitch").every((command) => command.angle >= 0 && command.angle <= 90));
assert.equal(gimbalCommands.length, 1, "curious idle may send one yaw-only target");
assert.equal(gimbalCommands[0].axis, "yaw");
assert.ok(gimbalCommands.every((command) => !Object.hasOwn(command, "pulse")));
assert.equal(sent.some((command) => String(command.label).includes("face_follow")), false);

console.log(JSON.stringify({ ok: true, commands: sent.length }));

