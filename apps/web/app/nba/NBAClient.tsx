'use client'

import { useState, useEffect } from 'react'
import { Trophy, RefreshCw, Clock, Filter, ChevronDown, PlusCircle, TrendingUp, AlertTriangle, Loader2 } from 'lucide-react'
import { cn, formatCOP, getEVLabel } from '@/lib/utils'
import ConfirmBetModal, { type BetCandidate } from '@/components/ui/ConfirmBetModal'

// ---- Demo data (populated by ML predictions once scrapers run) ----
const DEMO_MATCHES = [
  {
    id: 'nba-1', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat',
    date: 'Hoy, 19:30', status: 'scheduled',
    odds: { home: 1.25, away: 4.30 },
    prediction: { winner: 'home', prob: 0.82, ev: 0.025, betType: 'parlay' as const, amount: 45000, confidence: 0.82 },
  },
  {
    id: 'nba-2', homeTeam: 'Denver Nuggets', awayTeam: 'LA Lakers',
    date: 'Hoy, 21:00', status: 'scheduled',
    odds: { home: 1.55, away: 2.65 },
    prediction: { winner: 'home', prob: 0.70, ev: 0.085, betType: 'fixed' as const, amount: 32000, confidence: 0.70 },
  },
  {
    id: 'nba-3', homeTeam: 'Oklahoma City Thunder', awayTeam: 'New Orleans Pelicans',
    date: 'Mañana, 20:00', status: 'scheduled',
    odds: { home: 1.45, away: 2.95 },
    prediction: { winner: 'home', prob: 0.75, ev: 0.087, betType: 'parlay' as const, amount: 28000, confidence: 0.75 },
  },
  {
    id: 'nba-4', homeTeam: 'New York Knicks', awayTeam: 'Philadelphia 76ers',
    date: 'Mañana, 19:00', status: 'scheduled',
    odds: { home: 1.85, away: 2.05 },
    prediction: { winner: 'home', prob: 0.58, ev: 0.073, betType: 'fixed' as const, amount: 20000, confidence: 0.58 },
  },
  {
    id: 'nba-5', homeTeam: 'Minnesota Timberwolves', awayTeam: 'Phoenix Suns',
    date: 'Próx. 7 días', status: 'scheduled',
    odds: { home: 1.70, away: 2.25 },
    prediction: { winner: 'away', prob: 0.48, ev: 0.080, betType: 'parlay' as const, amount: 35000, confidence: 0.48 },
  },
  {
    id: 'nba-6', homeTeam: 'LA Clippers', awayTeam: 'Dallas Mavericks',
    date: 'Próx. 7 días', status: 'scheduled',
    odds: { home: 1.95, away: 1.95 },
    prediction: { winner: 'away', prob: 0.53, ev: 0.033, betType: 'fixed' as const, amount: 0, confidence: 0.53 },
  },
]


type FilterDate = 'today' | 'tomorrow' | '7days'
type FilterType = 'all' | 'fixed' | 'parlay'

export default function NBAPage() {
  const [filterDate, setFilterDate] = useState<FilterDate>('7days')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [minEV,      setMinEV]      = useState(0)
  const [activeBet,  setActiveBet]  = useState<BetCandidate | null>(null)
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set())
  const [liveMatches, setLiveMatches] = useState<typeof DEMO_MATCHES>(DEMO_MATCHES)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || ''
        const res = await fetch(`${API_URL}/api/nba/matches`)
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
             // Map backend format to UI format
             const mapped = data.matches.map((m: any) => {
                const pred = m.prediction || {}
                const homeOdd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('home'))?.odd_value || 1.90
                const awayOdd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('away'))?.odd_value || 1.90
                
                return {
                  id: m.id,
                  homeTeam: m.home_team?.name || 'Local',
                  awayTeam: m.away_team?.name || 'Visitante',
                  date: new Date(m.match_date).toLocaleString('es-CO', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}),
                  status: m.status,
                  odds: { home: homeOdd, away: awayOdd },
                  prediction: {
                    winner: pred.predicted_outcome === 'home' || (m.home_team?.name && pred.predicted_outcome === m.home_team.name) ? 'home' : 'away',
                    prob: pred.confidence || 0.5,
                    ev: pred.expected_value || 0,
                    betType: pred.bet_type || 'fixed',
                    amount: pred.suggested_amount_cop || 0,
                    confidence: pred.confidence || 0.5
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

  const filtered = liveMatches.filter(m => {
    if (filterDate === 'today' && !m.date.startsWith('Hoy')) return false
    if (filterDate === 'tomorrow' && !m.date.startsWith('Mañana')) return false
    if (filterType === 'fixed'  && m.prediction.betType !== 'fixed')  return false
    if (filterType === 'parlay' && m.prediction.betType !== 'parlay') return false
    if (m.prediction.ev * 100 < minEV) return false
    return true
  })

  function openBetModal(match: typeof DEMO_MATCHES[0]) {
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

  function handleConfirmed(betId: string) {
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

      {/* Filters */}
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

      {/* Match grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
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
            const winner   = isHome ? match.homeTeam : match.awayTeam
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
                  <div className="text-xs text-text-muted mt-2 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {match.date}
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

      {/* Demo notice */}
      <div className="card bg-accent/5 border-accent/10 flex items-start gap-3">
        <TrendingUp className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Datos de demostración.</span>{' '}
          Los partidos reales se cargarán automáticamente desde el{' '}
          <a href="/scraping-hub" className="text-accent hover:text-accent-hover font-medium">Scraping Hub</a>{' '}
          una vez ejecutes los scrapers de estadísticas y cuotas NBA.
        </div>
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
