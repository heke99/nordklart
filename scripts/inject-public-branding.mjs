#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const templatePath = path.join(root, 'public', 'sw.template.js')
const outputPath = path.join(root, 'public', 'sw.js')

const branding = {
  appName: process.env.NEXT_PUBLIC_BRANDING_APP_NAME || 'Nordklart',
}

function escapeLegacyToken(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function main() {
  if (!existsSync(templatePath)) {
    console.log('No public/sw.template.js found; skipping public branding injection.')
    return
  }

  const template = await readFile(templatePath, 'utf8')
  const body = template
    .replace(/'__NEXT_PUBLIC_BRANDING_APP_NAME__'/g, JSON.stringify(branding.appName))
    .replace(/__NEXT_PUBLIC_BRANDING_APP_NAME__/g, escapeLegacyToken(branding.appName))

  const output = `// AUTO-GENERATED — do not edit. Generated from public/sw.template.js by scripts/inject-public-branding.mjs.\n${body}`
  await writeFile(outputPath, output, 'utf8')
  console.log('Generated public/sw.js with public branding values.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
