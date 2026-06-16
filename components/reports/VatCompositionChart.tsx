'use client'

import { useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'
import type { VatDeclarationRutor } from '@/types'

interface VatCompositionChartProps {
  rutor: VatDeclarationRutor
}

const COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-1) / 0.6)',
  'hsl(var(--chart-2) / 0.6)',
  'hsl(var(--chart-3) / 0.6)',
]

export function VatCompositionChart({ rutor }: VatCompositionChartProps) {
  const chartData = useMemo(() => {
    const segments = [
      { name: 'Utgående 25%', value: rutor.ruta10 },
      { name: 'Utgående 12%', value: rutor.ruta11 },
      { name: 'Utgående 6%', value: rutor.ruta12 },
      { name: 'Omvänd 25%', value: rutor.ruta30 },
      { name: 'Omvänd 12%', value: rutor.ruta31 },
      { name: 'Omvänd 6%', value: rutor.ruta32 },
      { name: 'Ingående moms', value: rutor.ruta48 },
    ]
    return segments.filter((s) => s.value > 0)
  }, [rutor])

  if (chartData.length === 0) return null

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Momsfördelning</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((_, index) => (
                <Cell key={index} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => [
                formatCurrency(Number(value)),
              ]}
            />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
