import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every fetchAllRows() call must order its query before paginating. Paging
 * with .range() and no ORDER BY lets Postgres return a row on two pages or on
 * none; the report totals built on it are then silently wrong once a company
 * crosses 1 000 rows. This scans the source so a new unordered call fails CI.
 */
const ROOT = path.resolve(__dirname, '..', '..', '..')
const DIRS = ['lib', 'app', 'extensions']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(abs)
  }
  return out
}

function unorderedCalls(source: string): number[] {
  const lines: number[] = []
  const re = /fetchAllRows\s*(<[^>]*>)?\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    let depth = 1
    let k = match.index + match[0].length
    while (depth > 0 && k < source.length) {
      if (source[k] === '(') depth++
      else if (source[k] === ')') depth--
      k++
    }
    const body = source.slice(match.index, k)
    if (body.includes('.range(') && !body.includes('.order(')) {
      lines.push(source.slice(0, match.index).split('\n').length)
    }
  }
  return lines
}

describe('fetchAllRows call sites', () => {
  it('always order before paginating', () => {
    const offenders: string[] = []
    for (const dir of DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        if (file.endsWith(path.join('supabase', 'fetch-all.ts'))) continue
        for (const line of unorderedCalls(fs.readFileSync(file, 'utf8'))) {
          offenders.push(`${path.relative(ROOT, file)}:${line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
