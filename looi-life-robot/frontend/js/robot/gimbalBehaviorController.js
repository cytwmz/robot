const DEFAULTS = Object.freeze({
  yawMaxAngle: 180,
  pitchMaxAngle: 90,
  curiousIntervalMs: 3500,
  curiousPauseMs: 700,
  curiousYawAngle: 75,
  automaticPitchEnabled: false,
  userMoveDegrees: 40,
  userMoveDurationMs: 260,
  userMoveIntervalMs: 100
});

export const GIMBAL_USER_MOVE_DEGREES = DEFAULTS.userMoveDegrees;
export const GIMBAL_USER_MOVE_DURATION_MS = DEFAULTS.userMoveDurationMs;
export const GIMBAL_USER_MOVE_INTERVAL_MS = DEFAULTS.userMoveIntervalMs;

export class GimbalBehaviorController {
  constructor({ robotClient, commandQueue, logger } = {}) {
    this.robotClient = robotClient;
    this.commandQueue = commandQueue;
    this.logger = logger;
    this.followEnabled = false;
    this.curiosityEnabled = true;
    this.lastObservation = null;
    this.lastUpdateAt = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.faceYawOffset = 0;
    this.facePitchOffset = 0;
    this.smoothedFaceX = null;
    this.smoothedFaceY = null;
    this.lastFaceSeenAt = 0;
    this.lastCuriosityAt = 0;
    this.curiosityDirection = 1;
    this.curiosityTarget = 0;
    this.curiosityPauseUntil = 0;
    this.compensationUntil = 0;
    this.timer = null;
  }

  start() {
    if (!this.timer) {
      this.timer = globalThis.setInterval(() => this.tick(), 250);
    }
    return this.getStatus();
  }

  stop(reason = "gimbal_controller_stop") {
    if (this.timer) {
      globalThis.clearInterval(this.timer);
      this.timer = null;
    }
    this.followEnabled = false;
    this.curiosityEnabled = false;
    return this.getStatus();
  }

  setFollowEnabled(_enabled) {
    this.followEnabled = false;
    this.resetFaceTrackingState();
    return this.getStatus();
  }

  setMode(mode) {
    if (mode === "curious_idle") {
      this.setCuriosityEnabled(true);
    } else {
      this.setCuriosityEnabled(false);
    }
    return this.getStatus();
  }

  setCuriosityEnabled(enabled) {
    this.curiosityEnabled = Boolean(enabled) && !this.followEnabled;
    return this.getStatus();
  }

  resetToConnectionZero() {
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.resetFaceTrackingState();
    this.curiosityTarget = 0;
    this.lastUpdateAt = 0;
    this.manualOverrideUntil = 0;
    return this.getStatus();
  }

  holdManualControl(durationMs = 1200) {
    const requestedMs = Number(durationMs);
    const holdMs = clamp(Number.isFinite(requestedMs) ? requestedMs : 1200, 400, 5000);
    this.manualOverrideUntil = Math.max(this.manualOverrideUntil ?? 0, Date.now() + holdMs);
    return this.manualOverrideUntil;
  }

  handleObservation(observation = {}) {
    this.lastObservation = observation;
    // Vision remains available to the Agent, but never controls the gimbal.
    return this.getStatus();
  }

  tick(now = Date.now()) {
    if (
      !this.curiosityEnabled ||
      now < (this.manualOverrideUntil ?? 0) ||
      !this.robotClient?.isConnected?.()
    ) {
      return this.getStatus();
    }
    const tuning = this.getTuning();
    if (now < this.curiosityPauseUntil || now - this.lastCuriosityAt < tuning.curiousIntervalMs) {
      return this.getStatus();
    }
    this.lastCuriosityAt = now;
    this.curiosityTarget = this.curiosityDirection > 0 ? tuning.curiousYawAngle : 0;
    this.sendYaw(this.curiosityTarget, "curious_scan");
    this.curiosityDirection *= -1;
    this.curiosityPauseUntil = now + tuning.curiousPauseMs;
    return this.getStatus();
  }

  getStatus() {
    return {
      followEnabled: this.followEnabled,
      curiosityEnabled: this.curiosityEnabled,
      automaticPitchEnabled: DEFAULTS.automaticPitchEnabled,
      lastYaw: this.lastYaw,
      lastPitch: this.lastPitch,
      faceYawOffset: this.faceYawOffset,
      facePitchOffset: this.facePitchOffset,
      lastObservation: this.lastObservation
    };
  }

  getTuning() {
    return DEFAULTS;
  }

  sendYaw(angle, label) {
    if (!this.robotClient?.isConnected?.()) return;
    const safe = clamp(angle, 0, DEFAULTS.yawMaxAngle);
    this.lastYaw = safe;
    this.robotClient.sendHeadYaw({ angle: safe, durationMs: 180, label });
  }

  resetFaceTrackingState() {
    this.faceYawOffset = 0;
    this.facePitchOffset = 0;
    this.smoothedFaceX = null;
    this.smoothedFaceY = null;
    this.lastFaceSeenAt = 0;
  }

  move(direction, {
    degrees = GIMBAL_USER_MOVE_DEGREES,
    durationMs = GIMBAL_USER_MOVE_DURATION_MS,
    label = "agent_gimbal_move",
    userInitiated = false
  } = {}) {
    if (!this.robotClient?.isConnected?.()) {
      return { ok: false, reason: "robot_not_connected" };
    }

    const normalizedDirection = String(direction ?? "").trim().toLowerCase();
    if (!["left", "right", "up", "down", "center"].includes(normalizedDirection)) {
      return { ok: false, reason: "invalid_gimbal_direction" };
    }
    if (userInitiated !== true) {
      return { ok: false, reason: "gimbal_move_requires_user_command" };
    }

    this.holdManualControl(Math.max(Number(durationMs) || 0, 220) + 900);

    // The mounted servos are wired mirrored: the canonical direction must be
    // inverted before it reaches the firmware so "look left" turns the head
    // physically left (and likewise for pitch up/down).
    const physicalDirection = INVERTED_DIRECTIONS[normalizedDirection] ?? normalizedDirection;
    const messageId = this.robotClient.sendGimbalMove({
      direction: physicalDirection,
      degrees,
      durationMs,
      label,
      pitchAuthority: ["up", "down", "center"].includes(normalizedDirection)
        ? "user_command"
        : undefined
    });

    if (normalizedDirection === "center") {
      this.lastYaw = 0;
      this.lastPitch = 0;
    }

    return { ok: true, messageId, direction: normalizedDirection, physicalDirection };
  }

}

// Servo-level direction inversion (mirrored wiring): canonical user intent
// must be flipped before the firmware drives the servos.
const INVERTED_DIRECTIONS = Object.freeze({
  left: "right",
  right: "left",
  up: "down",
  down: "up",
  center: "center"
});

function mapUserGimbalDirection(direction) { return direction; }

function clamp(value, min, max, fallback = min) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
