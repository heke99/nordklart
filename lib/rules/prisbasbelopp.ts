/**
 * Prisbasbelopp per year (socialförsäkringsbalken 2 kap. 6–7 §§), set by
 * the government each autumn. Source: SCB / Skatteverket "Belopp och
 * procentsatser" (checked 2026-09-25). Single source for every rule that
 * derives from PBB — e.g. inventarier av mindre värde = halvt PBB.
 */
export const PRISBASBELOPP: Readonly<Record<number, number>> = {
  2024: 57_300,
  2025: 58_800,
  2026: 59_200,
}

export const LATEST_PBB_YEAR = 2026

/** PBB for `year`, falling back to the latest known year. */
export function getPrisbasbelopp(year: number): number {
  return PRISBASBELOPP[year] ?? PRISBASBELOPP[LATEST_PBB_YEAR]
}

/** Halvt prisbasbelopp (gränsen för inventarier av mindre värde). */
export function getHalfPrisbasbelopp(year: number): number {
  return getPrisbasbelopp(year) / 2
}
