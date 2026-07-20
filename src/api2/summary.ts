import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import type { RealtimeSnapshot } from "../realtime/session-service";
import { createNightscoutProfileFunctions } from "../profile-functions";

export interface NightscoutSummary {
  sgvs: RealtimeDocument[];
  treatments: {
    tempBasals: RealtimeDocument[];
    treatments: RealtimeDocument[];
    targets: RealtimeDocument[];
  };
  profile: RealtimeDocument;
  state: RealtimeDocument;
}

function cloneDocument(document: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(document)) as RealtimeDocument;
}

function removeProperties(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) removeProperties(item, keys);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (keys.has(key)) delete (value as RealtimeDocument)[key];
    else removeProperties((value as RealtimeDocument)[key], keys);
  }
}

function numericMills(document: RealtimeDocument): number {
  return Number(document.mills);
}

/** Locked api2/summary processSGVs(), with a supplied clock for deterministic DO tests. */
export function processSummarySgvs(
  sgvs: RealtimeDocument[],
  hours: unknown,
  now: number,
): RealtimeDocument[] {
  const result: RealtimeDocument[] = [];
  const dataCap = now - Number(hours) * 60 * 60 * 1_000;
  for (const bg of sgvs) {
    if (numericMills(bg) < dataCap) continue;
    const item: RealtimeDocument = { sgv: bg.mgdl, mills: bg.mills };
    // Preserve the upstream loose comparison: undefined is assigned and then
    // omitted by JSON.stringify, while a real non-1 noise value is retained.
    if (bg.noise != 1) item.noise = bg.noise;
    result.push(item);
  }
  return result;
}

function hhmmAfter(hhmm: string, mills: number): number {
  const date = new Date(mills);
  const sameDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number.parseInt(hhmm.substring(0, 2), 10),
    Number.parseInt(hhmm.substring(3, 8), 10),
  ).getTime();
  return sameDate > mills ? sameDate : sameDate + 24 * 60 * 60 * 1_000;
}

function profileBasalsInWindow(
  basals: RealtimeDocument[],
  start: number,
  end: number,
): RealtimeDocument[] {
  if (basals.length === 0) return [];
  const output: RealtimeDocument[] = [];
  let index = 0;
  const startHhmm = new Date(start).toTimeString().substring(0, 5);
  while (
    index < basals.length - 1 &&
    String(basals[index + 1]!.time) <= startHhmm
  ) {
    index += 1;
  }
  output.push({
    start,
    absolute: Number.parseFloat(String(basals[index]!.value)),
  });

  const nextProfileBasal = (): RealtimeDocument => {
    index = (index + 1) % basals.length;
    const lastStart = Number(output.at(-1)!.start);
    return {
      start: hhmmAfter(String(basals[index]!.time), lastStart),
      absolute: Number.parseFloat(String(basals[index]!.value)),
      profile: 1,
    };
  };
  let next = nextProfileBasal();
  while (Number(next.start) < end) {
    output.push(next);
    next = nextProfileBasal();
  }
  return output;
}

/** Locked basaldataprocessor.filterSameAbsTemps(). */
export function filterSameAbsoluteTemps(
  tempData: RealtimeDocument[],
): RealtimeDocument[] {
  const output: RealtimeDocument[] = [];
  let mergedIndex = 0;
  for (let index = 0; index < tempData.length; index += 1) {
    const temp = tempData[index]!;
    if (index === tempData.length - 1) {
      if (mergedIndex !== index) output.push(temp);
      break;
    }
    const next = tempData[index + 1]!;
    if (
      temp.duration &&
      Number(temp.start) + Number(temp.duration) >= Number(next.start)
    ) {
      if (temp.absolute == next.absolute) {
        temp.duration = Number(next.start) - Number(temp.start) + Number(next.duration);
        index += 1;
        mergedIndex = index;
      } else {
        temp.duration = Number(next.start) - Number(temp.start);
      }
    }
    output.push(temp);
  }
  return output;
}

