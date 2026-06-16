# nordklart-mcp

Connect [Claude Desktop](https://claude.ai/download) (or any stdio MCP client) to your [Nordklart](https://app.nordklart.se) bookkeeping account. This is a thin stdio → HTTPS bridge: it forwards JSON-RPC over stdio to the hosted Nordklart MCP server, which exposes 90+ bookkeeping tools (invoices, transactions, VAT/momsdeklaration, payroll, reports, year-end).

Write tools stage a pending operation that you confirm before anything is booked — the bridge never books on its own.

## Quickstart

1. Mint an API key in the Nordklart dashboard at **[/settings/api](https://app.nordklart.se/settings?tab=api)**. Use a `nordklart_sk_test_*` key against the sandbox while you evaluate; switch to `nordklart_sk_live_*` for real data. The key's scopes gate which tools are callable.

2. Run the bridge with the key in the environment:

   ```bash
   NORDKLART_API_KEY=nordklart_sk_test_... npx nordklart-mcp
   ```

   It reads JSON-RPC from stdin and writes responses to stdout, so you normally point an MCP client at it rather than running it by hand.

## Claude Desktop config

Add the bridge to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nordklart": {
      "command": "npx",
      "args": ["nordklart-mcp"],
      "env": {
        "NORDKLART_API_KEY": "nordklart_sk_test_..."
      }
    }
  }
}
```

Restart Claude Desktop. The Nordklart tools appear in the client and you can start asking questions like *"Show my uncategorized bank transactions and suggest categories."*

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NORDKLART_API_KEY` | yes | — | Your `nordklart_sk_*` API key. |
| `NORDKLART_URL` | no | `https://app.nordklart.se/api/extensions/ext/mcp-server/mcp` | Override the MCP endpoint (e.g. for hosted Nordklart). |

## Alternative: claude.ai connector (no API key)

If you use **claude.ai** or Claude Desktop's custom-connector flow, you can skip this bridge entirely and add Nordklart as an OAuth 2.1 custom connector instead — paste the connector URL `https://app.nordklart.se/api/extensions/ext/mcp-server/mcp` and authorise on the Nordklart consent screen (read-only scopes by default; write scopes are ticked explicitly).

## Docs

Full setup, sample prompts, and a 10-minute reviewer test: **[Connect with Claude](https://app.nordklart.se/docs/api/connect-claude)**.

## License

MIT
