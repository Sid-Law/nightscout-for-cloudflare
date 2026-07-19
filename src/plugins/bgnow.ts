import type { RealtimeDocument } from "../realtime/ddata-snapshot";

const MMOL_TO_MGDL = 18.01559;
const BUCKET_OFFSET_MS = 2.5 * 60_000;
const OMITTED_BUCKET_FIELDS = new Set(["index", "fromMills", "toMills"]);

export type NightscoutGlucoseUnits = "mg/dl" | "mmol";

export interface BgnowProperties extends Record<string, unknown> {
  bgnow: RealtimeDocument;
  delta: RealtimeDocument | null;
  buckets?: RealtimeDocument[];
}

function cloneDocument(document: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(document)) as RealtimeDocument;
}

function omitBucketFields(document: RealtimeDocument | undefined): RealtimeDocument {
  if (document === undefined) return {};
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !OMITTED_BUCKET_FIELDS.has(key)),
  );
}

function scaleMgdl(mgdl: unknown, units: NightscoutGlucoseUnits): number {
  const numeric = Number(mgdl);
  if (units !== "mmol" || !numeric) return numeric;
  return Number((Math.round(numeric / MMOL_TO_MGDL * 10) / 10).toFixed(1));
}

function roundBg(value: number, units: NightscoutGlucoseUnits): number {
  return units === "mmol" ? Math.round(value * 10) / 10 : Math.round(value);
}

function scaleEntry(
  entry: RealtimeDocument,
  units: NightscoutGlucoseUnits,
): RealtimeDocument {
  const scaled = cloneDocument(entry);
  if (scaled.scaled === undefined) {
    scaled.scaled = units === "mmol"
      ? scaled.mmol || scaleMgdl(scaled.mgdl, units)
      : scaled.mgdl || Math.round(Number(scaled.mmol) * MMOL_TO_MGDL);
  }
  return scaled;
}

function analyzeBucket(bucket: RealtimeDocument): RealtimeDocument {
  const entries = bucket.sgvs as RealtimeDocument[];
  if (entries.length === 0) return { ...bucket, isEmpty: true };

  const valid = entries.filter((entry) => entry !== null && Number(entry.mgdl) > 39);
  const details: RealtimeDocument = {};
  const mean = valid.reduce((sum, entry) => sum + Number(entry.mgdl), 0) / valid.length;
  if (mean && typeof mean === "number") details.mean = mean;
  const mostRecent = valid.reduce<RealtimeDocument | undefined>(
    (latest, entry) => latest === undefined || Number(entry.mills) > Number(latest.mills)
      ? entry
      : latest,
    undefined,
  );
  if (mostRecent !== undefined) {
    details.last = mostRecent.mgdl;
    details.mills = mostRecent.mills;
  }
  const errors = entries.filter((entry) => !entry || !entry.mgdl || Number(entry.mgdl) < 39);
  if (errors.length > 0) details.errors = errors;
  return { ...details, ...bucket };
}

/** Direct stateless port of locked plugins/bgnow.fillBuckets(). */
export function fillBgnowBuckets(
  input: RealtimeDocument[],
  now: number,
  units: NightscoutGlucoseUnits,
  bucketCount = 4,
  bucketMins = 5,
): RealtimeDocument[] {
  const sgvs = input.map(cloneDocument).sort((left, right) =>
    Number(left.mills) - Number(right.mills)
  );
  const last = [...sgvs].reverse().find((entry) => Number(entry.mills) <= now);
  if (last === undefined) return [];
  const bucketMs = bucketMins * 60_000;
  const buckets: RealtimeDocument[] = Array.from({ length: bucketCount }, (_unused, index) => {
    const fromMills = Number(last.mills) - BUCKET_OFFSET_MS - index * bucketMs;
    return { index, fromMills, toMills: fromMills + bucketMs, sgvs: [] };
  });

  for (let index = sgvs.length - 1; index >= 0; index -= 1) {
    const entry = sgvs[index]!;
    if (Number(entry.mills) > now) continue;
    const bucket = buckets.find((candidate) =>
      Number(entry.mills) >= Number(candidate.fromMills) &&
      Number(entry.mills) <= Number(candidate.toMills)
    );
    if (bucket === undefined) break;
    (bucket.sgvs as RealtimeDocument[]).push(scaleEntry(entry, units));
  }
  return buckets.map(analyzeBucket);
}

/** Direct stateless port of locked plugins/bgnow.calcDelta(). */
export function calculateBgnowDelta(
  recent: RealtimeDocument | undefined,
  previous: RealtimeDocument | undefined,
  units: NightscoutGlucoseUnits,
): RealtimeDocument | null {
  if (recent === undefined || Object.keys(recent).length === 0) return null;
  if (previous === undefined || Object.keys(previous).length === 0) return null;
  const absolute = Number(recent.mean) - Number(previous.mean);
  const elapsedMins = (Number(recent.mills) - Number(previous.mills)) / 60_000;
  const interpolated = elapsedMins > 9;
  const mean5MinsAgo = interpolated
    ? Number(recent.mean) - absolute / elapsedMins * 5
    : Number(recent.mean) - absolute;
  const mgdl = Math.round(Number(recent.mean) - mean5MinsAgo);
  const scaled = units === "mmol"
    ? roundBg(scaleMgdl(recent.mean, units) - scaleMgdl(mean5MinsAgo, units), units)
    : mgdl;
  return {
    absolute,
    elapsedMins,
    interpolated,
    mean5MinsAgo,
    times: { recent: recent.mills, previous: previous.mills },
    mgdl,
    scaled,
    display: `${scaled >= 0 ? "+" : ""}${scaled}`,
    previous: omitBucketFields(previous),
  };
}

/** Runs the locked bgnow property offers over an ordered SGV snapshot. */
export function calculateBgnowProperties(
  sgvs: RealtimeDocument[],
  now: number,
  units: NightscoutGlucoseUnits,
): BgnowProperties {
  const buckets = fillBgnowBuckets(sgvs, now, units);
  if (buckets.length === 0) return { bgnow: { sgvs: [] }, delta: null };
  const recent = buckets.find((bucket) => !bucket.isEmpty);
  const previous = recent === undefined
    ? undefined
    : buckets.find((bucket) =>
      !bucket.isEmpty && Number(bucket.mills) < Number(recent.mills)
    );
  return {
    bgnow: omitBucketFields(recent),
    delta: calculateBgnowDelta(recent, previous, units),
    buckets,
  };
}

/** Locked updateVisualisation payload, kept pure for official client contracts. */
export function bgnowDeltaVisualization(
  delta: RealtimeDocument | null,
  units: NightscoutGlucoseUnits,
): RealtimeDocument {
  const unitsLabel = units === "mmol" ? "mmol/L" : "mg/dl";
  let display = delta?.display as string | undefined;
  const info: RealtimeDocument[] = [];
  if (delta?.interpolated) {
    display += " *";
    info.push(
      { label: "Elapsed Time", value: `${Math.round(Number(delta.elapsedMins))} mins` },
      {
        label: "Absolute Delta",
        value: `${roundBg(scaleMgdl(delta.absolute, units), units)} ${unitsLabel}`,
      },
      {
        label: "Interpolated",
        value: `${roundBg(scaleMgdl(delta.mean5MinsAgo, units), units)} ${unitsLabel}`,
      },
    );
  }
  return { value: display, label: unitsLabel, info: info.length === 0 ? null : info };
}
