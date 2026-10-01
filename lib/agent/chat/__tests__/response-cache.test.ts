import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'

const rpc = vi.fn()
const upsert = vi.fn()
const deleteLt = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({
      delete: () => ({ eq: () => ({ lt: (...args: unknown[]) => deleteLt(...args) }) }),
      upsert: (...args: unknown[]) => upsert(...args),
    }),
  }),
}))

const modelCall = vi.fn()
vi.mock('@/lib/agent/composer/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent/composer/client')>()),
  getAnthropic: () => ({
    messages: {
      stream: (args: unknown) => {
        const stream = { on: () => stream, finalMessage: () => modelCall(args) }
        return stream
      },
    },
  }),
}))

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({ blocks: [], promptHash: 'sha256:p', atomsLoaded: [] }),
}))

const toolExecute = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: () => ({ name: 'nordklart_read', description: '', inputSchema: { type: 'object' }, execute: toolExecute }),
    getMany: async () => [],
  },
}))

import { faqDirectAnswer, responseCacheKey } from '../response-cache'
import { runChatTurn } from '../run-turn'

// Every query resolves to an empty result: no history, no memory.
function fakeSupabase() {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return () => proxy
    },
  })
  return proxy as Parameters<typeof runChatTurn>[0]['supabase']
}

function intent(id = 'kpi.explain'): AgentIntent {
  return {
    id,
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [],
    model: 'claude-sonnet-5-5',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function run(opts: { intentId?: string; message?: string; hidden?: boolean } = {}) {
  const events: Array<{ kind: string; delta?: string }> = []
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'u',
    companyId: 'c1',
    companyName: 'AB',
    firstName: 'A',
    intent: intent(opts.intentId),
    conversationId: 'conv',
    userMessage: opts.message ?? 'Förklara bruttomarginalen',
    userMessageHidden: opts.hidden,
    persist: true,
    emit: (e) => { events.push(e as { kind: string }); return true },
  })
  return events
}

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockResolvedValue({ data: [], error: null })
  upsert.mockResolvedValue({ error: null })
  deleteLt.mockResolvedValue({ error: null })
})

describe('faqDirectAnswer', () => {
  it('answers a help question that matches an FAQ question variant', () => {
    const answer = faqDirectAnswer('general.help', 'Hur sätter jag räkenskapsår?')
    expect(answer).toMatch(/räkenskapsår/i)
    expect(answer).toMatch(/Fråga gärna vidare/)
  })

  it('never answers a high-risk entry from the FAQ', () => {
    expect(faqDirectAnswer('general.help', 'Jag bokförde med fel momssats — hur rättar jag?')).toBeNull()
  })

  it('only applies to help intents', () => {
    expect(faqDirectAnswer('vat.review', 'Hur sätter jag räkenskapsår?')).toBeNull()
  })

  it('leaves loose or unrelated questions to the model', () => {
    expect(faqDirectAnswer('general.help', 'räkenskapsår')).toBeNull()
    expect(faqDirectAnswer('general.help', 'Vad tycker du om min bruttomarginal i mars jämfört med februari?')).toBeNull()
  })
})

describe('responseCacheKey', () => {
  const base = { companyId: 'c', intentId: 'i', model: 'm', promptHash: 'h', userMessage: 'Hur bokför jag hyra?' }

  it('ignores case and punctuation in the question', () => {
    expect(responseCacheKey(base)).toBe(responseCacheKey({ ...base, userMessage: '  hur bokför jag HYRA ' }))
  })

  it('changes with the company, the prompt and the model', () => {
    const key = responseCacheKey(base)
    expect(responseCacheKey({ ...base, companyId: 'other' })).not.toBe(key)
    expect(responseCacheKey({ ...base, promptHash: 'h2' })).not.toBe(key)
    expect(responseCacheKey({ ...base, model: 'm2' })).not.toBe(key)
  })
})

describe('runChatTurn with saved answers', () => {
  it('replays a saved answer without calling the model', async () => {
    rpc.mockResolvedValue({ data: [{ response: [{ type: 'text', text: 'Sparat svar' }], response_text: 'Sparat svar' }], error: null })
    const events = await run()
    expect(modelCall).not.toHaveBeenCalled()
    expect(events).toEqual([{ kind: 'text_delta', delta: 'Sparat svar' }, { kind: 'turn_complete', assistant_text: 'Sparat svar' }])
    expect(rpc).toHaveBeenCalledWith('agent_response_cache_hit', expect.objectContaining({ p_company_id: 'c1' }))
  })

  it('answers a matching help question from the FAQ without the model or the cache', async () => {
    const events = await run({ intentId: 'general.help', message: 'Hur sätter jag räkenskapsår?' })
    expect(modelCall).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(events[0].kind).toBe('text_delta')
  })

  it('saves a first-turn answer that used no tools', async () => {
    modelCall.mockResolvedValueOnce({
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Svar' }],
      stop_reason: 'end_turn',
    })
    await run()
    expect(upsert).toHaveBeenCalledTimes(1)
    const row = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(row).toMatchObject({ company_id: 'c1', intent_id: 'kpi.explain', response_text: 'Svar' })
    // Thinking blocks are not stored.
    expect(row.response).toEqual([{ type: 'text', text: 'Svar' }])
  })

  it('does not save an answer that depended on tool results', async () => {
    toolExecute.mockResolvedValue({ value: 1 })
    modelCall
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'nordklart_read', input: {} }], stop_reason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Svar med data' }], stop_reason: 'end_turn' })
    await run()
    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('does not save a refusal', async () => {
    modelCall.mockResolvedValueOnce({ content: [], stop_reason: 'refusal' })
    await run()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('falls back to the model when the cache lookup fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014' } })
    modelCall.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Svar' }], stop_reason: 'end_turn' })
    const events = await run()
    expect(modelCall).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toEqual({ kind: 'turn_complete', assistant_text: '' })
  })
})
