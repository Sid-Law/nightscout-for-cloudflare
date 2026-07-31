export type RealtimeDeltaDocument = Record<string, unknown>;

export interface RealtimeDeltaState {
  sgvs?: RealtimeDeltaDocument[];
  treatments?: RealtimeDeltaDocument[];
  mbgs?: RealtimeDeltaDocument[];
  cals?: RealtimeDeltaDocument[];
  profiles?: unknown;
  devicestatus?: RealtimeDeltaDocument[];
  food?: RealtimeDeltaDocument[];
  activity?: RealtimeDeltaDocument[];
  dbstats?: Record<string, unknown>;
  lastUpdated?: number;
  delta?: true;
  [key: string]: unknown;
}

const COMPRESSIBLE_ARRAYS = [
  "sgvs",
  "treatments",
  "mbgs",
  "cals",
  "devicestatus",
] as const;

function cloneDocument(document: RealtimeDeltaDocument): RealtimeDeltaDocument {
  return JSON.parse(JSON.stringify(document)) as RealtimeDeltaDocument;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightObject, key)
      && jsonEqual(leftObject[key], rightObject[key])
  );
}

function treatmentId(document: RealtimeDeltaDocument): string {
  // Every persisted Nightscout treatment has an _id. String() also preserves
  // the locked ObjectId-to-string comparison at the Worker JSON boundary.
  return String(document._id);
}

function treatmentDelta(
  oldArray: RealtimeDeltaDocument[],
  newArray: RealtimeDeltaDocument[],
): RealtimeDeltaDocument[] {
  const result: RealtimeDeltaDocument[] = [];

  for (const incoming of newArray) {
    const incomingId = treatmentId(incoming);
    let found = false;
    let foundDifference = false;
    for (const previous of oldArray) {
      if (incomingId !== treatmentId(previous)) continue;
      found = true;
      const previousCopy = cloneDocument(previous);
      const incomingCopy = cloneDocument(incoming);
      delete previousCopy.mgdl;
      delete incomingCopy.mgdl;
      foundDifference = !jsonEqual(previousCopy, incomingCopy);
      break;
    }
    if (foundDifference) result.push({ ...cloneDocument(incoming), action: "update" });
    if (!found) result.push(cloneDocument(incoming));
  }

  for (const previous of oldArray) {
    const previousId = treatmentId(previous);
    if (newArray.some((incoming) => treatmentId(incoming) === previousId)) continue;
    result.push({ _id: previousId, mills: previous.mills, action: "remove" });
  }

  return result;
}

function glucoseKey(document: RealtimeDeltaDocument): string {
  let key: unknown = document.mills;
  if (document.sgv) key = `${String(key)}sgv${String(document.sgv)}`;
  if (document.mgdl) key = `${String(key)}sgv${String(document.mgdl)}`;
  return String(key);
}

function arrayDelta(
  oldArray: RealtimeDeltaDocument[],
  newArray: RealtimeDeltaDocument[],
): RealtimeDeltaDocument[] {
  const seen = new Set(oldArray.map(glucoseKey));
  return newArray.filter((document) => !seen.has(glucoseKey(document))).map(cloneDocument);
}

function sortByMills(documents: RealtimeDeltaDocument[]): void {
  documents.sort((left, right) => Number(left.mills) - Number(right.mills));
}

/**
 * Stateless port of locked Nightscout v15.0.7 `lib/data/calcdelta.js`.
 *
 * The official server keeps `lastData` in process memory. Callers on Workers
 * must persist that state separately; this function performs only the locked
 * comparison and never owns request or tenant state.
 */
export function calculateRealtimeDelta(
  oldData: RealtimeDeltaState,
  newData: RealtimeDeltaState,
): RealtimeDeltaState {
  if (!oldData.sgvs) return newData;

  const delta: RealtimeDeltaState = { delta: true };
  if (newData.lastUpdated !== undefined) {
    delta.lastUpdated = newData.lastUpdated;
  }
  let changesFound = false;

  for (const name of COMPRESSIBLE_ARRAYS) {
    if (!Object.prototype.hasOwnProperty.call(newData, name)) continue;
    const next = newData[name] ?? [];
    if (!Object.prototype.hasOwnProperty.call(oldData, name)) {
      delta[name] = next.map(cloneDocument);
      changesFound = true;
      continue;
    }
    const previous = oldData[name] ?? [];
    const changed = name === "treatments"
      ? treatmentDelta(previous, next)
      : arrayDelta(previous, next);
    if (changed.length === 0) continue;
    sortByMills(changed);
    delta[name] = changed;
    changesFound = true;
  }

  if (
    Object.prototype.hasOwnProperty.call(newData, "profiles")
    && !jsonEqual(oldData.profiles, newData.profiles)
  ) {
    delta.profiles = newData.profiles;
    changesFound = true;
  }

  return changesFound ? delta : newData;
}
