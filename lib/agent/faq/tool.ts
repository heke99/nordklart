import type { AgentTool } from '@/lib/agent/tools/types'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import {
  retrieveFaq,
  FAQ_HIGH_CONFIDENCE_THRESHOLD,
  FAQ_LOW_CONFIDENCE_THRESHOLD,
} from './retriever'

// nordklart_faq_search — the assistant's FIRST stop for product/workflow
// questions ("hur kopplar jag banken?", "varför matchades inte
// transaktionen?"). Searches the seeded 450-entry Swedish FAQ and returns
// curated answers with sources, risk level and escalation guidance.
//
// Anti-hallucination contract baked into the tool result:
//   - lowConfidence → the result says so explicitly and instructs the model
//     to fall back to skills or admit uncertainty, never to improvise.
//   - risk_level high → the result carries the escalation text the model must
//     include (rådgivare/Skatteverket) instead of claiming certainty.
export const faqSearchTool: AgentTool = {
  name: 'nordklart_faq_search',
  description:
    'Sök i Nordklarts kvalitetssäkrade svenska FAQ (450 frågor om produkten och svensk bokföring/moms/lön/bokslut). Använd detta FÖRST för hur-gör-jag-frågor om Nordklart och vanliga regelfrågor, innan du laddar skill-atomer. Returnerar kurerade svar med källor, risknivå och eskaleringsråd.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Användarens fråga på svenska, gärna ordagrant.',
      },
      limit: {
        type: 'number',
        description: 'Max antal träffar (1-10, standard 3).',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },

  async execute(args, _companyId, _userId, supabase) {
    const query = typeof args.query === 'string' ? args.query : ''
    if (query.trim().length === 0) {
      return { error: 'query krävs' }
    }
    const rawLimit = typeof args.limit === 'number' ? args.limit : 3
    const limit = Math.max(1, Math.min(10, Math.round(rawLimit)))

    const result = await retrieveFaq(query, { supabase, limit })

    if (result.lowConfidence || result.matches.length === 0) {
      return {
        query,
        found: false,
        low_confidence: true,
        matches: result.matches.slice(0, 2).map(toToolMatch),
        instruktion:
          'Ingen FAQ-träff med tillräcklig säkerhet. Svara INTE utifrån dessa träffar. Ladda i stället rätt skill-atom (nordklart_load_skill) eller säg ärligt att du inte hittar ett säkert svar och be användaren omformulera eller kontakta supporten.',
      }
    }

    return {
      query,
      found: true,
      low_confidence: false,
      matches: result.matches.map(toToolMatch),
      instruktion:
        'Svara utifrån bästa träffen. Håll dig till FAQ-svarets innehåll — lägg inte till egna siffror eller regler utöver det. Om risk_level är "high": inkludera eskaleringsrådet och ge inte kategoriska besked. Om användarens fråga bara delvis täcks: säg vad FAQ:n täcker och ladda en skill-atom för resten.',
    }
  },
}

function toToolMatch(m: {
  entry: {
    id: string
    category: string
    intent: string
    short_answer_sv: string
    answer_sv: string
    sources: string[]
    related_routes: string[]
    risk_level: string
    escalation: string | null
  }
  confidence: number
  matchedOn: string[]
}) {
  return {
    id: m.entry.id,
    category: m.entry.category,
    confidence: m.confidence,
    confidence_label:
      m.confidence >= FAQ_HIGH_CONFIDENCE_THRESHOLD
        ? 'hög'
        : m.confidence >= FAQ_LOW_CONFIDENCE_THRESHOLD
          ? 'medel'
          : 'låg',
    short_answer_sv: m.entry.short_answer_sv,
    answer_sv: m.entry.answer_sv,
    sources: m.entry.sources,
    related_routes: m.entry.related_routes,
    risk_level: m.entry.risk_level,
    escalation: m.entry.escalation,
    matched_on: m.matchedOn,
  }
}

// Idempotent registration — called from ensureInitialized() so the chat loop
// sees the tool regardless of which extensions are enabled.
export function registerFaqAgentTool(): void {
  if (!agentToolRegistry.has(faqSearchTool.name)) {
    agentToolRegistry.register(faqSearchTool)
  }
}
