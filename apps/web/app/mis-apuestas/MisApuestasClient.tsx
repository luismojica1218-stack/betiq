'use client'

import { useState, useEffect } from 'react'
import {
  Ticket, ChevronLeft, ChevronRight, CheckCircle, XCircle,
  Download, Trophy, Globe, Dumbbell, AlertCircle,
  TrendingUp, TrendingDown, Clock, Loader2
} from 'lucide-react'
import { cn, formatCOP, formatPercent } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

type BetStatus = 'pending' | 'won' | 'lost' | 'void'
type SportFilter = 'all' | 'nba' | 'football' | 'tennis'

interface Bet {
  id:           string
  match:        string
  sport:        'nba' | 'football' | 'tennis'
  market:       string
  selection:    string
  odd_at_bet:   number
  amount_cop:   number
  potential_win: number
  status:       BetStatus
  profit_loss:  number
  bet_week:     string
  date:         string
  bookmaker:    string
}

const LOSS_REASONS = [
  { id: 'variance',              label: '📊 Varianza normal (el modelo era correcto)' },
  { id: 'model_overconfidence',  label: '🤖 Sobreconfianza del modelo' },
  { id: 'odds_value_poor',       label: '💸 Cuota sin valor real' },
  { id: 'recent_form_ignored',   label: '📉 Forma reciente ignorada' },
  { id: 'injury_key_player',     label: '🏥 Lesión jugador clave' },
]

// Helper to get current week's Monday in local date formatted string
function getMonday(d: Date) {
  d = new Date(d)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.setDate(diff))
}

