import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { kontrolleraMomsdeklaration, toSkatteverketId } from '@/lib/skatteverket/sysorg'

export const dynamic = 'force-dynamic'

const MomsuppgiftSchema = z.object({
  momspliktigForsaljning: z.number().optional(),
  momspliktigaUttag: z.number().optional(),
  vinstmarginal: z.number().optional(),
  hyresInkomst: z.number().optional(),
  momsForsaljningUtgaendeHog: z.number().optional(),
  momsForsaljningUtgaendeMedel: z.number().optional(),
  momsForsaljningUtgaendeLag: z.number().optional(),
  inkopVarorEU: z.number().optional(),
  inkopTjansterEU: z.number().optional(),
  inkopTjansterUtanforEU: z.number().optional(),
  inkopVarorSE: z.number().optional(),
  inkopTjansterSE: z.number().optional(),
  momsInkopUtgaendeHog: z.number().optional(),
  momsInkopUtgaendeMedel: z.number().optional(),
  momsInkopUtgaendeLag: z.number().optional(),
  forsaljningVarorEU: z.number().optional(),
  forsaljningVarorUtanforEU: z.number().optional(),
  inkopVaror3pHandel: z.number().optional(),
  forsaljningVaror3pHandel: z.number().optional(),
  forsaljningTjansterEU: z.number().optional(),
  ovrigForsaljningTjansterUtanforSE: z.number().optional(),
  forsaljningBskKopareSE: z.number().optional(),
  momsfriForsaljning: z.number().optional(),
  import: z.number().optional(),
  momsImportUtgaendeHog: z.number().optional(),
  momsImportUtgaendeMedel: z.number().optional(),
  momsImportUtgaendeLag: z.number().optional(),
  ingaendeMomsAvdrag: z.number().optional(),
  summaMoms: z.number(),
})

const BodySchema = z.object({
  redovisare: z.string().optional(),
  redovisningsperiod: z.string().regex(/^20\d{2}(0[1-9]|1[0-2])$/),
  momsuppgift: MomsuppgiftSchema,
})

export const POST = withRouteContext(
  'skatteverket.sysorg.moms.validate',
  async (request, ctx) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig payload', issues: parsed.error.issues }, { status: 400 })
    }

    let redovisare = parsed.data.redovisare
    if (!redovisare) {
      const { data: company } = await ctx.supabase
        .from('companies')
        .select('org_number')
        .eq('id', ctx.companyId)
        .single()
      if (!company?.org_number) {
        return NextResponse.json({ error: 'Organisationsnummer saknas för aktivt bolag.' }, { status: 400 })
      }
      redovisare = toSkatteverketId(company.org_number, 'organization')
    }

    const result = await kontrolleraMomsdeklaration(
      redovisare,
      parsed.data.redovisningsperiod,
      parsed.data.momsuppgift,
      { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, requestId: ctx.requestId },
    )

    return NextResponse.json(
      { data: result.data, correlationId: result.correlationId },
      { status: result.ok ? 200 : result.status || 502 },
    )
  },
  { requireWrite: true },
)
