/** Storage bucket, parse route and execute route must use the same ceiling. */
export const MAX_SIE_FILE_SIZE_BYTES = 50 * 1024 * 1024

export const ALLOWED_SIE_FILE_EXTENSIONS = ['.sie', '.se'] as const

export function hasAllowedSIEFileExtension(filename: string): boolean {
  const normalized = filename.toLocaleLowerCase('sv-SE')
  return ALLOWED_SIE_FILE_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  )
}