/** Locked basaldataprocessor.processTempBasals(). */
export function processSummaryTempBasals(
  profile: RealtimeDocument,
  tempBasals: RealtimeDocument[],
  dataCap: number,
  now: number,
): RealtimeDocument[] {
  const profileBasals = Array.isArray(profile.basal)
    ? profile.basal as RealtimeDocument[]
    : [];
  const temps = tempBasals.map((temp) => ({
    start: new Date(String(temp.created_at)).getTime(),
    duration: temp.duration === undefined
      ? 0
      : Number.parseInt(String(temp.duration), 10) * 60 * 1_000,
    absolute: temp.absolute === undefined ? 0 : Number.parseFloat(String(temp.absolute)),
  })).concat([
    { start: now - 24 * 60 * 60 * 1_000, duration: 0, absolute: 0 },
    { start: now, duration: 0, absolute: 0 },
  ]).sort((left, right) => left.start - right.start);

  const output: RealtimeDocument[] = [];
  for (const temp of temps) {
    const last = output.at(-1);
    if (
      last !== undefined &&
      last.duration !== undefined &&
      Number(last.start) + Number(last.duration) < temp.start
    ) {
      output.push(...profileBasalsInWindow(
        profileBasals,
        Number(last.start) + Number(last.duration),
        temp.start,
      ));
    }
    if (temp.duration) output.push(temp);
  }

  let merged = output;
  let previousLength = 1;
  let nextLength = 0;
  while (previousLength !== nextLength) {
    previousLength = merged.length;
    merged = filterSameAbsoluteTemps(merged);
    nextLength = merged.length;
  }
  return merged
    .filter((temp) => Number(temp.start) + Number(temp.duration) > dataCap)
    .map((temp) => ({ ...temp, duration: Number(temp.duration) / 1_000 }));
}

/** Locked api2/summary processTreatments(). */
export function processSummaryTreatments(
  treatments: RealtimeDocument[],
  profile: RealtimeDocument,
  hours: unknown,
  now: number,
): NightscoutSummary["treatments"] {
  const result: NightscoutSummary["treatments"] = {
    tempBasals: [],
    treatments: [],
    targets: [],
  };
  const temps: RealtimeDocument[] = [];
  const dataCap = now - Number(hours) * 60 * 60 * 1_000;

  for (const treatment of treatments) {
    if (treatment.eventType == "Temp Basal") {
      temps.push(treatment);
      continue;
    }
    if (treatment.eventType == "Temporary Target") {
      result.targets.push({
        targetTop: Math.round(Number(treatment.targetTop)),
        targetBottom: Math.round(Number(treatment.targetBottom)),
        duration: Number(treatment.duration) * 60,
        mills: treatment.mills,
      });
      continue;
    }
    if (treatment.insulin || treatment.carbs) {
      if (numericMills(treatment) >= dataCap) {
        const item: RealtimeDocument = { mills: treatment.mills };
        if (!Number.isNaN(Number(treatment.carbs))) item.carbs = treatment.carbs;
        if (!Number.isNaN(Number(treatment.insulin))) item.insulin = treatment.insulin;
        result.treatments.push(item);
      }
    }
  }
  result.tempBasals = processSummaryTempBasals(profile, temps, dataCap, now);
  return result;
}

function currentSummaryProfile(
  profiles: RealtimeDocument[],
  treatments: RealtimeDocument[],
  now: number,
): RealtimeDocument {
  const calculator = createNightscoutProfileFunctions(profiles.map(cloneDocument));
  calculator.updateTreatments(
    treatments
      .filter((treatment) => treatment.eventType === "Profile Switch")
      .map(cloneDocument),
    [],
  );
  const profile = cloneDocument(calculator.getCurrentProfile(now));
  removeProperties(profile, new Set(["timeAsSeconds"]));
  return profile;
}

function summaryState(properties: RealtimeDocument): RealtimeDocument {
  const nested = (name: string, property: string): unknown => {
    const value = properties[name];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as RealtimeDocument)[property]
      : undefined;
  };
  return {
    iob: Math.round(Number(nested("iob", "iob")) * 100) / 100,
    cob: Math.round(Number(nested("cob", "cob"))),
    bwp: Math.round(Number(nested("bwp", "bolusEstimate")) * 100) / 100,
    cage: nested("cage", "age"),
    sage: nested("sage", "age"),
    iage: nested("iage", "age"),
    bage: nested("bage", "age"),
    battery: nested("upbat", "level"),
  };
}

/** Stateless Cloudflare adapter for locked api2/summary/index.js. */
export function buildNightscoutSummary(
  snapshot: RealtimeSnapshot,
  hours: unknown = 6,
  now = Date.now(),
  properties: RealtimeDocument = {},
): NightscoutSummary {
  const profile = currentSummaryProfile(
    snapshot.profiles as RealtimeDocument[],
    snapshot.treatments as RealtimeDocument[],
    now,
  );
  return {
    sgvs: processSummarySgvs(snapshot.sgvs as RealtimeDocument[], hours, now),
    treatments: processSummaryTreatments(
      snapshot.treatments as RealtimeDocument[],
      profile,
      hours,
      now,
    ),
    profile,
    state: summaryState(properties),
  };
}
