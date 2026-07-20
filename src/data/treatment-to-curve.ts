import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { MMOL_TO_MGDL } from "../runtime/units";
import { calculateRawBg } from "../plugins/rawbg";

const MAX_BG_MMOL = 22;
const MAX_BG_MGDL = MAX_BG_MMOL * MMOL_TO_MGDL;

export interface TreatmentCurveData {
  sgvs: RealtimeDocument[];
  cals?: RealtimeDocument[];
  treatments: RealtimeDocument[];
}

export interface TreatmentCurveSettings {
  units?: unknown;
  rawBgEnabled?: boolean;
}

function mgdlValue(entry: RealtimeDocument | undefined): number {
  return entry && Number(entry.mgdl) >= 39 ? Number(entry.mgdl) : 0;
}

function rawValue(
  entry: RealtimeDocument | undefined,
  calibration: RealtimeDocument | undefined,
  enabled: boolean,
): number {
  return entry !== undefined && calibration !== undefined && enabled
    ? calculateRawBg(entry, calibration)
    : 0;
}

/**
 * Direct Workers-safe port of locked lib/data/treatmenttocurve.js.
 *
 * The function intentionally mutates Treatment display fields just as the
 * upstream dataloader does. It does not calculate a dose; it only places each
 * already-recorded Treatment marker on the surrounding glucose curve.
 */
export function fitTreatmentsToBgCurve(
  data: TreatmentCurveData,
  settings: TreatmentCurveSettings = {},
): void {
  const rawEnabled = settings.rawBgEnabled === true;
  const calibration = data.cals?.at(-1);
  for (const treatment of data.treatments) {
    const withBgs = data.sgvs.filter((entry) => Number(entry.mgdl) > 39 || rawEnabled);
    const before = [...withBgs].reverse()
      .find((entry) => Number(entry.mills) <= Number(treatment.mills));
    const after = withBgs.find((entry) => Number(entry.mills) >= Number(treatment.mills));
    const beforeMgdl = mgdlValue(before) || rawValue(before, calibration, rawEnabled);
    const afterMgdl = mgdlValue(after) || rawValue(after, calibration, rawEnabled);
    let calculated = 0;
    if (beforeMgdl && afterMgdl) calculated = (beforeMgdl + afterMgdl) / 2;
    else if (beforeMgdl) calculated = beforeMgdl;
    else if (afterMgdl) calculated = afterMgdl;
    const curveMgdl = Math.round(calculated) || 180;

    treatment.eventType = treatment.eventType || "";
    if (treatment.glucose && Number.isNaN(Number(treatment.glucose))) {
      console.warn("found an invalid glucose value", treatment);
    } else if (treatment.glucose && treatment.units) {
      if (treatment.units === "mmol") {
        treatment.mmol = Math.min(Number(treatment.glucose), MAX_BG_MMOL);
      } else {
        treatment.mgdl = Math.min(Number(treatment.glucose), MAX_BG_MGDL);
      }
    } else if (treatment.glucose) {
      const units = settings.units === "mmol" ? "mmol" : "mgdl";
      treatment[units] = settings.units === "mmol"
        ? Math.min(Number(treatment.glucose), MAX_BG_MMOL)
        : Math.min(Number(treatment.glucose), MAX_BG_MGDL);
    } else {
      treatment.mgdl = curveMgdl;
    }
  }
}
