import { Skeleton } from '@/components/ui/skeleton'

export function SettingsLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {[1, 2].map(i => (
        <div key={i} className="space-y-4">
          <Skeleton className="h-3.5 w-24" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-10" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-10" />
            </div>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-10" />
          </div>
        </div>
      ))}
    </div>
  )
}
