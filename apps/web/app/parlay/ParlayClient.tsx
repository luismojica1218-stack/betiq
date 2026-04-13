'use client'

import { useState, useMemo, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { Zap, Plus, Trash2, CheckCircle, AlertTriangle, TrendingUp, DollarSign, Loader2, Trophy, Globe, X } from 'lucide-react'
import { cn, formatCOP } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

// ---- Available bets pool (from all sports with parlay_worthy = true) --------
const AVAILABLE_BETS = [
  // NBA
  { id: 'nba-1', sport: 'nba',      match: 'Celtics vs Knicks',         market: 'Moneyline',     selection: 'Boston Celtics',      odd: 1.65, ev: 0.087, prob: 0.68, flag: '🏀' },
  { id: 'nba-3', sport: 'nba',      match: 'Nuggets vs Thunder',        market: 'Moneyline',     selection: 'Denver Nuggets',      odd: 1.55, ev: 0.130, prob: 0.73, flag: '🏀' },
  { id: 'nba-4', sport: 'nba',      match: 'Heat vs 76ers',             market: 'Moneyline',     selection: 'Philadelphia 76ers',  odd: 1.78, ev: 0.086, prob: 0.61, flag: '🏀' },
  { id: 'nba-5', sport: 'nba',      match: 'Bucks vs Pacers',           market: 'Moneyline',     selection: 'Milwaukee Bucks',     odd: 1.45, ev: 0.118, prob: 0.77, flag: '🏀' },
  // Football
  { id: 'f1',    sport: 'football', match: 'Arsenal vs Man City',       market: 'Over/Under',    selection: 'Más de 2.5 goles',   odd: 1.85, ev: 0.092, prob: 0.64, flag: '⚽' },
  { id: 'f4',    sport: 'football', match: 'Flamengo vs River Plate',   market: 'BTTS',          selection: 'Ambos marcan',       odd: 1.75, ev: 0.115, prob: 0.58, flag: '⚽' },
  { id: 'f6',    sport: 'football', match: 'Leverkusen vs Dortmund',    market: 'Over/Under',    selection: 'Más de 2.5 goles',   odd: 1.75, ev: 0.103, prob: 0.63, flag: '⚽' },
  { id: 'f2',    sport: 'football', match: 'Real Madrid vs Barcelona',  market: '1X2',           selection: 'Real Madrid gana',   odd: 2.10, ev: 0.058, prob: 0.49, flag: '⚽' },
]

const MAX_LEGS   = 5
const KELLY_FRAC = 0.25

function getProbabilityRating(prob: number) {
  if (prob >= 0.70) return { label: '⭐⭐⭐', cls: 'text-success', desc: 'Alta confianza' }
  if (prob >= 0.60) return { label: '⭐⭐',   cls: 'text-warning', desc: 'Confianza media' }
  return              { label: '⭐',      cls: 'text-danger',  desc: 'Baja confianza' }
}

export default function ParlayClient() {
  const [legs,       setLegs]       = useState<typeof AVAILABLE_BETS>([])
  const [amount,     setAmount]     = useState(20000)
  const [bookmaker,  setBookmaker]  = useState<'rushbet' | 'betplay'>('rushbet')
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [error,      setError]      = useState('')
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(true)

  useEffect(() => {
    async function loadSuggestions() {
      try {
        const sup = createClient()
        const { data: { user } } = await sup.auth.getUser()
        // If not logged in we fallback to demo user ID for testing API
        const uid = user?.id || 'demo' 
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
        const res = await fetch(`${API_URL}/api/parlay/suggest?user_id=${uid}`)
        if (res.ok) {
          const data = await res.json()
          setSuggestions(data.suggestions || [])
        }
      } catch (err) {
        console.error("No se pudieron cargar sugerencias", err)
      } finally {
        setLoadingSuggestions(false)
      }
    }
    loadSuggestions()
  }, [])

  // ---- Calculations ----------------------------------------------------------
  const combinedOdd = useMemo(() => legs.reduce((acc, l) => acc * l.odd, 1), [legs])
  const combinedProb = useMemo(() => legs.reduce((acc, l) => acc * l.prob, 1), [legs])
  const potentialWin = Math.round(amount * combinedOdd)
  const profit       = potentialWin - amount
  const ev           = combinedProb * combinedOdd - 1

  // Kelly suggestion
  const b = combinedOdd - 1
  const kellyF    = b > 0 ? Math.max((combinedProb * b - (1 - combinedProb)) / b, 0) * KELLY_FRAC : 0
  const kellySugg = Math.round(Math.min(kellyF * 200000, 200000 * 0.15) / 5000) * 5000

  const isValid  = legs.length >= 2
  const isGoodEV = ev >= 0.05

  // ---- Actions ---------------------------------------------------------------
  function addLeg(bet: typeof AVAILABLE_BETS[0]) {
    if (legs.find(l => l.id === bet.id) || legs.length >= MAX_LEGS) return
    setLegs(prev => [...prev, bet])
    setSaved(false)
  }

  function removeLeg(id: string) {
    setLegs(prev => prev.filter(l => l.id !== id))
    setSaved(false)
  }

  async function saveParlay() {
    setError('')
    if (!isValid) { setError('Mínimo 2 selecciones'); return }
    setSaving(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('No autenticado')

      const legData = legs.map(l => ({
        selection: l.selection, match: l.match, market: l.market,
        sport: l.sport, odd: l.odd, prob: l.prob, ev: l.ev,
      }))

      const { error: sbErr } = await supabase.from('parlay_bets').insert({
        user_id:          user.id,
        bookmaker,
        total_amount_cop: amount,
        combined_odd:     parseFloat(combinedOdd.toFixed(3)),
        potential_win_cop: potentialWin,
        status:           'pending',
        bet_legs:         legData,
        bet_week:         new Date().toISOString().split('T')[0],
      })
      if (sbErr) throw new Error(sbErr.message)
      setSaved(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error guardando parlay')
    } finally {
      setSaving(false)
    }
  }

  // ---- Render ----------------------------------------------------------------
  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-text flex items-center gap-3">
          <Zap className="w-6 h-6 text-orange-400" />
          Constructor de Parlays
        </h2>
        <p className="text-text-muted text-sm mt-1">
          Combina hasta {MAX_LEGS} selecciones con EV positivo · Kelly sugiere el monto óptimo
        </p>
      </div>

      {/* Parlays Sugeridos VIP */}
      <div className="space-y-4 mb-8">
        <h3 className="section-title">✨ Parlays Sugeridos VIP</h3>
        {loadingSuggestions ? (
          <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-orange-400" /></div>
        ) : suggestions.length === 0 ? (
          <div className="card p-6 text-center text-text-muted italic bg-surface-2/30">
            No hay parlays sugeridos con valor estadístico positivo en este momento.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {suggestions.slice(0, 3).map((sugg, i) => (
              <div key={i} className="card relative overflow-hidden group">
                <div className="absolute top-0 right-0 px-2 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded-bl-lg">TOP {i + 1}</div>
                <div className="space-y-2 mb-3">
                  {sugg.legs.map((leg: any, j: number) => (
                    <div key={j} className="flex flex-col border-b border-surface/50 pb-2 last:border-0 last:pb-0">
                      <span className="text-xs text-text-muted capitalize">{leg.sport == 'football' ? '⚽' : leg.sport == 'nba' ? '🏀' : '🎾'} {leg.match}</span>
                      <span className="text-sm font-bold text-text truncate">{leg.selection} <span className="text-orange-400">({leg.odd.toFixed(2)})</span></span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between items-center bg-surface-2/50 p-2 rounded-lg mb-3">
                  <div>
                    <div className="text-xs text-text-muted">Cuota</div>
                    <div className="font-black text-white">{sugg.combined_odd.toFixed(2)}x</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-text-muted">EV + ROI</div>
                    <div className="font-bold text-success">+{(sugg.ev_parlay * 100).toFixed(1)}%</div>
                  </div>
                </div>
                <button 
                  onClick={() => {
                    setLegs(sugg.legs)
                    setAmount(sugg.suggested_amount_cop || 20000)
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
                  }} 
                  className="w-full btn-secondary py-2 border-orange-500/30 text-sm font-semibold hover:bg-orange-500/10"
                >
                  Personalizar y Apostar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: bet pool */}
        <div className="lg:col-span-3 space-y-4">
          <h3 className="section-title">Selecciones Disponibles ⚡ EV+</h3>

          {/* Sport filters */}
          <div className="flex gap-2">
            {[['all', '🌍 Todas'], ['nba', '🏀 NBA'], ['football', '⚽ Fútbol']].map(([s, label]) => (
              <span key={s} className="badge badge-blue cursor-default">{label}</span>
            ))}
          </div>

          <div className="space-y-2">
            {AVAILABLE_BETS.map(bet => {
              const isAdded   = !!legs.find(l => l.id === bet.id)
              const isFull    = legs.length >= MAX_LEGS && !isAdded
              const rating    = getProbabilityRating(bet.prob)

              return (
                <div
                  key={bet.id}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-xl border transition-all',
                    isAdded   ? 'bg-orange-500/10 border-orange-500/30' :
                    isFull    ? 'bg-surface-2/20 border-surface-2/30 opacity-50' :
                    'bg-surface-2/30 border-surface-2/50 hover:border-orange-400/30 cursor-pointer',
                  )}
                  onClick={() => !isAdded && !isFull && addLeg(bet)}
                >
                  {/* Sport icon */}
                  <span className="text-xl flex-shrink-0">{bet.flag}</span>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-muted truncate">{bet.match}</div>
                    <div className="text-sm font-bold text-text truncate">{bet.selection}</div>
                    <div className="text-xs text-text-muted">{bet.market}</div>
                  </div>

                  {/* Stats */}
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-lg font-black text-text">{bet.odd.toFixed(2)}</span>
                    <span className={cn('text-xs font-bold', rating.cls)}>{rating.label}</span>
                    <span className={cn('badge', bet.ev >= 0.08 ? 'badge-success' : 'badge-warning')}>
                      EV {(bet.ev * 100).toFixed(1)}%
                    </span>
                  </div>

                  {/* Add btn */}
                  <button
                    onClick={e => { e.stopPropagation(); !isAdded && !isFull && addLeg(bet) }}
                    className={cn(
                      'p-2 rounded-lg transition-all flex-shrink-0',
                      isAdded  ? 'bg-orange-500/20 text-orange-400' :
                      isFull   ? 'text-text-muted cursor-not-allowed' :
                      'bg-surface-2 hover:bg-orange-500/20 text-text-muted hover:text-orange-400',
                    )}
                    disabled={isFull}
                  >
                    {isAdded ? <CheckCircle className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: parlay builder */}
        <div className="lg:col-span-2 space-y-4">
          {/* Parlay ticket */}
          <div className="card border-orange-500/20 bg-orange-500/5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-text">Tu Parlay</h3>
              <span className={cn('badge', isValid ? 'badge-success' : 'badge-warning')}>
                {legs.length}/{MAX_LEGS} selecciones
              </span>
            </div>

            {/* Legs list */}
            {legs.length === 0 ? (
              <div className="text-center py-8">
                <Zap className="w-8 h-8 mx-auto mb-2 text-text-muted/30" />
                <p className="text-text-muted text-sm">Añade selecciones desde la lista</p>
                <p className="text-text-muted/60 text-xs mt-1">Mínimo 2, máximo {MAX_LEGS}</p>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                {legs.map((leg, i) => (
                  <div key={leg.id} className="flex items-center gap-2 p-2 bg-surface-2/40 rounded-lg">
                    <span className="text-text-muted text-xs w-4">{i + 1}</span>
                    <span>{leg.flag}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-text truncate font-semibold">{leg.selection}</div>
                      <div className="text-xs text-text-muted truncate">{leg.match}</div>
                    </div>
                    <span className="text-sm font-bold text-orange-400 flex-shrink-0">{leg.odd.toFixed(2)}</span>
                    <button
                      onClick={() => removeLeg(leg.id)}
                      className="text-text-muted hover:text-danger p-1 rounded transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Combined stats */}
            {legs.length >= 2 && (
              <div className="space-y-2 mb-4">
                <div className="divider" />
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Cuota combinada</span>
                  <span className="text-text font-black text-lg">{combinedOdd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Prob. conjunta</span>
                  <span className="text-text font-semibold">{(combinedProb * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">EV combinado</span>
                  <span className={cn('font-bold', ev >= 0 ? 'text-success' : 'text-danger')}>
                    {ev >= 0 ? '+' : ''}{(ev * 100).toFixed(1)}%
                  </span>
                </div>
                {!isGoodEV && ev > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-warning bg-warning/10 p-2 rounded-lg">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    EV bajo — considera eliminar la selección menos segura
                  </div>
                )}
                {ev < 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-danger bg-danger/10 p-2 rounded-lg">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    EV negativo — la combinatoria destruye el valor
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Amount + bookmaker */}
          {isValid && (
            <div className="card space-y-4">
              {/* Kelly suggestion */}
              {kellySugg > 0 && (
                <div
                  className="flex items-center justify-between p-2.5 bg-orange-500/10 border border-orange-500/20 rounded-lg cursor-pointer hover:bg-orange-500/15 transition-colors"
                  onClick={() => setAmount(kellySugg)}
                >
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <Zap className="w-4 h-4 text-orange-400" />
                    <span>Kelly sugiere:</span>
                  </div>
                  <span className="text-orange-400 font-bold text-sm">{formatCOP(kellySugg)}</span>
                </div>
              )}

              {/* Monto */}
              <div>
                <label className="block text-xs text-text-muted font-medium mb-1.5 uppercase tracking-wider">Monto (COP)</label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                  <input
                    type="number" min={5000} step={5000} value={amount}
                    onChange={e => setAmount(Number(e.target.value))}
                    className="input pl-9 text-sm"
                  />
                </div>
                {/* Quick amounts */}
                <div className="flex gap-1.5 mt-2">
                  {[10000, 20000, 30000, 50000].map(a => (
                    <button
                      key={a}
                      onClick={() => setAmount(a)}
                      className={cn(
                        'flex-1 py-1 rounded text-xs font-semibold transition-all',
                        amount === a ? 'bg-orange-500 text-white' : 'bg-surface-2 text-text-muted hover:text-text'
                      )}
                    >
                      {a / 1000}K
                    </button>
                  ))}
                </div>
              </div>

              {/* Bookmaker */}
              <div>
                <label className="block text-xs text-text-muted font-medium mb-1.5 uppercase tracking-wider">Casa de Apuestas</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['rushbet', 'betplay'] as const).map(bk => (
                    <button
                      key={bk}
                      onClick={() => setBookmaker(bk)}
                      className={cn(
                        'py-2 rounded-lg border-2 text-sm font-semibold capitalize transition-all',
                        bookmaker === bk ? 'border-orange-500 bg-orange-500/10 text-text' : 'border-surface-2 text-text-muted hover:border-orange-400/30'
                      )}
                    >
                      {bk}
                    </button>
                  ))}
                </div>
              </div>

              {/* P&L preview */}
              <div className="p-3 bg-success/10 border border-success/20 rounded-xl">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <TrendingUp className="w-4 h-4 text-success" />
                    Ganancia potencial
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-black text-success">{formatCOP(potentialWin)}</div>
                    <div className="text-xs text-text-muted">+{formatCOP(profit)} neto</div>
                  </div>
                </div>
              </div>

              {error && (
                <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg p-2.5">
                  {error}
                </div>
              )}

              {saved ? (
                <div className="py-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm font-semibold text-center">
                  ✓ Parlay registrado en Mis Apuestas
                </div>
              ) : (
                <button
                  onClick={saveParlay}
                  disabled={saving || !isValid}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all',
                    isValid && !saving ? 'bg-orange-500 hover:bg-orange-600 text-white shadow-lg' : 'bg-surface-2 text-text-muted cursor-not-allowed'
                  )}
                >
                  {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Guardando...</> : <><Zap className="w-4 h-4" /> Confirmar Parlay</>}
                </button>
              )}
            </div>
          )}

          {/* Tips */}
          <div className="card bg-surface-2/30 space-y-2">
            <h4 className="text-sm font-bold text-text">💡 Reglas del Parlay BetIQ</h4>
            <ul className="text-xs text-text-muted space-y-1">
              <li>• Mínimo 2 selecciones, máximo {MAX_LEGS}</li>
              <li>• Solo se incluyen picks con EV ≥ 5%</li>
              <li>• Kelly al 25% — protege el presupuesto</li>
              <li>• No combinar más de 2 partidos del mismo deporte</li>
              <li>• EV combinado debe ser positivo</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
