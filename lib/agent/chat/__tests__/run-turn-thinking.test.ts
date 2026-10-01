import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'

// Verifies the extended-thinking ("tänka längre") wiring: an opted-in intent
// gets a thinking config + bumped max_tokens on the model call, an intent
// without it gets neither; and thinking blocks are stripped before persistence.
//
// The Anthropic client mock mirrors run-turn-memory.test.ts: stream().on() is a
// chainable no-op and finalMessage() delegates to a queued mock that records
// the args the stream was called with.
const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent/composer/client')>()),
  getAnthropic: () => ({
    messages: {
      stream: (args: unknown) => {
        const stream = { on: () => stream, finalMessage: () => messagesCreate(args) }
        return stream
      },
    },
  }),
  SONNET_MODEL: 'claude-sonnet-4-6',
}))

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({
    blocks: [],
    promptHash: 'sha256:test',
    atomsLoaded: [],
  }),
}))

const getManyMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: () => undefined,
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn, stripThinking } from '../run-turn'

function fakeSupabase() {
  const passthrough: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(passthrough, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      }
      return () => proxy
    },
  })
  return proxy as unknown as Parameters<typeof runChatTurn>[0]['supabase']
}

function baseIntent(): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [],
    model: 'claude-sonnet-4-6',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function runWith(intent: AgentIntent) {
  messagesCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
  })
  getManyMock.mockResolvedValue([])
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'u',
    companyId: 'c',
    companyName: 'X',
    firstName: 'A',
    intent,
    conversationId: 'conv',
    userMessage: 'hej',
    persist: false,
    emit: () => true,
  })
  // The args object the stream was invoked with.
  return messagesCreate.mock.calls[0][0] as { thinking?: unknown; max_tokens?: number }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn — extended thinking wiring', () => {
  it('uses adaptive thinking with medium effort when the intent opts in on a 4.6+ model', async () => {
    const args = (await runWith({ ...baseIntent(), thinking: { budgetTokens: 2000 } })) as Record<string, unknown>
    expect(args.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(args.output_config).toEqual({ effort: 'medium' })
    expect(args.max_tokens).toBe(16_000)
  })

  it('raises effort to high for deep-reasoning intents', async () => {
    const args = (await runWith({ ...baseIntent(), model: 'claude-opus-5-5', thinking: { budgetTokens: 12_000 } })) as Record<string, unknown>
    expect(args.output_config).toEqual({ effort: 'high' })
  })

  it('runs Sonnet 5.5 at low effort when the intent does not opt in (thinking cannot be disabled there)', async () => {
    const args = (await runWith({ ...baseIntent(), model: 'claude-sonnet-5-5' })) as Record<string, unknown>
    expect(args.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(args.output_config).toEqual({ effort: 'low' })
    expect(args).not.toHaveProperty('budget_tokens')
  })

  it('uses a token budget on Haiku 4.5 and no thinking without opt-in', async () => {
    const withBudget = await runWith({ ...baseIntent(), model: 'claude-haiku-4-5', thinking: { budgetTokens: 2000 } })
    expect(withBudget.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    expect(withBudget.max_tokens).toBe(2000 + 4096)
    vi.clearAllMocks()
    const plain = await runWith({ ...baseIntent(), model: 'claude-haiku-4-5' })
    expect(plain.thinking).toBeUndefined()
    expect(plain.max_tokens).toBe(4096)
  })

  it('reports a refusal as a chat error instead of an answer', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [], stop_reason: 'refusal' })
    getManyMock.mockResolvedValue([])
    const events: Array<{ kind: string }> = []
    await runChatTurn({
      supabase: fakeSupabase(),
      userId: 'u',
      companyId: 'c',
      companyName: 'X',
      firstName: 'A',
      intent: baseIntent(),
      conversationId: 'conv',
      userMessage: 'hej',
      persist: false,
      emit: (e) => { events.push(e); return true },
    })
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn_complete'])
  })
})

describe('stripThinking', () => {
  it('drops thinking and redacted_thinking blocks but keeps text and tool_use', () => {
    const blocks = [
      { type: 'thinking', thinking: 'raw chain of thought', signature: 'sig' },
      { type: 'redacted_thinking', data: 'xxx' },
      { type: 'text', text: 'svar' },
      { type: 'tool_use', id: 't1', name: 'nordklart_load_skill', input: {} },
    ]
    expect(stripThinking(blocks)).toEqual([
      { type: 'text', text: 'svar' },
      { type: 'tool_use', id: 't1', name: 'nordklart_load_skill', input: {} },
    ])
  })

  it('is a no-op when there are no thinking blocks', () => {
    const blocks = [{ type: 'text', text: 'x' }]
    expect(stripThinking(blocks)).toEqual(blocks)
  })
})
