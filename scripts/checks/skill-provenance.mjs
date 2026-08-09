#!/usr/bin/env node
/**
 * Skill supply-chain guard (audit finding M-02).
 *
 * The repository keeps three views of the installed agent skills:
 *
 *   1. `.agents/skills/<name>/SKILL.md`   — the files actually installed
 *   2. `.agents/SKILLS_LOCK.sha256`       — integrity (did the file change?)
 *   3. `skills-lock.json`                 — provenance (where did it come from?)
 *   4. `.agents/SKILLS_SOURCES.tsv`       — the human-readable source registry
 *
 * A checksum proves a file did not change; it does not prove where the file
 * came from. The audit found the TSV documenting only 35 of 41 skills, so six
 * skills had no source row even though the lock file knew their origin.
 *
 * This guard enforces:
 *   set(disk) == set(SKILLS_LOCK) == set(skills-lock.json) == set(SOURCES.tsv)
 * plus a recorded, non-empty source and hash for every skill, and that the
 * recorded SHA-256 still matches the file on disk.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const SKILLS_DIR = '.agents/skills'
const LOCK_SHA = '.agents/SKILLS_LOCK.sha256'
const SOURCES_TSV = '.agents/SKILLS_SOURCES.tsv'
const LOCK_JSON = 'skills-lock.json'

const failures = []

function fail(message) {
  failures.push(message)
}

function sorted(set) {
  return [...set].sort()
}

function diff(label, a, b, aName, bName) {
  const onlyA = sorted(new Set([...a].filter((x) => !b.has(x))))
  const onlyB = sorted(new Set([...b].filter((x) => !a.has(x))))
  if (onlyA.length) fail(`${label}: in ${aName} but not ${bName}: ${onlyA.join(', ')}`)
  if (onlyB.length) fail(`${label}: in ${bName} but not ${aName}: ${onlyB.join(', ')}`)
}

// 1. Skills present on disk.
if (!existsSync(SKILLS_DIR)) {
  console.error(`✗ skill-provenance: ${SKILLS_DIR} not found`)
  process.exit(1)
}
const disk = new Set(
  readdirSync(SKILLS_DIR).filter((name) => {
    const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md')
    return existsSync(skillFile) && statSync(skillFile).isFile()
  }),
)

// 2. Checksum lock: "<sha256>  .agents/skills/<name>/SKILL.md"
const lockShaEntries = new Map()
for (const line of readFileSync(LOCK_SHA, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed) continue
  const match = trimmed.match(/^([0-9a-f]{64})\s+\.agents\/skills\/([^/]+)\/SKILL\.md$/)
  if (!match) {
    fail(`${LOCK_SHA}: unparseable line: ${trimmed.slice(0, 100)}`)
    continue
  }
  lockShaEntries.set(match[2], match[1])
}

// 3. Provenance lock.
const lockJson = JSON.parse(readFileSync(LOCK_JSON, 'utf8'))
const lockJsonSkills = new Map(Object.entries(lockJson.skills ?? {}))

// 4. Human-readable source registry.
const tsvLines = readFileSync(SOURCES_TSV, 'utf8').split('\n').filter((l) => l.trim())
const header = tsvLines.shift()?.split('\t') ?? []
for (const column of ['skill', 'source', 'installed_at_utc']) {
  if (!header.includes(column)) fail(`${SOURCES_TSV}: missing required column '${column}'`)
}
const tsvSkills = new Map()
for (const line of tsvLines) {
  const cells = line.split('\t')
  const row = Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']))
  if (tsvSkills.has(row.skill)) fail(`${SOURCES_TSV}: duplicate row for '${row.skill}'`)
  tsvSkills.set(row.skill, row)
}

// Set equality across all four views.
diff('skill set', disk, new Set(lockShaEntries.keys()), 'disk', LOCK_SHA)
diff('skill set', disk, new Set(lockJsonSkills.keys()), 'disk', LOCK_JSON)
diff('skill set', disk, new Set(tsvSkills.keys()), 'disk', SOURCES_TSV)

// Per-skill provenance and integrity.
for (const name of sorted(disk)) {
  const meta = lockJsonSkills.get(name)
  if (meta && !String(meta.source ?? '').trim()) {
    fail(`${LOCK_JSON}: '${name}' has no source recorded`)
  }

  const row = tsvSkills.get(name)
  if (row) {
    if (!String(row.source ?? '').trim()) fail(`${SOURCES_TSV}: '${name}' has an empty source`)
    if (!String(row.installed_at_utc ?? '').trim()) {
      fail(`${SOURCES_TSV}: '${name}' has no installed_at_utc`)
    }
    if (meta && row.source && meta.source && row.source !== meta.source) {
      fail(`source mismatch for '${name}': ${SOURCES_TSV}='${row.source}' vs ${LOCK_JSON}='${meta.source}'`)
    }
  }

  const recorded = lockShaEntries.get(name)
  if (recorded) {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
      .digest('hex')
    if (actual !== recorded) {
      fail(`checksum mismatch for '${name}': ${LOCK_SHA} has ${recorded.slice(0, 12)}…, file is ${actual.slice(0, 12)}…`)
    }
  }
}

if (failures.length) {
  console.error('\n✗ skill-provenance: skill registries are not synchronized\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\n  Every installed skill needs a source row. A checksum proves the file did'
    + '\n  not change; it does not prove where the file came from.\n',
  )
  process.exit(1)
}

console.log(`✓ skill-provenance: ${disk.size} skills, all with matching checksum and recorded source`)
