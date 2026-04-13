'use client'

import { useState, useMemo, useEffect } from 'react'
import { TrendingUp, Target, DollarSign, Activity, Trophy, Globe, Loader2, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { formatCOP, formatPercent, cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar, Rectangle,
  PieChart, Pie, Cell, Label
} from 'recharts'

const COLORS = {
  success: '#10B981',
  danger: '#EF4444',
  nba: '#3B82F6',
  football: '#10B981',
  tennis: '#F97316',
  surface: '#1E1E30',
  textMuted: '#94A3B8'
}

export default function DashboardClient() {
  const [bets, setBets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      try {
        const sup = createClient()
        const { data: { user } } = await sup.auth.getUser()
        // Allow public mock if not logged in
        let q = sup.from('bets').select('*')
        if (user) q = q.eq('user_id', user.id)
        const { data } = await q.execute()
        setBets(data || [])
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  // --- KPI Calculations ---
  const finishedBets = bets.filter(b => b.status === 'won' || b.status === 'lost')
  const totalApostado = finishedBets.reduce((acc, b) => acc + (b.amount_cop || 0), 0)
  const totalPL = finishedBets.reduce((acc, b) => acc + (b.profit_loss_cop || 0), 0)
  const totalGanadas = finishedBets.filter(b => b.status === 'won').length
  const roi = totalApostado > 0 ? (totalPL / totalApostado) * 100 : 0
  const winRate = finishedBets.length > 0 ? (totalGanadas / finishedBets.length) * 100 : 0

  // Streak
  let streak = 0
  let isWinStreak = true
  if (finishedBets.length > 0) {
    const sorted = [...finishedBets].sort((a,b) => new Date(b.result_confirmed_at).getTime() - new Date(a.result_confirmed_at).getTime())
    isWinStreak = sorted[0].status === 'won'
    for (const b of sorted) {
      if ((isWinStreak && b.status === 'won') || (!isWinStreak && b.status === 'lost')) streak++
      else break
    }
  }

  const kpis = [
    { label: 'ROI Total', value: `${totalPL >= 0 ? '+' : ''}${roi.toFixed(1)}%`, trend: totalPL >= 0 ? 'up':'down', icon: TrendingUp, color: 'text-success', bg: 'bg-success/10' },
    { label: 'Tasa de Éxito', value: `${winRate.toFixed(1)}%`, trend: winRate > 50 ? 'up':'down', sub: `${totalGanadas}/${finishedBets.length}`, icon: Target, color: 'text-accent', bg: 'bg-accent/10' },
    { label: 'Racha Actual', value: `${streak} ${isWinStreak ? 'ganadas':'perdidas'}`, trend: isWinStreak?'up':'down', icon: Activity, color: 'text-warning', bg: 'bg-warning/10' },
    { label: 'Utilidad Neta', value: formatCOP(totalPL), trend: totalPL >= 0 ?'up':'down', icon: DollarSign, color: 'text-success', bg: 'bg-success/10' },
  ]

  // --- Chart 1: P&L over time ---
  const timeData = useMemo(() => {
    let acc = 0
    // sort chronological
    const sorted = [...finishedBets].sort((a,b) => new Date(a.result_confirmed_at).getTime() - new Date(b.result_confirmed_at).getTime())
    return sorted.map((b, i) => {
      acc += (b.profit_loss_cop || 0)
      return { index: i, date: new Date(b.result_confirmed_at).toLocaleDateString('es-CO', {month:'short', day:'numeric'}), pl: acc }
    })
  }, [finishedBets])

  // --- Chart 2: Donut Budget ---
  const pendingAmount = bets.filter(b => b.status === 'pending').reduce((a,b)=>a+(b.amount_cop||0), 0)
  const totalLimit = 200000
  const available = Math.max(totalLimit - pendingAmount, 0)
  const budgetData = [
    { name: 'Apostado', value: pendingAmount, color: COLORS.nba },
    { name: 'Disponible', value: available, color: COLORS.textMuted },
  ]

  // --- Chart 3: Sport Performance ---
  const sportData = useMemo(() => {
    const s = { nba: {w:0, l:0, pl:0, a:0}, football: {w:0, l:0, pl:0, a:0}, tennis: {w:0, l:0, pl:0, a:0} }
    finishedBets.forEach(b => {
      const sp = (b.sport || '').toLowerCase()
      if (s[sp as keyof typeof s]) {
        if (b.status==='won') s[sp as keyof typeof s].w++
        if (b.status==='lost') s[sp as keyof typeof s].l++
        s[sp as keyof typeof s].pl += (b.profit_loss_cop || 0)
        s[sp as keyof typeof s].a += (b.amount_cop || 0)
      }
    })
    return [
      { name: 'NBA', won: s.nba.w, lost: s.nba.l, roi: s.nba.a > 0 ? (s.nba.pl/s.nba.a)*100 : 0, color: COLORS.nba },
      { name: 'Fútbol', won: s.football.w, lost: s.football.l, roi: s.football.a > 0 ? (s.football.pl/s.football.a)*100 : 0, color: COLORS.football },
      { name: 'Tenis', won: s.tennis.w, lost: s.tennis.l, roi: s.tennis.a > 0 ? (s.tennis.pl/s.tennis.a)*100 : 0, color: COLORS.tennis },
    ]
  }, [finishedBets])

  // --- Heatmap (Simple grid representation) ---
  const heatmapData = useMemo(() => {
    const days: any = {}
    finishedBets.forEach(b => {
      const d = new Date(b.result_confirmed_at).toISOString().split('T')[0]
      if (!days[d]) days[d] = { date: d, pl: 0, count: 0 }
      days[d].pl += (b.profit_loss_cop || 0)
      days[d].count++
    })
    return Object.values(days).sort((a:any,b:any) => new Date(a.date).getTime() - new Date(b.date).getTime()).slice(-90)
  }, [finishedBets])

  if (loading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-text">Dashboard Analítico</h2>
        <p className="text-text-muted text-sm mt-1">Rendimiento global generado con Recharts</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((kpi, i) => (
          <div key={i} className="card">
            <div className="flex items-start justify-between mb-3">
              <div className={cn("p-2.5 rounded-lg", kpi.bg)}>
                <kpi.icon className={cn("w-5 h-5", kpi.color)} />
              </div>
              {kpi.trend === 'up' ? <ArrowUpRight className="w-4 h-4 text-success" /> : <ArrowDownRight className="w-4 h-4 text-danger" />}
            </div>
            <div className="text-2xl font-black text-text">{kpi.value}</div>
            <div className="text-xs text-text-muted mt-1 font-medium tracking-wider">{kpi.label}</div>
            {kpi.sub && <div className="text-xs text-text-muted/60 mt-0.5">{kpi.sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* P&L Line Chart */}
        <div className="card lg:col-span-2 relative min-h-[300px]">
          <h3 className="section-title text-sm mb-4">Utilidad Acumulada (P&L)</h3>
          {timeData.length === 0 ? <p className="text-text-muted text-sm text-center py-10">Sin suficientes datos</p> : (
            <div className="h-[250px] w-full">
              <ResponsiveContainer>
                <LineChart data={timeData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2A2A40" vertical={false} />
                  <XAxis dataKey="date" stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v/1000}k`} />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: '#1A1A2E', borderColor: '#2A2A40', borderRadius: '8px' }}
                    itemStyle={{ color: '#F0F4F8' }}
                    formatter={(val: number) => [formatCOP(val), 'Utilidad Neto']}
                  />
                  <Line type="stepAfter" dataKey="pl" stroke={COLORS.success} strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Budget Donut */}
        <div className="card">
          <h3 className="section-title text-sm mb-4">Presupuesto Semanal COP</h3>
          <div className="h-[200px] w-full relative">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={budgetData} innerRadius={60} outerRadius={80} paddingAngle={2} dataKey="value" stroke="none">
                  {budgetData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                  <Label 
                    value={formatCOP(pendingAmount)} position="center"
                    className="text-lg font-black fill-text"
                  />
                </Pie>
                <RechartsTooltip formatter={(val: number) => formatCOP(val)} contentStyle={{ backgroundColor: '#1A1A2E', borderColor: '#2A2A40', borderRadius: '8px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-between items-center text-xs mt-2 px-6">
            <span className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-blue-500"/> Apostado</span>
            <span className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-slate-500"/> Disponible</span>
          </div>
        </div>
      </div>

      {/* Sport ROI Bar Chart & Heatmap */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="section-title text-sm mb-4">ROI por Deporte</h3>
          {sportData.some(d => d.won > 0 || d.lost > 0) ? (
            <div className="h-[250px] w-full">
              <ResponsiveContainer>
                <BarChart data={sportData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2A2A40" vertical={false} />
                  <XAxis dataKey="name" stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                  <RechartsTooltip cursor={{fill: '#2A2A40'}} contentStyle={{ backgroundColor: '#1A1A2E', borderColor: '#2A2A40', borderRadius: '8px' }} formatter={(val: number) => [`${val.toFixed(1)}%`, 'ROI']} />
                  <Bar dataKey="roi" radius={[4,4,0,0]}>
                    {sportData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.roi >= 0 ? entry.color : COLORS.danger} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-text-muted text-sm text-center py-10">Sin datos de ROI</p>}
        </div>

        <div className="card">
          <h3 className="section-title text-sm mb-4">Actividad Reciente (P&L Heatmap)</h3>
          {heatmapData.length === 0 ? <p className="text-text-muted text-sm text-center py-10">Sin registros recientes</p> : (
            <div className="flex flex-wrap gap-1.5 justify-start pl-2">
              {heatmapData.map((d: any, i) => (
                <div 
                  key={i} 
                  title={`${d.date}: ${formatCOP(d.pl)}`}
                  className={cn(
                    "w-4 h-4 rounded-sm transition-transform hover:scale-125 cursor-pointer",
                    d.pl > 50000 ? "bg-green-500" :
                    d.pl > 0 ? "bg-green-500/50" :
                    d.pl === 0 ? "bg-surface-2" :
                    d.pl > -50000 ? "bg-red-500/50" : "bg-red-500"
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
