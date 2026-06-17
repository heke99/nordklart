#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

type ExtensionConfig = {
  extensions?: unknown
}

type ExtensionManifest = {
  id?: unknown
  sector?: unknown
  exportName?: unknown
  entryPoint?: unknown
  workspace?: unknown
  definition?: unknown
}

type ManifestSearchResult = {
  manifest: ExtensionManifest
  filePath: string
}

type EnabledManifest = {
  id: string
  sector: string
  exportName: string
  entryPoint: string
  workspace: string | null
  definition: Record<string, unknown>
}

const root = process.cwd()
const generatedDir = path.join(root, 'lib', 'extensions', '_generated')
const configPath = path.join(root, 'extensions.config.json')
const extensionsRoot = path.join(root, 'extensions')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function findManifestById(id: string): Promise<ManifestSearchResult | null> {
  async function walk(dir: string): Promise<ManifestSearchResult | null> {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        const found = await walk(fullPath)
        if (found) return found
        continue
      }

      if (entry.isFile() && entry.name === 'manifest.json') {
        const manifest = await readJson<ExtensionManifest>(fullPath)
        if (manifest.id === id) return { manifest, filePath: fullPath }
      }
    }

    return null
  }

  return walk(extensionsRoot)
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid extension manifest: ${label} must be a non-empty string`)
  }

  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function stringifyTs(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent)
}

async function main(): Promise<void> {
  if (!existsSync(configPath)) {
    throw new Error('extensions.config.json is missing')
  }

  const config = await readJson<ExtensionConfig>(configPath)
  const enabledIds = Array.isArray(config.extensions)
    ? config.extensions.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  await mkdir(generatedDir, { recursive: true })

  const enabledManifests: EnabledManifest[] = []

  for (const id of enabledIds) {
    const found = await findManifestById(id)
    if (!found) {
      throw new Error(`Enabled extension "${id}" has no manifest.json`)
    }

    const { manifest } = found
    const sector = typeof manifest.sector === 'string' && manifest.sector.length > 0 ? manifest.sector : 'general'

    enabledManifests.push({
      id: assertString(manifest.id, `${id}.id`),
      sector,
      exportName: assertString(manifest.exportName, `${id}.exportName`),
      entryPoint: assertString(manifest.entryPoint, `${id}.entryPoint`),
      workspace: optionalString(manifest.workspace),
      definition: isRecord(manifest.definition) ? manifest.definition : {},
    })
  }

  const extensionImports = enabledManifests
    .map((extension) => `import { ${extension.exportName} } from '${extension.entryPoint}'`)
    .join('\n')

  const extensionList = `// AUTO-GENERATED — do not edit. Run \`npm run setup:extensions\` to regenerate.\nimport type { Extension } from '../types'\n${extensionImports}\n\nexport const FIRST_PARTY_EXTENSIONS: Extension[] = [\n${enabledManifests.map((extension) => `  ${extension.exportName},`).join('\n')}\n]\n`

  const enabledExtensions = `// AUTO-GENERATED — do not edit. Run \`npm run setup:extensions\` to regenerate.\n\nexport const ENABLED_EXTENSION_IDS: ReadonlySet<string> = new Set([\n${enabledManifests.map((extension) => `  '${extension.id}',`).join('\n')}\n])\n`

  const definitionsBySector: Record<string, Array<Record<string, unknown>>> = {}

  for (const extension of enabledManifests) {
    definitionsBySector[extension.sector] ??= []
    definitionsBySector[extension.sector].push({
      slug: extension.id,
      sector: extension.sector,
      ...extension.definition,
    })
  }

  const sectorDefinitionsBody = Object.entries(definitionsBySector)
    .map(([sector, definitions]) => `  '${sector}': ${stringifyTs(definitions, 4).replace(/^/gm, '  ').trim()},`)
    .join('\n')

  const sectorDefinitions = `// AUTO-GENERATED — do not edit. Run \`npm run setup:extensions\` to regenerate.\nimport type { ExtensionDefinition } from '../types'\n\nexport const EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition[]> = {\n${sectorDefinitionsBody}\n}\n`

  const workspaceEntries = enabledManifests
    .filter((extension): extension is EnabledManifest & { workspace: string } => typeof extension.workspace === 'string' && extension.workspace.length > 0)
    .map((extension) => `  '${extension.sector}/${extension.id}': dynamic(() => import('${extension.workspace}')),`)
    .join('\n')

  const workspaceMap = `// AUTO-GENERATED — do not edit. Run \`npm run setup:extensions\` to regenerate.\nimport dynamic from 'next/dynamic'\nimport type { ComponentType } from 'react'\nimport type { WorkspaceComponentProps } from '../workspace-registry'\n\nexport const WORKSPACES: Record<string, ComponentType<WorkspaceComponentProps>> = {\n${workspaceEntries}\n}\n`

  await Promise.all([
    writeFile(path.join(generatedDir, 'extension-list.ts'), extensionList, 'utf8'),
    writeFile(path.join(generatedDir, 'enabled-extensions.ts'), enabledExtensions, 'utf8'),
    writeFile(path.join(generatedDir, 'sector-definitions.ts'), sectorDefinitions, 'utf8'),
    writeFile(path.join(generatedDir, 'workspace-map.tsx'), workspaceMap, 'utf8'),
  ])

  console.log(`Generated extension registry for ${enabledManifests.length} enabled extensions.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
