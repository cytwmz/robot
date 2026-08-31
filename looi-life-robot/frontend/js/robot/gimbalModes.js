export const GIMBAL_MODES = Object.freeze(["curious_idle", "off"]);

const GIMBAL_MODE_SET = new Set(GIMBAL_MODES);

export function normalizeGimbalMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return GIMBAL_MODE_SET.has(mode) ? mode : "";
}

export function gimbalModeLabel(mode) {
  switch (normalizeGimbalMode(mode)) {
    case "curious_idle":
      return "Curious idle gimbal enabled.";
    case "off":
      return "Automatic gimbal behavior disabled.";
    default:
      return "Invalid gimbal mode.";
  }
}

export function inferGimbalMode(value) {
  const text = String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "";

  if (
    /\b(?:stop|turn off|disable|cancel)\s+(?:gimbal|automatic\s+looking)\b/i.test(text) ||
    /(?:关闭|停止|取消).{0,12}(?:自动观察|好奇观察|云台自动)/u.test(text)
  ) {
    return "off";
  }

  if (
    /(?:自动|好奇|随便).{0,12}(?:左右看看|看看|观察|扫描)/u.test(text) ||
    /\b(?:look around|curious(?:ly)? look|idle look|scan around)\b/i.test(text)
  ) {
    return "curious_idle";
  }

  return "";
}
