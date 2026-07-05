/**
 * Default-deny guarantee for the MCP tool surface.
 *
 * Every tool defined in server.ts MUST be either scope-mapped in
 * TOOL_SCOPE_MAP or explicitly listed in UNSCOPED_TOOLS (discovery/meta
 * tools). The dispatcher fails closed for anything else — this test makes
 * sure a new tool cannot ship without an explicit access decision.
 *
 * Source-scan rather than runtime import: the tool inventory is a static
 * array literal in server.ts, and scanning the source also catches tools
 * that are conditionally registered.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_SCOPE_MAP, UNSCOPED_TOOLS } from '@/lib/auth/api-keys'

describe('MCP tool scope coverage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8')
  const toolNames = [...new Set(
    [...source.matchAll(/name: '(nordklart_[a-z0-9_]+)'/g)].map((m) => m[1]),
  )]

  it('finds a plausible tool inventory in server.ts', () => {
    expect(toolNames.length).toBeGreaterThan(80)
  })

  it('every tool is scope-mapped or explicitly unscoped', () => {
    const undecided = toolNames.filter(
      (name) => !(name in TOOL_SCOPE_MAP) && !UNSCOPED_TOOLS.has(name),
    )
    expect(undecided).toEqual([])
  })

  it('no tool is both scope-mapped and unscoped', () => {
    const both = toolNames.filter(
      (name) => name in TOOL_SCOPE_MAP && UNSCOPED_TOOLS.has(name),
    )
    expect(both).toEqual([])
  })
})
