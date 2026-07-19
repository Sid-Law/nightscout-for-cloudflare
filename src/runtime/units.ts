export const MMOL_TO_MGDL = 18.01559;

/** Direct port of locked v15.0.7 units.mgdlToMMOL(), including string output. */
export function mgdlToMMOL(mgdl: number | string): string {
  return (Math.round(Number(mgdl) / MMOL_TO_MGDL * 10) / 10).toFixed(1);
}

/** Direct port of locked v15.0.7 units.mmolToMgdl(). */
export function mmolToMgdl(mmol: number | string): number {
  return Math.round(Number(mmol) * MMOL_TO_MGDL);
}
