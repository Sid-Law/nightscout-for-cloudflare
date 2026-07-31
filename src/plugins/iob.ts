import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { nightscoutTimes } from "../runtime/times";

export interface IobProfile {
  getDIA(time?: unknown, specProfile?: string): number | undefined;
  getSensitivity(time?: unknown, specProfile?: string): number | undefined;
}

export interface IobProperty extends RealtimeDocument {
  iob: number;
  display: string;
  displayLine: string;
}

export const IOB_RECENCY_THRESHOLD_MS = nightscoutTimes.mins(30).msecs;

export const IOB_INTENTS = [{
  intent: "MetricNow",
  metrics: ["iob", "insulin on board"],
}] as const;

export const IOB_ROLLUPS = [{
  rollupGroup: "Status",
  rollupName: "current iob",
}] as const;

function record(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function nestedRecord(document: RealtimeDocument, first: string, second: string): unknown {
  return record(document[first])?.[second];
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) || typeof value === "string") return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return true;
}

function momentMills(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function inputMills(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

function roundThree(value: number): number {
  // This is the numeric equivalent of the locked
  // +(Math.round(value + "e+3") + "e-3") expression.
  return Number(`${Math.round(Number(`${value}e+3`))}e-3`);
}

/** Locked utils.toFixed(), including its zero and negative-zero behavior. */
export function nightscoutIobFixed(value: unknown): string {
  if (!value) return "0";
  const fixed = Number(value).toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

/** Direct request-local port of locked plugins/iob.fromDeviceStatus(). */
export function iobFromDeviceStatus(
  deviceStatus: RealtimeDocument,
): RealtimeDocument {
  let openapsIob = nestedRecord(deviceStatus, "openaps", "iob");
  const loopIob = nestedRecord(deviceStatus, "loop", "iob");
  const pumpIob = nestedRecord(deviceStatus, "pump", "iob");

  if (typeof openapsIob === "object" && openapsIob !== null) {
    if (Array.isArray(openapsIob)) openapsIob = openapsIob[0];
    const value = record(openapsIob);
    if (value === undefined || isEmpty(value)) return {};
    const timestamp = value.time ? value.time : value.timestamp;
    return {
      iob: value.iob,
      basaliob: value.basaliob,
      activity: value.activity,
      source: "OpenAPS",
      device: deviceStatus.device,
      mills: momentMills(timestamp),
    };
  }

  const loop = record(loopIob);
  if (loop !== undefined) {
    return {
      iob: loop.iob,
      source: "Loop",
      device: deviceStatus.device,
      mills: momentMills(loop.timestamp),
    };
  }

  const pump = record(pumpIob);
  if (pump !== undefined) {
    return {
      // Preserve the locked truthy fallback: a numeric zero uses bolusiob.
      iob: pump.iob || pump.bolusiob,
      source: deviceStatus.connect !== undefined ? "MM Connect" : undefined,
      device: deviceStatus.device,
      mills: deviceStatus.mills,
    };
  }
  return {};
}

export function isIobDeviceStatusAvailable(
  deviceStatuses: RealtimeDocument[] = [],
): boolean {
  return deviceStatuses.map(iobFromDeviceStatus).some((status) => !isEmpty(status));
}

/** Direct request-local port of locked plugins/iob.lastIOBDeviceStatus(). */
export function lastIobDeviceStatus(
  deviceStatuses: RealtimeDocument[] = [],
  suppliedTime: number | Date = Date.now(),
): RealtimeDocument {
  const time = inputMills(suppliedTime);
  const futureMills = time + nightscoutTimes.mins(5).msecs;
  const recentMills = time - IOB_RECENCY_THRESHOLD_MS;
  const statuses = deviceStatuses
    .filter((status) =>
      Number(status.mills) <= futureMills && Number(status.mills) >= recentMills
    )
    .map(iobFromDeviceStatus)
    .filter((status) => !isEmpty(status))
    .sort((left, right) => Number(left.mills) - Number(right.mills));
  const loop = statuses.filter((status) => status.source === "Loop");
  return loop.at(-1) ?? statuses.at(-1) ?? {};
}

export function iobDeviceStatusesInTimeRange(
  deviceStatuses: RealtimeDocument[] = [],
  from: number,
  to: number,
): RealtimeDocument[] {
  return deviceStatuses
    .filter((status) => Number(status.mills) > from && Number(status.mills) < to)
    .map(iobFromDeviceStatus)
    .filter((status) => !isEmpty(status))
    .sort((left, right) => Number(left.mills) - Number(right.mills));
}

/** Direct port of locked plugins/iob.calcTreatment(). */
export function calculateIobTreatment(
  treatment: RealtimeDocument,
  profile: IobProfile | undefined,
  suppliedTime: number | Date,
  specProfile?: string,
): { iobContrib: number; activityContrib: number } {
  const time = inputMills(suppliedTime);
  let dia = 3;
  let sensitivity = 0;
  if (profile !== undefined) {
    dia = profile.getDIA(time, specProfile) || 3;
    sensitivity = Number(profile.getSensitivity(time, specProfile));
  }
  const scaleFactor = 3 / dia;
  const peak = 75;
  const result = { iobContrib: 0, activityContrib: 0 };
  if (treatment.insulin) {
    const minAgo = scaleFactor * (time - Number(treatment.mills)) / 1_000 / 60;
    const insulin = Number(treatment.insulin);
    if (minAgo < peak) {
      const x1 = minAgo / 5 + 1;
      result.iobContrib = insulin * (1 - 0.001852 * x1 * x1 + 0.001852 * x1);
      result.activityContrib = sensitivity * insulin * (2 / dia / 60 / peak) * minAgo;
    } else if (minAgo < 180) {
      const x2 = (minAgo - 75) / 5;
      result.iobContrib = insulin * (0.001323 * x2 * x2 - 0.054233 * x2 + 0.55556);
      result.activityContrib = sensitivity * insulin *
        (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * 3 - peak));
    }
  }
  return result;
}

/** Direct request-local port of locked plugins/iob.fromTreatments(). */
export function calculateIobFromTreatments(
  treatments: RealtimeDocument[] = [],
  profile: IobProfile | undefined,
  suppliedTime: number | Date = Date.now(),
  specProfile?: string,
): RealtimeDocument {
  const time = inputMills(suppliedTime);
  let totalIob = 0;
  let totalActivity = 0;
  let lastBolus: RealtimeDocument | null = null;
  for (const treatment of treatments) {
    if (Number(treatment.mills) <= time) {
      const contribution = calculateIobTreatment(treatment, profile, time, specProfile);
      if (contribution.iobContrib > 0) lastBolus = treatment;
      if (contribution.iobContrib) totalIob += contribution.iobContrib;
      if (contribution.activityContrib) totalActivity += contribution.activityContrib;
    }
  }
  return {
    iob: roundThree(totalIob),
    activity: totalActivity,
    lastBolus,
    source: "Care Portal",
  };
}

function withDisplay(result: RealtimeDocument): RealtimeDocument {
  if (isEmpty(result) || result.iob === undefined) return {};
  const display = nightscoutIobFixed(result.iob);
  return { ...result, display, displayLine: `IOB: ${display}U` };
}

/** Direct request-local port of locked plugins/iob.calcTotal(). */
export function calculateIobTotal(
  treatments: RealtimeDocument[] = [],
  deviceStatuses: RealtimeDocument[] = [],
  profile?: IobProfile,
  suppliedTime: number | Date = Date.now(),
  specProfile?: string,
): RealtimeDocument {
  const time = inputMills(suppliedTime);
  let result = lastIobDeviceStatus(deviceStatuses, time);
  const treatmentResult = treatments.length > 0
    ? calculateIobFromTreatments(treatments, profile, time, specProfile)
    : {};
  if (isEmpty(result)) {
    result = treatmentResult;
  } else if (treatmentResult.iob) {
    result.treatmentIob = roundThree(Number(treatmentResult.iob));
  }
  if (result.iob) result.iob = roundThree(Number(result.iob));
  return withDisplay(result);
}

export function iobAssistantResponses(property: RealtimeDocument): {
  intent: { title: string; response: string };
  rollup: { results: string; priority: 2 };
} {
  const value = property.iob !== 0
    ? `${nightscoutIobFixed(property.iob)} units of insulin on board`
    : "no insulin on board";
  return {
    intent: {
      title: "Current IOB",
      response: `You have ${value}`,
    },
    rollup: {
      results: `and you have ${value}.`,
      priority: 2,
    },
  };
}
