// Which Claude provider the deployment is configured for. Kept free of SDK
// imports so layouts and routes can ask "is the assistant available?"
// without loading the clients.

export type AiProvider = 'anthropic' | 'bedrock' | 'none'

export function aiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  if ((env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.AI_BEDROCK_USE_INSTANCE_ROLE === 'true') {
    return 'bedrock'
  }
  return 'none'
}

/** False when no provider is configured: the UI hides the assistant and its routes answer 503. */
export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiProvider(env) !== 'none'
}

export const AI_UNAVAILABLE_MESSAGE_SV = 'Assistenten är inte aktiverad i den här installationen.'
