'use client'

import { useState, useEffect } from 'react'
import { Trophy, Clock, Filter, PlusCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { cn, formatCOP } from '@/lib/utils'
import ConfirmBetModal, { type BetCandidate } from '@/components/ui/ConfirmBetModal'

// ---- Market types ----
type FilterDate = 'today' | 'tomorrow' | '7days'
type FilterType = 'all' | 'fixed' | 'parlay'

export default function NBAPage() {
  const [filterDate, setFilterDate] = useState<FilterDate>('7days')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [minEV,      setMinEV]      = useState(0)
  const [activeBet,  setActiveBet]  = useState<BetCandidate | null>(null)
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set())
  const [liveMatches, setLiveMatches] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const [activeMarket, setActiveMarket] = useState<'moneyline' | 'props'>('moneyline')
  const [propsList, setPropsList] = useState<any[]>([])
  const [isPropsLoading, setIsPropsLoading] = useState(false)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const res = await fetch(`/api/nba/matches`)
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
             // Map backend format to UI format
             const mapped = data.matches.map((m: any) => {
                const pred = m.prediction || {}

                // Use most-recent odds per selection (backend already deduplicates by scraped_at desc)
                const homeOddRecord = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('home'))
                const awayOddRecord = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('away'))
                const homeOdd = homeOddRecord?.odd_value || 1.90
                const awayOdd = awayOddRecord?.odd_value || 1.90
                const bookmakerSrc = homeOddRecord?.bookmaker || 'espn'
                
                const predWinner = pred.predicted_outcome === 'home' || (m.home_team?.name && pred.predicted_outcome === m.home_team.name) ? 'home' : 'away'
                const predConf = pred.confidence || 0.5
                const predOdd = predWinner === 'home' ? homeOdd : awayOdd
                // Recalculate EV live from confidence + current odds (stored value can be null/stale)
                const liveEV = predConf * predOdd - 1
                const liveBetType = liveEV >= 0.08 ? 'parlay' : liveEV >= 0.05 ? 'fixed' : null

                return {
                  id: m.id,
                  homeTeam: m.home_team?.name || 'Local',
                  awayTeam: m.away_team?.name || 'Visitante',
                  date: new Date(m.match_date).toLocaleString('es-CO', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}),
                  status: m.status,
                  odds: { home: homeOdd, away: awayOdd, source: bookmakerSrc, realOdds: pred.real_odds ?? false },
                  prediction: {
                    winner: predWinner,
                    prob: predConf,
                    ev: liveEV,
                    betType: liveBetType ?? (pred.bet_type || null),
                    amount: pred.suggested_amount_cop || 0,
                    confidence: predConf
                  }
                }
             })
             setLiveMatches(mapped)
          }
        }
      } catch (err) {
        console.error("No real stats. Falling back to mocks.")
      } finally {
        setIsLoading(false)
      }
    }
    fetchMatches()
  }, [])

  useEffect(() => {
    if (activeMarket !== 'props' || propsList.length > 0) return
    async function fetchProps() {
      setIsPropsLoading(true)
      try {
        const res = await fetch(`/api/nba/props`)
        if (res.ok) setPropsList((await res.json()).props || [])
      } catch(e) { }
      finally { setIsPropsLoading(false) }
    }
    fetchProps()
  }, [activeMarket])

  const filtered = liveMatches.filter(m => {
    if (filterDate === 'today' && !m.date.startsWith('Hoy')) return false
    if (filterDate === 'tomorrow' && !m.date.startsWith('Mañana')) return false
    if (filterType === 'fixed'  && m.prediction.betType !== 'fixed')  return false
    if (filterType === 'parlay' && m.prediction.betType !== 'parlay') return false
    if (m.prediction.ev * 100 < minEV) return false
    return true
  })

  function openBetModal(match: any) {
    const pred = match.prediction
    const isHome = pred.winner === 'home'
    setActiveBet({
      matchId:         match.id,
      homeTeam:        match.homeTeam,
      awayTeam:        match.awayTeam,
      sport:           'nba',
      market:          'Moneyline',
      selection:       isHome ? `${match.homeTeam} (Local)` : `${match.awayTeam} (Visitante)`,
      suggestedOdd:    isHome ? match.odds.home : match.odds.away,
      suggestedAmount: pred.amount,
      confidence:      pred.confidence,
      expectedValue:   pred.ev,
      betType:         pred.betType,
    })
  }

  function handleConfirmed(_betId: string) {
    if (activeBet) {
      setConfirmedIds(prev => new Set(Array.from(prev).concat(activeBet.matchId)))
    }
    setActiveBet(null)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Trophy className="w-6 h-6 text-blue-400" />
            NBA — Predicciones
          </h2>
          <p className="text-text-muted text-sm mt-1">
            Partidos próximos con análisis ML y Expected Value
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted bg-surface-2 px-3 py-2 rounded-lg">
          <Clock className="w-3.5 h-3.5" />
          Actualizado recientemente
        </div>
      </div>

      {/* Market Selector */}
      <div className="flex items-center gap-1 bg-surface-2 rounded-xl p-1.5 w-max mb-1">
        {[
          { id: 'moneyline', label: 'Equipos (1X2 / Spread)' },
          { id: 'props', label: 'Jugadores (PRA)' }
        ].map(m => (
          <button
            key={m.id}
            onClick={() => setActiveMarket(m.id as any)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              activeMarket === m.id ? 'bg-surface text-text shadow-md' : 'text-text-muted hover:text-text'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Filters (only for moneyline usually, but EV filter applies to both) */}
      {activeMarket === 'moneyline' && (
      <div className="card py-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Date filter */}
          <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
            {([['today', 'Hoy'], ['tomorrow', 'Mañana'], ['7days', '7 Días']] as [FilterDate, string][]).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setFilterDate(val)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                  filterDate === val ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Type filter */}
          <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
            {([['all', 'Todas'], ['fixed', 'Fijas'], ['parlay', 'Parlay']] as [FilterType, string][]).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setFilterType(val)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                  filterType === val ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* EV slider */}
          <div className="flex items-center gap-3 flex-1 min-w-[200px]">
            <Filter className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted whitespace-nowrap">EV mín: {minEV}%</span>
            <input
              type="range" min={0} max={15} step={1} value={minEV}
              onChange={e => setMinEV(Number(e.target.value))}
              className="flex-1 accent-accent cursor-pointer"
            />
            <span className="text-xs text-text-muted">15%</span>
          </div>
        </div>
      </div>
      )}

      {/* Match grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {activeMarket === 'props' ? (
          isPropsLoading ? (
            <div className="col-span-full text-center py-12 text-text-muted">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
              <p>Calculando proyecciones de jugadores...</p>
            </div>
          ) : propsList.length === 0 ? (
            <div className="col-span-full text-center py-12 text-text-muted">
              <Trophy className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No hay líneas PRA generadas para los partidos de hoy</p>
            </div>
          ) : (
            propsList.filter(p => p.prediction.ev * 100 >= minEV).map(prop => {
              const evPct = (prop.prediction.ev * 100).toFixed(1)
              const evGood = prop.prediction.ev >= 0.08
              const evOk = prop.prediction.ev >= 0.05
              const confirmed = confirmedIds.has(prop.id)
              return (
                <div key={prop.id} className={cn('card relative overflow-hidden group transition-all duration-300', evGood && 'border-green-500/20')}>
                  <div className="absolute top-0 right-0 px-3 py-1 text-xs font-bold bg-accent text-white" style={{ borderRadius: '0 0 0 8px' }}>
                    PRA PROP
                  </div>
                  <div className="mb-4">
                    <div className="text-sm font-bold text-text-muted mb-1">{prop.team}</div>
                    <div className="text-xl font-bold text-text">{prop.player}</div>
                    <div className="text-xs text-text-muted mt-1">Línea Puntos + Rebotes + Asistencias</div>
                  </div>
                  <div className="flex items-center justify-between mb-3 p-2.5 bg-surface-2/60 rounded-lg">
                    <div>
                      <div className="text-xs text-text-muted">Pred. PRA</div>
                      <div className="text-sm font-bold text-text">{prop.prediction.expected_pra}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs text-text-muted">Línea Sug.</div>
                      <div className="text-sm font-bold text-accent">{prop.prediction.recommended} {prop.line}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-text-muted">Cuota</div>
                      <div className="text-sm font-bold text-text">{prop.prediction.recommended === 'OVER' ? prop.odds.over : prop.odds.under}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-4">
                    <span className={cn('badge', evGood ? 'badge-success' : evOk ? 'badge-warning' : 'badge-danger')}>
                      {evGood ? '✓' : evOk ? '~' : '!'} EV: {evPct}%
                    </span>
                  </div>
                  {confirmed ? (
                    <div className="w-full py-2.5 rounded-lg bg-success/10 border border-success/20 text-success text-sm font-semibold text-center">
                      ✓ Registrada
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setActiveBet({
                          matchId: prop.match_id || prop.id,
                          homeTeam: prop.team,
                          awayTeam: 'Oponente',
                          sport: 'nba',
                          market: 'Player Props (PRA)',
                          selection: `${prop.player} ${prop.prediction.recommended} ${prop.line} PRA`,
                          suggestedOdd: prop.prediction.recommended === 'OVER' ? prop.odds.over : prop.odds.under,
                          suggestedAmount: evGood ? 25000 : 10000,
                          confidence: prop.prediction.prob,
                          expectedValue: prop.prediction.ev,
                          betType: 'fixed'
                        })
                      }}
                      disabled={prop.prediction.ev < 0.03}
                      className={cn('w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all', prop.prediction.ev >= 0.03 ? 'btn-primary' : 'bg-surface-2 text-text-muted cursor-not-allowed')}
                    >
                      <PlusCircle className="w-4 h-4" />
                      Agregar apuesta de jugador
                    </button>
                  )}
                </div>
              )
            })
          )
        ) : isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Conectando con Supabase y Scrapers...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Trophy className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos con los filtros actuales</p>
          </div>
        ) : (
          filtered.map(match => {
            const pred     = match.prediction
            const isHome   = pred.winner === 'home'
            const winnerOdd = isHome ? match.odds.home : match.odds.away
            const evPct    = (pred.ev * 100).toFixed(1)
            const evGood   = pred.ev >= 0.08
            const evOk     = pred.ev >= 0.05
            const confirmed = confirmedIds.has(match.id)

            return (
              <div
                key={match.id}
                className={cn(
                  'card relative overflow-hidden group transition-all duration-300',
                  pred.betType === 'parlay' && 'border-orange-500/20',
                  pred.betType === 'fixed'  && 'border-blue-500/20',
                )}
              >
                {/* Bet type ribbon */}
                <div className={cn(
                  'absolute top-0 right-0 px-3 py-1 text-xs font-bold',
                  pred.betType === 'parlay' ? 'bg-orange-500 text-white' : 'bg-blue-600 text-white'
                )}
                  style={{ borderRadius: '0 0 0 8px' }}
                >
                  {pred.betType === 'parlay' ? '⚡ PARLAY' : '🔒 FIJA'}
                </div>

                {/* Teams */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-bold text-text">{match.homeTeam}</div>
                    <div className={cn(
                      'text-lg font-bold',
                      isHome ? 'text-accent' : 'text-text-muted'
                    )}>
                      {match.odds.home.toFixed(2)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-text">{match.awayTeam}</div>
                    <div className={cn(
                      'text-lg font-bold',
                      !isHome ? 'text-accent' : 'text-text-muted'
                    )}>
                      {match.odds.away.toFixed(2)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <div className="text-xs text-text-muted flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {match.date}
                    </div>
                    <div className={cn(
                      'text-xs font-semibold px-1.5 py-0.5 rounded',
                      (match.odds as any).realOdds
                        ? 'text-green-400 bg-green-500/10'
                        : 'text-text-muted bg-surface-2'
                    )}>
                      {(match.odds as any).realOdds
                        ? `📊 ${(match.odds as any).source}`
                        : '〜 Proyectado'}
                    </div>
                  </div>
                </div>

                {/* Prediction badge */}
                <div className="flex items-center justify-between mb-3 p-2.5 bg-surface-2/60 rounded-lg">
                  <div>
                    <div className="text-xs text-text-muted">Predicción</div>
                    <div className="text-sm font-bold text-text">
                      {isHome ? 'LOCAL' : 'VISITANTE'} {(pred.prob * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-text-muted">Cuota</div>
                    <div className="text-sm font-bold text-accent">{winnerOdd.toFixed(2)}</div>
                  </div>
                </div>

                {/* EV + amount badges */}
                <div className="flex items-center gap-2 mb-4">
                  <span className={cn(
                    'badge',
                    evGood ? 'badge-success' : evOk ? 'badge-warning' : 'badge-danger'
                  )}>
                    {evGood ? '✓' : evOk ? '~' : '!'} EV: {evPct}%
                  </span>
                  {pred.amount > 0 && (
                    <span className="badge badge-blue">
                      💰 {formatCOP(pred.amount)}
                    </span>
                  )}
                  {!evOk && (
                    <span className="badge badge-danger flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Sin valor
                    </span>
                  )}
                </div>

                {/* Confidence bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-text-muted">Confianza del modelo</span>
                    <span className="text-text font-semibold">{(pred.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-700',
                        pred.confidence >= 0.70 ? 'bg-success' : pred.confidence >= 0.60 ? 'bg-warning' : 'bg-danger'
                      )}
                      style={{ width: `${pred.confidence * 100}%` }}
                    />
                  </div>
                </div>

                {/* Action */}
                {confirmed ? (
                  <div className="w-full py-2.5 rounded-lg bg-success/10 border border-success/20 text-success text-sm font-semibold text-center">
                    ✓ Apuesta registrada
                  </div>
                ) : (
                  <button
                    onClick={() => openBetModal(match)}
                    disabled={pred.ev < 0.03}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all',
                      pred.ev >= 0.03
                        ? 'btn-primary'
                        : 'bg-surface-2 text-text-muted cursor-not-allowed'
                    )}
                  >
                    <PlusCircle className="w-4 h-4" />
                    {pred.ev >= 0.03 ? 'Agregar a Mis Apuestas' : 'EV insuficiente'}
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Confirm modal */}
      <ConfirmBetModal
        bet={activeBet}
        onClose={() => setActiveBet(null)}
        onConfirm={handleConfirmed}
      />
    </div>
  )
}
