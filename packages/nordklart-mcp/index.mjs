#!/usr/bin/env node
/**
 * nordklart-mcp — Connect Claude Desktop to your Nordklart bookkeeping account.
 *
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "nordklart": {
 *       "command": "npx",
 *       "args": ["nordklart-mcp"],
 *       "env": {
 *         "NORDKLART_API_KEY": "nordklart_sk_..."
 *       }
 *     }
 *   }
 * }
 *
 * Get your API key at: https://app.nordklart.se/settings?tab=api
 */

const API_KEY = process.env.NORDKLART_API_KEY
const MCP_URL = process.env.NORDKLART_URL || 'https://app.nordklart.se/api/extensions/ext/mcp-server/mcp'

if (!API_KEY) {
  process.stderr.write(
    'Error: NORDKLART_API_KEY is required.\n' +
    'Get your API key at: https://app.nordklart.se/settings?tab=api\n' +
    '\n' +
    'Add it to your Claude Desktop config:\n' +
    '{\n' +
    '  "mcpServers": {\n' +
    '    "nordklart": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["nordklart-mcp"],\n' +
    '      "env": {\n' +
    '        "NORDKLART_API_KEY": "nordklart_sk_..."\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '}\n'
  )
  process.exit(1)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  let newlineIdx
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)

    if (!line) continue

    handleMessage(line).catch((err) => {
      process.stderr.write(`nordklart-mcp error: ${err.message}\n`)
    })
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})

async function handleMessage(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    process.stderr.write(`nordklart-mcp: invalid JSON\n`)
    return
  }

  const isNotification = parsed.id === undefined || parsed.id === null

  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: line,
    })

    if (res.status === 202 || res.status === 204) {
      return
    }

    const text = await res.text()

    // Guard against non-JSON error responses (CDN HTML pages, proxy errors)
    if (!res.ok && !isNotification) {
      let message = `HTTP ${res.status}`
      try {
        const json = JSON.parse(text)
        if (json.error) message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
      } catch { /* body wasn't JSON — use generic message */ }
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message },
      })
      process.stdout.write(errorResponse + '\n')
      return
    }

    if (text) {
      process.stdout.write(text + '\n')
    }
  } catch (err) {
    if (!isNotification) {
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: `Connection error: ${err.message}` },
      })
      process.stdout.write(errorResponse + '\n')
    }
  }
}
