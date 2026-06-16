'use client'

import { useState, useMemo } from 'react'
import { Deadline, DeadlineType } from '@/types'
import { Button } from '@/components/ui/button'
import { DeadlineCard } from './DeadlineCard'
import { DeadlineFilters } from './DeadlineFilters'
import { DeadlineForm } from './DeadlineForm'
import { isDeadlineOverdue } from '@/lib/calendar/utils'
import { Plus, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'

interface DeadlineListProps {
  deadlines: Deadline[]
  customers: { id: string; name: string }[]
  onDeadlineCreate: (data: Omit<Deadline, 'id' | 'user_id' | 'company_id' | 'created_at' | 'updated_at'>) => Promise<void>
  onDeadlineToggle: (deadline: Deadline) => Promise<void>
  onDeadlineEdit: (deadline: Deadline) => Promise<void>
  onDeadlineDelete: (deadline: Deadline) => Promise<void>
}

export function DeadlineList({
  deadlines,
  customers,
  onDeadlineCreate,
  onDeadlineToggle,
  onDeadlineEdit,
  onDeadlineDelete,
}: DeadlineListProps) {
  const { canWrite } = useCanWrite()
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed'>('pending')
  const [typeFilter, setTypeFilter] = useState<DeadlineType | 'all'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingDeadline, setEditingDeadline] = useState<Deadline | null>(null)

  const filteredDeadlines = useMemo(() => {
    return deadlines.filter((d) => {
      if (statusFilter === 'pending' && d.is_completed) return false
      if (statusFilter === 'completed' && !d.is_completed) return false
      if (typeFilter !== 'all' && d.deadline_type !== typeFilter) return false
      return true
    })
  }, [deadlines, statusFilter, typeFilter])

  const groupedDeadlines = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const overdue: Deadline[] = []
    const todayDeadlines: Deadline[] = []
    const upcoming: Deadline[] = []
    const completed: Deadline[] = []

    for (const d of filteredDeadlines) {
      if (d.is_completed) {
        completed.push(d)
      } else if (isDeadlineOverdue(d)) {
        overdue.push(d)
      } else if (d.due_date === today) {
        todayDeadlines.push(d)
      } else {
        upcoming.push(d)
      }
    }

    return { overdue, today: todayDeadlines, upcoming, completed }
  }, [filteredDeadlines])

  const handleResetFilters = () => {
    setStatusFilter('all')
    setTypeFilter('all')
  }

  const handleFormSubmit = async (data: Omit<Deadline, 'id' | 'user_id' | 'company_id' | 'created_at' | 'updated_at'>) => {
    if (editingDeadline) {
      await onDeadlineEdit({ ...editingDeadline, ...data })
    } else {
      await onDeadlineCreate(data)
    }
    setShowForm(false)
    setEditingDeadline(null)
  }

  const handleEdit = (deadline: Deadline) => {
    setEditingDeadline(deadline)
    setShowForm(true)
  }

  const handleFormClose = () => {
    setShowForm(false)
    setEditingDeadline(null)
  }

  const sections = [
    { key: 'overdue', label: 'Förfallna', items: groupedDeadlines.overdue },
    { key: 'today', label: 'Idag', items: groupedDeadlines.today },
    { key: 'upcoming', label: 'Kommande', items: groupedDeadlines.upcoming },
    { key: 'completed', label: 'Klara', items: groupedDeadlines.completed },
  ].filter(s => s.items.length > 0)

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <DeadlineFilters
          status={statusFilter}
          type={typeFilter}
          onStatusChange={setStatusFilter}
          onTypeChange={setTypeFilter}
          onReset={handleResetFilters}
        />
        <Button
          onClick={() => setShowForm(true)}
          disabled={!canWrite}
          title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
        >
          {canWrite ? (
            <Plus className="h-4 w-4 mr-2" />
          ) : (
            <Lock className="h-4 w-4 mr-2" />
          )}
          Ny deadline
        </Button>
      </div>

      {/* Content */}
      {filteredDeadlines.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-sm text-muted-foreground">
            {statusFilter !== 'all' || typeFilter !== 'all'
              ? 'Inga deadlines matchar filtret.'
              : 'Inga deadlines ännu.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setShowForm(true)}
            disabled={!canWrite}
            title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
          >
            {canWrite ? (
              <Plus className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Lock className="h-3.5 w-3.5 mr-1.5" />
            )}
            Skapa en deadline
          </Button>
        </div>
      ) : (
        <div className="space-y-8">
          {sections.map(({ key, label, items }) => (
            <section key={key}>
              <div className="flex items-center gap-3 mb-2 px-1">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {label}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground/50">
                  {items.length}
                </span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <div className="space-y-1.5">
                {items.map((deadline) => (
                  <DeadlineCard
                    key={deadline.id}
                    deadline={deadline}
                    onToggle={onDeadlineToggle}
                    onEdit={handleEdit}
                    onDelete={onDeadlineDelete}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <DeadlineForm
        open={showForm}
        onOpenChange={handleFormClose}
        onSubmit={handleFormSubmit}
        onDelete={(deadline) => {
          if (deadline.id) {
            const full = deadlines.find(d => d.id === deadline.id)
            if (full) onDeadlineDelete(full)
          }
        }}
        initialData={editingDeadline || undefined}
        customers={customers}
      />
    </div>
  )
}
