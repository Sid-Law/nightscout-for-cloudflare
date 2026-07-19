import type { RealtimeSnapshot } from "./session-service";

const DEVICE_TYPE_FIELDS = ["uploader", "pump", "openaps", "loop", "xdripjs"] as const;

export type RealtimeDocument = Record<string, unknown>;

export interface RealtimeDdataInput {
  sgvs: unknown[];
  cals?: unknown[];
  profiles: RealtimeDocument[];
  mbgs?: unknown[];
  food: RealtimeDocument[];
  treatments: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  dbstats?: Record<string, never>;
}

/**
 * JSON state exposed by locked Nightscout v15.0.7's `lib/data/ddata.js`.
 * Methods from the Node singleton are represented by the pure adapter
 * functions below so request state never leaks through a Worker global.
 */
export interface LegacyRealtimeDdataState {
  sgvs: RealtimeDocument[];
  treatments: RealtimeDocument[];
  mbgs: RealtimeDocument[];
  cals: RealtimeDocument[];
  profiles: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  food: RealtimeDocument[];
  activity: RealtimeDocument[];
  dbstats: Record<string, unknown>;
  lastUpdated: number;
}

function cloneDocument(document: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(document)) as RealtimeDocument;
}

function cloneDocuments(documents: RealtimeDocument[]): RealtimeDocument[] {
  return documents.map(cloneDocument);
}

/** Creates the same empty data buckets as the locked upstream ddata module. */
export function createLegacyRealtimeDdataState(): LegacyRealtimeDdataState {
  return {
    sgvs: [],
    treatments: [],
    mbgs: [],
    cals: [],
    profiles: [],
    devicestatus: [],
    food: [],
    activity: [],
    dbstats: {},
    lastUpdated: 0,
  };
}

/** JSON-safe equivalent of upstream ddata.clone(). */
export function cloneLegacyRealtimeDdataState(
  state: LegacyRealtimeDdataState,
): LegacyRealtimeDdataState {
  return JSON.parse(JSON.stringify(state)) as LegacyRealtimeDdataState;
}

export function normalizeRealtimeDocument(
  document: RealtimeDocument,
): RealtimeDocument {
  const normalized = cloneDocument(document);
  if (normalized.mills === undefined) {
    const source = normalized.created_at ?? normalized.sysTime;
    if (typeof source === "string" || typeof source === "number") {
      const mills = typeof source === "number" ? source : Date.parse(source);
      if (Number.isFinite(mills)) normalized.mills = mills;
    }
  }
  if (normalized.duration === undefined && normalized.durationInMilliseconds !== undefined) {
    const durationMs = Number(normalized.durationInMilliseconds);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      normalized.duration = Math.round(durationMs / 60_000);
    }
  }
  if (normalized.endmills == null && typeof normalized.mills === "number") {
    const durationMs = Number(normalized.durationInMilliseconds);
    const durationMins = Number(normalized.duration);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      normalized.endmills = normalized.mills + durationMs;
    } else if (Number.isFinite(durationMins)) {
      normalized.endmills = normalized.mills + durationMins * 60_000;
    }
  }
  return normalized;
}

/**
 * Pure equivalent of locked processRawDataForRuntime(). The upstream helper
 * accepts either an array or a keyed object and returns a deep-cloned value.
 */
export function processRealtimeRawDataForRuntime<
  T extends RealtimeDocument[] | Record<string, RealtimeDocument>,
>(data: T): T {
  if (Array.isArray(data)) {
    return data.map(normalizeRealtimeDocument) as T;
  }

  return Object.fromEntries(
    Object.entries(data).map(([key, document]) => [key, normalizeRealtimeDocument(document)]),
  ) as T;
}

/**
 * Pure equivalent of locked idMergePreferNew(): new documents win when an
 * ObjectId or an identifier collides; unmatched old documents are appended.
 */
