import { describe, it, expect } from 'vitest'
import { aiProvider, isAiConfigured } from '@/lib/agent/availability'
import { forcedToolChoice, thinkingParams, usesAdaptiveOnly } from '@/lib/agent/composer/client'

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv

describe('aiProvider', () => {
  it('prefers the Anthropic API when its key is set', () => {
    expect(aiProvider(env({ ANTHROPIC_API_KEY: 'sk', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))).toBe('anthropic')
  })

  it('uses Bedrock with both AWS keys or an explicit instance role', () => {
    expect(aiProvider(env({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))).toBe('bedrock')
    expect(aiProvider(env({ AI_BEDROCK_USE_INSTANCE_ROLE: 'true' }))).toBe('bedrock')
  })

  it('reports no provider with half a set of AWS keys or nothing at all', () => {
    expect(aiProvider(env({ AWS_ACCESS_KEY_ID: 'a' }))).toBe('none')
    expect(isAiConfigured(env({}))).toBe(false)
  })
})

describe('model request shape', () => {
  it('never sends a forced tool_choice to Opus 5.5 or Sonnet 5.5', () => {
    expect(forcedToolChoice('claude-opus-5-5', 'x')).toEqual({ type: 'auto' })
    expect(forcedToolChoice('claude-sonnet-5-5', 'x')).toEqual({ type: 'auto' })
    expect(forcedToolChoice('eu.anthropic.claude-sonnet-4-6', 'x')).toEqual({ type: 'tool', name: 'x' })
  })

  it('never sends budget_tokens to adaptive-only models', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(usesAdaptiveOnly(model)).toBe(true)
      expect(JSON.stringify(thinkingParams(model, 12_000))).not.toContain('budget_tokens')
      expect(JSON.stringify(thinkingParams(model, undefined))).not.toContain('disabled')
    }
  })
})
