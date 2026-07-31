export const URGENT = 2;
export const WARN = 1;
export const INFO = 0;
export const LOW = -1;
export const LOWEST = -2;
export const NONE = -3;

const LEVEL_DISPLAY = new Map<number, string>([
  [URGENT, "Urgent"],
  [WARN, "Warning"],
  [INFO, "Info"],
  [LOW, "Low"],
  [LOWEST, "Lowest"],
  [NONE, "None"],
]);

/** English identity-translation form of locked levels.toDisplay(). */
export function levelToDisplay(level: unknown): string {
  return typeof level === "number" ? LEVEL_DISPLAY.get(level) ?? "Unknown" : "Unknown";
}

export function levelToLowerCase(level: unknown): string {
  return levelToDisplay(level).toLowerCase();
}

export function isAlarmLevel(level: unknown): boolean {
  return level === WARN || level === URGENT;
}

export function levelToStatusClass(level: unknown): "current" | "warn" | "urgent" {
  if (level === WARN) return "warn";
  if (level === URGENT) return "urgent";
  return "current";
}