export function mergeRealtimeDocumentsPreferNew(
  oldData: RealtimeDocument[] | undefined,
  newData: RealtimeDocument[] | undefined,
): RealtimeDocument[] | undefined {
  if (newData === undefined) return oldData;
  if (oldData === undefined) return newData;

  const merged = cloneDocuments(newData);
  for (const oldDocument of oldData) {
    const found = newData.some((newDocument) => {
      const oldId = oldDocument._id;
      const newId = newDocument._id;
      const idMatches = Boolean(oldId) && Boolean(newId) && String(oldId) === String(newId);
      const identifierMatches = Boolean(oldDocument.identifier) &&
        oldDocument.identifier === newDocument.identifier;
      return idMatches || identifierMatches;
    });
    if (!found) merged.push(oldDocument);
  }
  return merged;
}

export function normalizeRealtimeDeviceStatus(
  document: RealtimeDocument,
): RealtimeDocument {
  const normalized = normalizeRealtimeDocument(document);
  if (Object.prototype.hasOwnProperty.call(normalized, "uploaderBattery")) {
    normalized.uploader = { battery: normalized.uploaderBattery };
    delete normalized.uploaderBattery;
  }
  return normalized;
}

export function selectRealtimeRecentDeviceStatus(
  documents: RealtimeDocument[],
  now: number,
): RealtimeDocument[] {
  const statuses = documents.map(normalizeRealtimeDeviceStatus);
  const pairs = new Map<string, { device: unknown; type: string }>();
  for (const status of statuses) {
    for (const type of DEVICE_TYPE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(status, type)) continue;
      pairs.set(`${String(status.device)}\u0000${type}`, { device: status.device, type });
    }
  }

  const merged: RealtimeDocument[] = [];
  for (const pair of pairs.values()) {
    const selected = statuses
      .filter((status) =>
        status.device === pair.device &&
        Object.prototype.hasOwnProperty.call(status, pair.type) &&
        typeof status.mills === "number" &&
        status.mills <= now,
      )
      .sort((left, right) => Number(left.mills) - Number(right.mills))
      .slice(-10);
    merged.push(...selected);
  }

  const seenIds = new Set<string>();
  return merged
    .filter((status) => {
      if (typeof status._id !== "string") return true;
      if (seenIds.has(status._id)) return false;
      seenIds.add(status._id);
      return true;
    })
    .sort((left, right) => Number(left.mills) - Number(right.mills));
}

/** Mirrors the unfiltered, runtime-normalized lastData.devicestatus array. */
export function buildRealtimeRetroDeviceStatus(
  documents: RealtimeDocument[],
): RealtimeDocument[] {
  return documents
    .map(normalizeRealtimeDeviceStatus)
    .sort((left, right) => Number(left.mills) - Number(right.mills));
}

export function filterRealtimePublicProfiles(
  documents: RealtimeDocument[],
): RealtimeDocument[] {
  const profiles = documents.map(cloneDocument);
  const first = profiles[0];
  if (
    first !== undefined &&
    typeof first.store === "object" &&
    first.store !== null &&
    !Array.isArray(first.store)
  ) {
    const profileStore = first.store as Record<string, unknown>;
    for (const name of Object.keys(profileStore)) {
      // Preserve the locked v15.0.7 `> 0` condition exactly.
      if (name.indexOf("@@@@@") > 0) delete profileStore[name];
    }
  }
  return profiles;
}

/** Mirrors locked ddata.dataWithRecentStatuses() field order and filtering. */
export function buildRealtimeDdataSnapshot(
  input: RealtimeDdataInput,
  now: number,
): RealtimeSnapshot {
  return {
    devicestatus: selectRealtimeRecentDeviceStatus(input.devicestatus, now),
    sgvs: input.sgvs,
    cals: input.cals ?? [],
    profiles: filterRealtimePublicProfiles(input.profiles),
    mbgs: input.mbgs ?? [],
    food: input.food.map(normalizeRealtimeDocument),
    treatments: input.treatments.map(normalizeRealtimeDocument),
    dbstats: input.dbstats ?? {},
  };
}
