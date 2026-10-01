import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { aiProvider } from '@/lib/agent/availability'

// One Claude client for the agent composer + chat loop.
//
// Two providers, picked from the environment once per process:
//
//   1. ANTHROPIC_API_KEY set → the Anthropic API directly. Cheapest per token
//      (Sonnet 5.5 is $2/$10 per MTok against ~$3/$15 for Sonnet on Bedrock in
//      eu-north-1) and the only provider with 1h prompt-cache TTL, so cached
//      system prompts stay warm across a working session.
//   2. AWS credentials set (or an instance role) → AWS Bedrock in
//      eu-north-1, which keeps inference inside the EU. Kept as the
//      alternative for deployments that require EU-only processing.
//
// With neither, isAiConfigured() is false and the UI hides the assistant
// instead of showing buttons that fail (see lib/agent/availability.ts).

export { aiProvider, isAiConfigured, type AiProvider } from '@/lib/agent/availability'

type ClaudeClient = Anthropic | AnthropicBedrock

let cached: ClaudeClient | null = null

export function getAnthropic(): ClaudeClient {
  if (cached) return cached
  if (aiProvider() === 'anthropic') {
    cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    return cached
  }
  const awsRegion = process.env.AWS_REGION || 'eu-north-1'
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID
  const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY
  // When both static keys are present, pass them. Otherwise omit them so the
  // SDK falls back to the AWS credential provider chain (instance profile,
  // IRSA, EKS pod identity, ...). The two-overload SDK refuses a mix.
  cached =
    awsAccessKey && awsSecretKey
      ? new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
      : new AnthropicBedrock({ awsRegion })
  return cached
}

// Model tiers. Each is env-overridable so ops can swap models without a deploy.
//
//   OPUS   — the hardest reasoning: bokslut, VAT review, supplier invoice
//            review, composer atom selection. Few calls, so the higher price
//            matters little.
//   SONNET — the default for chat and drafting.
//   HAIKU  — short, simple turns: settings help, onboarding nudges, the
//            composer's profile narrative.
//
// On Bedrock the defaults are the model known to be enabled on the account
// (Sonnet 4.6) for every tier; enable newer models under Bedrock → Model
// access and point AI_*_MODEL_ID at them.
const DIRECT_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
} as const

const BEDROCK_MODELS = {
  opus: 'eu.anthropic.claude-sonnet-4-6',
  sonnet: 'eu.anthropic.claude-sonnet-4-6',
  haiku: 'eu.anthropic.claude-sonnet-4-6',
} as const

function resolveModel(tier: keyof typeof DIRECT_MODELS): string {
  const override = process.env[`AI_${tier.toUpperCase()}_MODEL_ID`]
    || process.env[`BEDROCK_${tier.toUpperCase()}_MODEL_ID`]
  if (override) return override
  return aiProvider() === 'bedrock' ? BEDROCK_MODELS[tier] : DIRECT_MODELS[tier]
}

export const OPUS_MODEL = resolveModel('opus')
export const SONNET_MODEL = resolveModel('sonnet')
export const HAIKU_MODEL = resolveModel('haiku')

// Reasoning depth for the chat intents. Kept as token figures for backwards
// compatibility with the intent definitions; thinkingParams() maps them onto
// what each model accepts.
export const THINKING_BUDGET_STANDARD = 6000
export const THINKING_BUDGET_DEEP = 12000

/**
 * Models that reject `thinking: { type: 'enabled', budget_tokens }` and
 * forced `tool_choice`. Effort is their only depth control.
 */
export function usesAdaptiveOnly(model: string): boolean {
  return /(opus-5|sonnet-5|fable-5|mythos-5|opus-4-[78])/.test(model)
}

function supportsAdaptive(model: string): boolean {
  return usesAdaptiveOnly(model) || /(opus-4-6|sonnet-4-6)/.test(model)
}

/**
 * Request fields for the reasoning channel.
 *
 *   - Adaptive models (Claude 4.6 and later): adaptive thinking with a
 *     summarized display so the chat's "Tänkte…" block has text, and effort
 *     as the depth control. Without opt-in they run at low effort, which is
 *     the cheapest setting these models allow (thinking cannot be disabled
 *     on Sonnet 5.5 / Opus 5.5).
 *   - Older models (Haiku 4.5): a token budget when opted in, nothing
 *     otherwise.
 */
export function thinkingParams(
  model: string,
  budgetTokens: number | undefined,
): { thinking?: Record<string, unknown>; output_config?: { effort: 'low' | 'medium' | 'high' }; max_tokens: number } {
  if (supportsAdaptive(model)) {
    const effort = !budgetTokens ? 'low' : budgetTokens >= THINKING_BUDGET_DEEP ? 'high' : 'medium'
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      max_tokens: 16_000,
    }
  }
  if (budgetTokens) {
    return { thinking: { type: 'enabled', budget_tokens: budgetTokens }, max_tokens: budgetTokens + 4096 }
  }
  return { max_tokens: 4096 }
}

/** tool_choice that forces one tool where the model allows it. */
export function forcedToolChoice(model: string, name: string): { type: 'tool'; name: string } | { type: 'auto' } {
  return usesAdaptiveOnly(model) ? { type: 'auto' } : { type: 'tool', name }
}