export default function MisApuestasClient() {
  const [sportFilter,  setSportFilter]  = useState<SportFilter>('all')
  const [currentWeek,  setCurrentWeek]  = useState(() => {
    return getMonday(new Date()).toISOString().split('T')[0]
  })
  
  const [bets,         setBets]         = useState<Bet[]>([])
  const [loadingBets,  setLoadingBets]  = useState(true)
  const [updating,     setUpdating]     = useState<string | null>(null)

  // Loss modal state
  const [lossModal,    setLossModal]    = useState<{ betId: string; match: string } | null>(null)
  const [lossReason,   setLossReason]   = useState('variance')
  const [lossNotes,    setLossNotes]    = useState('')
  const [lossLoading,  setLossLoading]  = useState(false)
  const [patterns,     setPatterns]     = useState<any[]>([])

  useEffect(() => {
    async function initData() {
      try {
        const sup = createClient()
        const { data: { user } } = await sup.auth.getUser()

        const uid = user?.id || 'demo'
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
        
        // Fetch patterns passively
        fetch(`${API_URL}/api/analyze/patterns/${uid}`)
          .then(res => res.json())
          .then(data => setPatterns(data.patterns || []))
          .catch(() => {})

          if (user) {
          // Simple query — no join to avoid PostgREST ambiguity with null match_id
          const { data: betsData, error: betsError } = await sup.from('bets')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })

          if (betsError) console.error('Supabase bets error:', betsError)

          if (betsData && betsData.length > 0) {
            const mappedBets: Bet[] = betsData.map((b: any) => {
              const expectedPotential = Math.round((b.amount_cop || 0) * (b.odd_at_bet || 1))
              return {
                id: b.id,
                match: b.notes || b.selection || 'Mi Apuesta',
                sport: (b.sport || 'nba') as 'nba' | 'football' | 'tennis',
                market: b.market || 'Moneyline',
                selection: b.selection || '',
                odd_at_bet: parseFloat(b.odd_at_bet) || 1,
                amount_cop: b.amount_cop || 0,
                potential_win: b.potential_win_cop || expectedPotential,
                status: b.status || 'pending',
                profit_loss: b.profit_loss_cop || 0,
                bet_week: b.bet_week || b.created_at?.split('T')[0] || '',
                date: b.created_at ? b.created_at.split('T')[0] : (b.bet_week || ''),
                bookmaker: b.bookmaker || 'rushbet'
              }
            })
            setBets(mappedBets)
          } else {
            setBets([])
          }
        } else {
          setBets([])
        }
      } catch (err) {
        setBets([])
      } finally {
        setLoadingBets(false)
      }
    }
    initData()
  }, [])



  // Weeks navigation
  const weekStart = new Date(currentWeek)
  const weekEnd   = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  
  const weekStartStr = weekStart.toISOString().split('T')[0]
  const weekEndStr   = weekEnd.toISOString().split('T')[0]

  function prevWeek() {
    const d = new Date(currentWeek)
    d.setDate(d.getDate() - 7)
    setCurrentWeek(d.toISOString().split('T')[0])
  }
  function nextWeek() {
    const d = new Date(currentWeek)
    d.setDate(d.getDate() + 7)
    setCurrentWeek(d.toISOString().split('T')[0])
  }

  // Use standard dates comparison instead of strict bet_week comparison
  const weekBets = bets.filter(b => {
    const d = b.date || b.bet_week
    return d >= weekStartStr && d <= weekEndStr
  })
  
  const totalApostado = weekBets.reduce((sum, b) => sum + b.amount_cop, 0)
  const totalGanado   = weekBets.filter(b => b.status === 'won').reduce((sum, b) => sum + b.potential_win, 0)
  const profitLoss    = weekBets.reduce((sum, b) => sum + b.profit_loss, 0)
  const wonCount      = weekBets.filter(b => b.status === 'won').length
  const lostCount     = weekBets.filter(b => b.status === 'lost').length
  const finishedCount = wonCount + lostCount
  const roi           = totalApostado > 0 ? (profitLoss / totalApostado) * 100 : 0
  const successPct    = finishedCount > 0 ? (wonCount / finishedCount) * 100 : 0

  const pendingBets = weekBets.filter(b => b.status === 'pending')
  const allBets = bets.filter(b => sportFilter === 'all' || b.sport === sportFilter)

  async function markResult(betId: string, result: 'won' | 'lost') {
    if (result === 'lost') {
      const bet = bets.find(b => b.id === betId)
      setLossModal({ betId, match: bet?.match || '' })
      return
    }
    
    setUpdating(betId)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
      
      if (user && !betId.startsWith('b')) {
        await fetch(`${API_URL}/api/bets/${betId}/result`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'won' })
        }).catch(() => {})
      } else {
        // Fallback or demo update
        try {
          await supabase.from('bets').update({
            status: 'won',
            result_confirmed_at: new Date().toISOString(),
          }).eq('id', betId)
        } catch { /* ignore */ }
      }
    } catch { /* local update fallback */ }

    setBets(prev => prev.map(b =>
      b.id !== betId ? b :
      { ...b, status: 'won', profit_loss: b.potential_win - b.amount_cop }
    ))
    setUpdating(null)
  }

  async function confirmLoss() {
    if (!lossModal) return
    setLossLoading(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

      if (user && !lossModal.betId.startsWith('b')) {
        await fetch(`${API_URL}/api/bets/${lossModal.betId}/result`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            status: 'lost',
            loss_reason: lossReason,
            loss_description: lossNotes
          })
        }).catch(() => {})
        
        await fetch(`${API_URL}/api/analyze/loss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bet_id: lossModal.betId })
        }).catch(() => {})

      } else {
        try {
          await supabase.from('bets').update({
            status: 'lost',
            loss_reason: lossReason,
            result_confirmed_at: new Date().toISOString(),
            profit_loss_cop: -(bets.find(b => b.id === lossModal.betId)?.amount_cop || 0),
          }).eq('id', lossModal.betId)
        } catch { /* ignore */ }
      }
    } catch { /* local fallback */ }

    setBets(prev => prev.map(b =>
      b.id !== lossModal.betId ? b :
      { ...b, status: 'lost', profit_loss: -b.amount_cop }
    ))
    setLossModal(null)
    setLossNotes('')
    setLossLoading(false)
  }

  function exportCSV() {
    const headers = ['Fecha', 'Partido', 'Deporte', 'Mercado', 'Cuota', 'Monto', 'Resultado', 'P&L']
    const rows = allBets.map(b => [
      b.date, b.match, b.sport, b.market,
      b.odd_at_bet.toFixed(2), b.amount_cop, b.status,
      b.profit_loss
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `betiq_apuestas_${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sportIcon = (s: string) =>
    s === 'nba' ? <Trophy className="w-3.5 h-3.5 text-nba-blue" /> :
    s === 'football' ? <Globe className="w-3.5 h-3.5 text-football-green" /> :
    <Dumbbell className="w-3.5 h-3.5 text-tennis-orange" />

  if (loadingBets) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="w-10 h-10 animate-spin text-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Ticket className="w-6 h-6 text-accent" />
            Mis Apuestas
          </h2>
          <p className="text-text-muted text-sm mt-1">Historial, seguimiento y análisis de rendimiento</p>
        </div>
      </div>

      {/* Weekly Summary */}
      <div className="card">
        {/* Week selector */}
        <div className="flex items-center justify-between mb-5">
          <button onClick={prevWeek} className="btn-ghost p-2">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-center">
            <div className="text-sm font-bold text-text">
              Semana del {weekStart.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}
              {' '}al {weekEnd.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
            <div className="text-xs text-text-muted">{weekBets.length} apuestas registradas</div>
          </div>
          <button onClick={nextWeek} className="btn-ghost p-2">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Presupuesto', value: formatCOP(200000), cls: 'text-text' },
            { label: 'Apostado',    value: formatCOP(totalApostado), cls: 'text-text', sub: `${((totalApostado/200000)*100).toFixed(0)}% usado` },
            { label: 'Ganado',      value: formatCOP(totalGanado),   cls: 'text-success' },
            { label: 'Utilidad',    value: formatCOP(profitLoss),    cls: profitLoss >= 0 ? 'text-success' : 'text-danger' },
            { label: 'ROI',         value: formatPercent(roi),       cls: roi >= 0 ? 'text-success' : 'text-danger' },
            { label: 'Tasa Éxito',  value: `${successPct.toFixed(0)}%`, cls: 'text-text', sub: `${wonCount}/${finishedCount}` },
          ].map(kpi => (
            <div key={kpi.label} className="bg-surface-2/50 rounded-xl p-3 text-center">
              <div className={cn('text-xl font-bold', kpi.cls)}>{kpi.value}</div>
              <div className="text-xs text-text-muted mt-1">{kpi.label}</div>
              {kpi.sub && <div className="text-xs text-text-muted/60">{kpi.sub}</div>}
            </div>
          ))}
        </div>

        {/* P&L bar */}
        {totalApostado > 0 && (
          <div className="mt-4">
            <div className="h-2 bg-surface-2 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-success transition-all duration-700"
                style={{ width: `${Math.min((totalGanado / totalApostado) * 100, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-text-muted mt-1">
              <span>Apostado: {formatCOP(totalApostado)}</span>
              <span className={profitLoss >= 0 ? 'text-success' : 'text-danger'}>
                {profitLoss >= 0 ? '▲' : '▼'} {formatCOP(Math.abs(profitLoss))} neto
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Active / Pending Bets */}
      {pendingBets.length > 0 && (
        <div>
          <h3 className="section-title mb-4">Apuestas Activas de la Semana ({pendingBets.length})</h3>
          <div className="space-y-3">
            {pendingBets.map(bet => (
              <div key={bet.id} className="card border-warning/20">
                <div className="flex items-start gap-4">
                  <div className="p-2.5 bg-warning/10 rounded-xl flex-shrink-0">
                    <Clock className="w-5 h-5 text-warning" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {sportIcon(bet.sport)}
                      <span className="font-bold text-text text-sm">{bet.match}</span>
                      <span className="badge badge-warning">Pendiente</span>
                    </div>
                    <div className="text-xs text-text-muted mt-1">
                      {bet.market} · {bet.selection} · Cuota {bet.odd_at_bet.toFixed(2)} · {bet.bookmaker}
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-sm">
                      <span className="text-text-muted">Apostado: <span className="text-text font-semibold">{formatCOP(bet.amount_cop)}</span></span>
                      <span className="text-text-muted">Potencial: <span className="text-success font-semibold">{formatCOP(bet.potential_win)}</span></span>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      id={`won-${bet.id}`}
                      onClick={() => markResult(bet.id, 'won')}
                      disabled={updating === bet.id}
                      className="btn-success text-xs py-2 px-3"
                    >
                      {updating === bet.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><CheckCircle className="w-3.5 h-3.5" /> GANÉ</>}
                    </button>
                    <button
                      id={`lost-${bet.id}`}
                      onClick={() => markResult(bet.id, 'lost')}
                      disabled={updating === bet.id}
                      className="btn-danger text-xs py-2 px-3"
                    >
                      <XCircle className="w-3.5 h-3.5" /> PERDÍ
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-title">Historial de Apuestas (Todas)</h3>
          <div className="flex items-center gap-3">
            {/* Sport filter tabs */}
            <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
              {(['all', 'nba', 'football', 'tennis'] as SportFilter[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSportFilter(s)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-semibold transition-all capitalize',
                    sportFilter === s ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
                  )}
                >
                  {s === 'all' ? 'Todo' : s === 'nba' ? 'NBA' : s === 'football' ? 'Fútbol' : 'Tenis'}
                </button>
              ))}
            </div>
            <button onClick={exportCSV} className="btn-secondary text-xs py-2">
              <Download className="w-3.5 h-3.5" />
              Exportar CSV
            </button>
          </div>
        </div>

        {allBets.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-14 text-center gap-4">
            <Ticket className="w-12 h-12 text-text-muted/30" />
            <div>
              <p className="text-text font-semibold mb-1">No hay apuestas registradas</p>
              <p className="text-text-muted text-sm">
                Ve a{' '}
                <a href="/nba" className="text-accent hover:underline">NBA</a>,{' '}
                <a href="/futbol" className="text-accent hover:underline">Fútbol</a> o{' '}
                <a href="/tenis" className="text-accent hover:underline">Tenis</a>{' '}
                y presiona <strong>Agregar a Mis Apuestas</strong> en cualquier partido con EV positivo.
              </p>
            </div>
          </div>
        ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/30">
                  {['Fecha', 'Partido', 'Mercado', 'Cuota', 'Monto', 'Resultado', 'P&L'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-text-muted font-semibold uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-2/30">
                {allBets.map(bet => (
                  <tr key={bet.id} className="hover:bg-surface-2/20 transition-colors">
                    <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">{bet.date}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {sportIcon(bet.sport)}
                        <span className="text-text font-medium text-xs">{bet.match}</span>
                      </div>
                      <div className="text-xs text-text-muted ml-5">{bet.selection}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">{bet.market}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-text">{bet.odd_at_bet.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-text">{formatCOP(bet.amount_cop)}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'badge',
                        bet.status === 'won'     ? 'badge-success' :
                        bet.status === 'lost'    ? 'badge-danger'  :
                        bet.status === 'pending' ? 'badge-warning' :
                        'badge-blue'
                      )}>
                        {bet.status === 'won' ? '✓ Ganó' : bet.status === 'lost' ? '✗ Perdió' : bet.status === 'pending' ? '⏳ Pendiente' : 'Void'}
                      </span>
                    </td>
                    <td className={cn(
                      'px-4 py-3 text-sm font-bold',
                      bet.profit_loss > 0 ? 'text-success' :
                      bet.profit_loss < 0 ? 'text-danger'  : 'text-text-muted'
                    )}>
                      {bet.status === 'pending' ? '—' : (
                        <span className="flex items-center gap-1">
                          {bet.profit_loss > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : bet.profit_loss < 0 ? <TrendingDown className="w-3.5 h-3.5" /> : null}
                          {bet.profit_loss >= 0 ? '+' : ''}{formatCOP(bet.profit_loss)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="bg-surface-2/40 font-bold">
                  <td colSpan={4} className="px-4 py-3 text-xs text-text-muted uppercase">Totales Filtrados</td>
                  <td className="px-4 py-3 text-sm text-text">{formatCOP(allBets.reduce((s, b) => s + b.amount_cop, 0))}</td>
                  <td className="px-4 py-3 text-xs text-text-muted">{allBets.filter(b => b.status === 'won').length} ganadas</td>
                  <td className={cn(
                    'px-4 py-3 text-sm',
                    allBets.reduce((s, b) => s + b.profit_loss, 0) >= 0 ? 'text-success' : 'text-danger'
                  )}>
                    {allBets.reduce((s, b) => s + b.profit_loss, 0) >= 0 ? '+' : ''}
                    {formatCOP(allBets.reduce((s, b) => s + b.profit_loss, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        )}
      </div>

      {/* Loss Patterns */}
      <div className="mt-8">
        <h3 className="section-title mb-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-accent" />
          Patrones de Pérdida
        </h3>
        {patterns.length === 0 ? (
           <div className="card p-6 text-center text-text-muted italic bg-surface-2/30">
             Necesitas reportar apuestas perdidas para que el agente de BetIQ analice fallos en tu algoritmo.
           </div>
        ) : (
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
             {patterns.map((p, i) => (
                <div key={i} className={cn("p-4 rounded-xl border relative overflow-hidden", 
                  p.type === 'info' ? 'bg-blue-500/10 border-blue-500/20' : 
                  p.type === 'warning' ? 'bg-warning/10 border-warning/20' : 
                  p.type === 'danger' ? 'bg-danger/10 border-danger/20' : 
                  'bg-success/10 border-success/20'
                )}>
                  <h4 className={cn("text-sm font-bold mb-1", 
                    p.type === 'info' ? 'text-blue-400' : 
                    p.type === 'warning' ? 'text-warning' : 
                    p.type === 'danger' ? 'text-danger' : 
                    'text-success'
                  )}>{p.title}</h4>
                  <p className="text-xs text-text-muted leading-relaxed">{p.description}</p>
                </div>
             ))}
           </div>
        )}
      </div>

      {/* Loss modal */}
      {lossModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setLossModal(null)} />
          <div className="relative w-full max-w-md bg-surface border border-surface-2 rounded-2xl shadow-2xl animate-slide-up">
            <div className="px-6 py-4 border-b border-surface-2">
              <h3 className="text-lg font-bold text-text">Analizar Pérdida</h3>
              <p className="text-xs text-text-muted mt-0.5">{lossModal.match}</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-start gap-2 p-3 bg-danger/10 border border-danger/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                <div className="text-xs text-text-muted">
                  BetIQ analizará el motivo de la pérdida para mejorar las predicciones futuras
                </div>
              </div>
              <div>
                <label className="block text-xs text-text-muted font-medium mb-2 uppercase tracking-wider">
                  Razón de la pérdida
                </label>
                {LOSS_REASONS.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setLossReason(r.id)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 rounded-lg text-sm mb-1.5 border transition-all',
                      lossReason === r.id
                        ? 'bg-danger/10 border-danger/30 text-text'
                        : 'border-surface-2 text-text-muted hover:border-danger/20'
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs text-text-muted font-medium mb-1.5 uppercase tracking-wider">
                  Notas adicionales (opcional)
                </label>
                <textarea
                  value={lossNotes}
                  onChange={e => setLossNotes(e.target.value)}
                  placeholder="¿Qué pasó? ¿Algo que el modelo no consideró?"
                  className="input text-sm h-20 resize-none"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-surface-2 flex gap-3">
              <button onClick={() => setLossModal(null)} className="btn-secondary flex-1 justify-center">
                Cancelar
              </button>
              <button onClick={confirmLoss} disabled={lossLoading} className="btn-danger flex-1 justify-center border-0">
                {lossLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><XCircle className="w-4 h-4" /> Confirmar pérdida</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
