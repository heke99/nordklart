import { getTranslations } from 'next-intl/server'
import { Card, CardContent } from '@/components/ui/card'
import { EXTENSION_ICON_MAP, FALLBACK_EXTENSION_ICON } from '@/lib/extensions/icon-resolver'
import { extensionNameKey, extensionDescriptionKey } from '@/lib/extensions/i18n'
import type { ExtensionDefinition } from '@/lib/extensions/types'
import CategoryBadge from './CategoryBadge'
import Link from 'next/link'

export default async function ExtensionCard({ extension }: { extension: ExtensionDefinition }) {
  const t = await getTranslations('extensions')

  const nameKey = extensionNameKey(extension.slug)
  const descriptionKey = extensionDescriptionKey(extension.slug)
  const name = nameKey ? t(nameKey) : extension.name
  const description = descriptionKey ? t(descriptionKey) : extension.description

  // Static map lookup instead of a call — the static-components rule treats a
  // call-result component as created during render.
  const Icon = EXTENSION_ICON_MAP[extension.icon] ?? FALLBACK_EXTENSION_ICON

  return (
    <Card className="group relative">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <Link
              href={`/extensions/${extension.sector}/${extension.slug}`}
              className="text-sm font-medium hover:underline"
            >
              {name}
            </Link>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {description}
            </p>
            <div className="mt-2">
              <CategoryBadge category={extension.category} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
