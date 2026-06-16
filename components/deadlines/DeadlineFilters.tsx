'use client'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DeadlineType } from '@/types'
import { DEADLINE_TYPE_LABELS } from '@/lib/calendar/utils'
import { X } from 'lucide-react'

interface DeadlineFiltersProps {
  status: 'all' | 'pending' | 'completed'
  type: DeadlineType | 'all'
  onStatusChange: (status: 'all' | 'pending' | 'completed') => void
  onTypeChange: (type: DeadlineType | 'all') => void
  onReset: () => void
}

export function DeadlineFilters({
  status,
  type,
  onStatusChange,
  onTypeChange,
  onReset,
}: DeadlineFiltersProps) {
  const hasFilters = status !== 'all' || type !== 'all'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={status} onValueChange={(v) => onStatusChange(v as typeof status)}>
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alla</SelectItem>
          <SelectItem value="pending">Ej klara</SelectItem>
          <SelectItem value="completed">Klara</SelectItem>
        </SelectContent>
      </Select>

      <Select value={type} onValueChange={(v) => onTypeChange(v as typeof type)}>
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Typ" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alla typer</SelectItem>
          {Object.entries(DEADLINE_TYPE_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <X className="h-4 w-4 mr-1" />
          Rensa
        </Button>
      )}
    </div>
  )
}
