import { xlsxExportsDisabledResponse } from '@/lib/reports/xlsx-export'

export async function GET() {
  return xlsxExportsDisabledResponse()
}
