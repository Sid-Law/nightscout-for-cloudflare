import type { NightscoutProfileFunctions } from "../profile-functions";
import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { MMOL_TO_MGDL } from "../runtime/units";

export interface BasalProperty extends RealtimeDocument {
  display: string;
  current: RealtimeDocument;
}

export interface BasalVisualization {
  value: string;
  label: "BASAL";
  info: RealtimeDocument[];
}

export const BASAL_INTENTS = [
  { intent: "MetricNow", metrics: ["basal", "current basal"] },
] as const;

function numeric(value: unknown): number {
  return Number(value);
}

/** Direct request-local port of locked basalprofile.setProperties(). */
export function calculateBasalProperty(
  profile: NightscoutProfileFunctions,
  now: number,
): BasalProperty | undefined {
  if (!profile.hasData() || profile.getBasal(now) === undefined) return undefined;
  const current = profile.getTempBasal(now);
  let tempMark = "";
  if (current.treatment) tempMark += "T";
  if (current.combobolustreatment) tempMark += "C";
  if (tempMark) tempMark += ": ";
  return {
    display: `${tempMark}${numeric(current.totalbasal).toFixed(3)}U`,
    current,
  };
}

/** Pure form of locked basalprofile.updateVisualisation(). */
export function basalVisualization(
  property: BasalProperty | undefined,
  profile: NightscoutProfileFunctions,
  now: number,
  displayUnits: "mg/dl" | "mmol" = "mg/dl",
): BasalVisualization | null {
  if (property === undefined || !profile.hasData() || profile.getBasal(now) === undefined) {
    return null;
  }

  const current = property.current;
  let sensitivity = numeric(profile.getSensitivity(now));
  const profileUnits = profile.getUnits();
  if (displayUnits !== profileUnits) {
    sensitivity *= displayUnits === "mmol" ? 1 / MMOL_TO_MGDL : MMOL_TO_MGDL;
    const decimals = displayUnits === "mmol" ? 10 : 1;
    sensitivity = Math.round(sensitivity * decimals) / decimals;
  }

  const info: RealtimeDocument[] = [
    { label: "Current basal", value: property.display },
    { label: "Sensitivity", value: `${String(sensitivity)} ${displayUnits} / U` },
    { label: "Current Carb Ratio", value: `1 U / ${String(profile.getCarbRatio(now))}g` },
    { label: "Basal timezone", value: profile.getTimezone() || "Timezone not set in profile" },
    { label: "------------", value: "" },
    { label: "Active profile", value: profile.activeProfileToTime(now) },
  ];

  const treatment = current.treatment;
  if (typeof treatment === "object" && treatment !== null && !Array.isArray(treatment)) {
    const temp = treatment as RealtimeDocument;
    const percent = numeric(temp.percent);
    const absolute = numeric(temp.absolute);
    const tempText = temp.percent
      ? `${percent > 0 ? "+" : ""}${String(temp.percent)}%`
      : !Number.isNaN(absolute) ? `${String(temp.absolute)}U/h` : "";
    const remaining = Math.trunc(
      numeric(temp.duration) - (now - numeric(temp.mills)) / 60_000,
    );
    info.push(
      { label: "------------", value: "" },
      { label: "Active temp basal", value: tempText },
      { label: "Active temp basal start", value: new Date(numeric(temp.mills)).toLocaleString() },
      { label: "Active temp basal duration", value: `${Math.trunc(numeric(temp.duration))} mins` },
      { label: "Active temp basal remaining", value: `${remaining} mins` },
      { label: "Basal profile value", value: `${numeric(current.basal).toFixed(3)} U` },
    );
  }

  const combo = current.combobolustreatment;
  if (typeof combo === "object" && combo !== null && !Array.isArray(combo)) {
    const treatment = combo as RealtimeDocument;
    const remaining = Math.trunc(
      numeric(treatment.duration) - (now - numeric(treatment.mills)) / 60_000,
    );
    info.push(
      { label: "------------", value: "" },
      {
        label: "Active combo bolus",
        value: treatment.relative ? `+${String(treatment.relative)}U/h` : "",
      },
      {
        label: "Active combo bolus start",
        value: new Date(numeric(treatment.mills)).toLocaleString(),
      },
      {
        label: "Active combo bolus duration",
        value: `${Math.trunc(numeric(treatment.duration))} mins`,
      },
      { label: "Active combo bolus remaining", value: `${remaining} mins` },
    );
  }

  return { value: property.display, label: "BASAL", info };
}

function relativeEnd(end: unknown, now: number): string {
  const delta = numeric(end) - now;
  const absoluteMinutes = Math.round(Math.abs(delta) / 60_000);
  const phrase = absoluteMinutes === 1 ? "a minute" : `${absoluteMinutes} minutes`;
  return delta >= 0 ? `in ${phrase}` : `${phrase} ago`;
}

/** Locked English virtual-assistant response and rollup priority. */
export function basalAssistantResponse(
  profile: NightscoutProfileFunctions,
  now: number,
  person?: string,
): { title: "Current Basal"; response: string; priority: 1 } {
  const current = profile.getTempBasal(now);
  const preamble = person ? `${person} has a ` : "Your";
  const response = current.treatment
    ? `${preamble} temp basal of ${String(current.totalbasal)} units per hour will end ${
      relativeEnd((current.treatment as RealtimeDocument).endmills, now)
    }`
    : `${preamble} current basal is ${String(current.totalbasal)} units per hour`;
  return { title: "Current Basal", response, priority: 1 };
}
