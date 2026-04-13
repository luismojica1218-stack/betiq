'use client'

import { useState, useEffect } from 'react'
import { Dumbbell, Clock, Filter, PlusCircle, Trophy, Activity, Target, Loader2 } from 'lucide-react'
import { cn, formatCOP } from '@/lib/utils'
import ConfirmBetModal, { type BetCandidate } from '@/components/ui/ConfirmBetModal'

// ---- Types ------------------------------------------------------------------
type BestMarket = 'p1_win' | 'p2_win' | 'handicap_p1' | 'handicap_p2' | 'over_games' | 'under_games' | 'first_set_p1' | 'first_set_p2'

interface MatchPred {
  p1WinProb: number; p2WinProb: number
  pHandicapP1: number; pHandicapP2: number
  pOverGames: number; pUnderGames: number; expTotalGames: number; ouLine: number
  pFirstSetP1: number; pFirstSetP2: number
  eloP1: number; eloP2: number
  bestMarket: BestMarket; bestOdd: number; ev: number
  betType: 'fixed' | 'parlay'; amount: number
}

type MarketTab = 'moneyline' | 'handicap' | 'over_under' | 'first_set'

// ---- Config -----------------------------------------------------------------
const TOURS = [
  { key: 'all', label: 'Todos', color: 'text-text' },
  { key: 'ATP', label: 'ATP Tour', color: 'text-blue-400' },
  { key: 'WTA', label: 'WTA Tour', color: 'text-pink-400' },
]

const SURFACES = [
  { key: 'all',    label: 'Todas', bgColor: 'bg-surface-2' },
  { key: 'hard',   label: 'Hard',  bgColor: 'bg-blue-500/20 text-blue-400' },
  { key: 'clay',   label: 'Clay',  bgColor: 'bg-orange-500/20 text-orange-400' },
  { key: 'grass',  label: 'Grass', bgColor: 'bg-green-500/20 text-green-400' },
  { key: 'indoor', label: 'Indoor',bgColor: 'bg-purple-500/20 text-purple-400' },
]

// ---- Demo data --------------------------------------------------------------
const DEMO_MATCHES: Array<{
  id: string; tour: string; tournament: string; surface: string; round: string; date: string
  player1: string; player2: string
  odds: { p1: number; p2: number }
  hnOdds: { p1: number; p2: number }
  ouOdds: { over: number; under: number }
  fsOdds: { p1: number; p2: number }
  pred: MatchPred
}> = [
  {
    id: 't1', tour: 'ATP', tournament: 'Monte Carlo Masters', surface: 'clay', round: 'SF', date: 'Mañana, 07:30',
    player1: 'Jannik Sinner', player2: 'Carlos Alcaraz',
    odds: { p1: 2.10, p2: 1.75 },
    hnOdds: { p1: 1.50, p2: 2.50 },
    ouOdds: { over: 1.90, under: 1.90 },
    fsOdds: { p1: 2.00, p2: 1.80 },
    pred: {
      p1WinProb: 0.46, p2WinProb: 0.54, eloP1: 2280, eloP2: 2350,
      pHandicapP1: 0.65, pHandicapP2: 0.35,
      pOverGames: 0.62, pUnderGames: 0.38, expTotalGames: 22.5, ouLine: 22.5,
      pFirstSetP1: 0.48, pFirstSetP2: 0.52,
      bestMarket: 'over_games', bestOdd: 1.90, ev: 0.178, betType: 'fixed', amount: 45000,
    },
  },
  {
    id: 't2', tour: 'ATP', tournament: 'Barcelona Open', surface: 'clay', round: 'R16', date: 'Hoy, 09:00',
    player1: 'Rafael Nadal', player2: 'Stefanos Tsitsipas',
    odds: { p1: 2.25, p2: 1.65 },
    hnOdds: { p1: 1.65, p2: 2.20 },
    ouOdds: { over: 1.85, under: 1.95 },
    fsOdds: { p1: 2.15, p2: 1.70 },
    pred: {
      p1WinProb: 0.48, p2WinProb: 0.52, eloP1: 2150, eloP2: 2200,
      pHandicapP1: 0.64, pHandicapP2: 0.36,
      pOverGames: 0.65, pUnderGames: 0.35, expTotalGames: 23.5, ouLine: 22.5,
      pFirstSetP1: 0.49, pFirstSetP2: 0.51,
      bestMarket: 'handicap_p1', bestOdd: 1.65, ev: 0.056, betType: 'parlay', amount: 30000,
    },
  },
  {
    id: 't3', tour: 'WTA', tournament: 'Madrid Open', surface: 'clay', round: 'QF', date: 'Próx. semana',
    player1: 'Iga Swiatek', player2: 'Aryna Sabalenka',
    odds: { p1: 1.40, p2: 3.00 },
    hnOdds: { p1: 1.85, p2: 1.95 },
    ouOdds: { over: 1.85, under: 1.95 },
    fsOdds: { p1: 1.50, p2: 2.60 },
    pred: {
      p1WinProb: 0.73, p2WinProb: 0.27, eloP1: 2400, eloP2: 2250,
      pHandicapP1: 0.52, pHandicapP2: 0.48,
      pOverGames: 0.45, pUnderGames: 0.55, expTotalGames: 19.5, ouLine: 20.5,
      pFirstSetP1: 0.68, pFirstSetP2: 0.32,
      bestMarket: 'p1_win', bestOdd: 1.40, ev: 0.022, betType: 'parlay', amount: 0,
    },
  },
  {
    id: 't4', tour: 'ATP', tournament: 'BMW Open', surface: 'clay', round: 'R16', date: 'Mañana, 11:00',
    player1: 'Alexander Zverev', player2: 'Holger Rune',
    odds: { p1: 1.65, p2: 2.25 },
    hnOdds: { p1: 2.40, p2: 1.55 },
    ouOdds: { over: 1.90, under: 1.90 },
    fsOdds: { p1: 1.70, p2: 2.15 },
    pred: {
      p1WinProb: 0.64, p2WinProb: 0.36, eloP1: 2200, eloP2: 2100,
      pHandicapP1: 0.45, pHandicapP2: 0.55,
      pOverGames: 0.52, pUnderGames: 0.48, expTotalGames: 23.5, ouLine: 22.5,
      pFirstSetP1: 0.60, pFirstSetP2: 0.40,
      bestMarket: 'p1_win', bestOdd: 1.65, ev: 0.056, betType: 'parlay', amount: 25000,
    },
  },
]

function MarketBadge({ market }: { market: string }) {
  const map: Record<string, string> = {
    p1_win: '🏆 P1 Gana',
    p2_win: '🏆 P2 Gana',
    handicap_p1: '⚖️ P1 -1.5 Sets',
    handicap_p2: '⚖️ P2 -1.5 Sets',
    over_games: '🔥 Over Goles',
    under_games: '🧊 Under Goles',
    first_set_p1: '🥇 1er Set P1',
    first_set_p2: '🥇 1er Set P2',
  }
  return <span className="badge badge-orange">{map[market] || market}</span>
}

export default function TenisClient() {
  const [activeTour,    setActiveTour]    = useState('all')
  const [activeSurface, setActiveSurface] = useState('all')
  const [activeMarket,  setActiveMarket]  = useState<MarketTab>('moneyline')
  const [minEV,         setMinEV]         = useState(0)
  const [activeBet,     setActiveBet]     = useState<BetCandidate | null>(null)
  const [confirmed,     setConfirmed]     = useState<Set<string>>(new Set())
  const [liveMatches,   setLiveMatches]   = useState<typeof DEMO_MATCHES>(DEMO_MATCHES)
  const [isLoading,     setIsLoading]     = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || ''
        const res = await fetch(`${API_URL}/api/tennis/matches`)
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
             const mapped = data.matches.map((m: any) => {
                const pred = m.prediction || {}
                const p1Odd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('home'))?.odd_value || 1.85
                const p2Odd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('away'))?.odd_value || 1.95
                
                return {
                  id: m.id,
                  tour: m.league || 'ATP',
                  tournament: m.round || 'Tournament',
                  surface: 'hard', // Fallback
                  round: m.round || 'Round',
                  date: new Date(m.match_date).toLocaleString('es-CO', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}),
                  player1: m.home_team?.name || 'Player 1',
                  player2: m.away_team?.name || 'Player 2',
                  odds: { p1: p1Odd, p2: p2Odd },
                  hnOdds: { p1: 1.85, p2: 1.85 },
                  ouOdds: { over: 1.90, under: 1.90 },
                  fsOdds: { p1: 1.85, p2: 1.85 },
                  pred: {
                    p1WinProb: pred.confidence || 0.5,
                    p2WinProb: 1 - (pred.confidence || 0.5),
                    pHandicapP1: 0.5, pHandicapP2: 0.5,
                    pOverGames: 0.5, pUnderGames: 0.5, expTotalGames: 22.5, ouLine: 22.5,
                    pFirstSetP1: 0.5, pFirstSetP2: 0.5,
                    eloP1: 2000, eloP2: 2000,
                    bestMarket: pred.recommended_market || 'p1_win',
                    bestOdd: Math.max(p1Odd, p2Odd),
                    ev: pred.expected_value || 0,
                    betType: pred.bet_type || 'fixed',
                    amount: pred.suggested_amount_cop || 0,
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
    if (activeTour !== 'all' && m.tour !== activeTour) return false
    if (activeSurface !== 'all' && m.surface !== activeSurface) return false
    if (m.pred.ev * 100 < minEV) return false
    return true
  })

  function buildBetCandidate(match: typeof DEMO_MATCHES[0]): BetCandidate {
    const p = match.pred
    const selectionMap: Record<string, string> = {
      p1_win: `${match.player1} gana`,
      p2_win: `${match.player2} gana`,
      handicap_p1: `${match.player1} -1.5 Sets`,
      handicap_p2: `${match.player2} -1.5 Sets`,
      over_games: `Más de ${p.ouLine} juegos`,
      under_games: `Menos de ${p.ouLine} juegos`,
      first_set_p1: `${match.player1} gana 1er Set`,
      first_set_p2: `${match.player2} gana 1er Set`,
    }
    return {
      matchId:         match.id,
      homeTeam:        match.player1,
      awayTeam:        match.player2,
      sport:           'tennis',
      market:          p.bestMarket.includes('handicap') ? 'Set Handicap' :
                       p.bestMarket.includes('over') || p.bestMarket.includes('under') ? 'Total Games' :
                       p.bestMarket.includes('first_set') ? '1st Set Winner' : 'Moneyline',
      selection:       selectionMap[p.bestMarket] || p.bestMarket,
      suggestedOdd:    p.bestOdd,
      suggestedAmount: p.amount,
      confidence:      Math.max(p.p1WinProb, p.p2WinProb, p.pOverGames, p.pHandicapP1, p.pFirstSetP1),
      expectedValue:   p.ev,
      betType:         p.betType,
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Dumbbell className="w-6 h-6 text-tennis-orange" />
            Tenis — Predicciones ajustadas por Superficie
          </h2>
          <p className="text-text-muted text-sm mt-1">ATP/WTA · Modelos Elo dinámicos + XGBoost · 4 Mercados</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted bg-surface-2 px-3 py-2 rounded-lg">
          <Clock className="w-3.5 h-3.5" />
          Scraped hace 12 min
        </div>
      </div>

      {/* Filters (Tour + Surface) */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-1 bg-surface-2/40 rounded-xl p-1.5 w-max">
          {TOURS.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTour(t.key)}
              className={cn(
                'px-4 py-1.5 rounded-lg text-sm font-semibold transition-all',
                activeTour === t.key ? 'bg-surface text-text shadow-md' : 'text-text-muted hover:text-text'
              )}
            >
              <span className={activeTour === t.key ? t.color : ''}>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {SURFACES.map(s => (
            <button
              key={s.key}
              onClick={() => setActiveSurface(s.key)}
              className={cn(
                'px-3 py-1 text-xs font-semibold rounded-md transition-all',
                activeSurface === s.key ? s.bgColor : 'bg-surface-2 text-text-muted hover:text-text'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Market + EV Threshold */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
          {([['moneyline', 'Match Winner'], ['handicap', 'Set Handicap'], ['over_under', 'Total Games'], ['first_set', '1st Set']] as [MarketTab, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setActiveMarket(val)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                activeMarket === val ? 'bg-tennis-orange/80 text-white' : 'text-text-muted hover:text-text'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-1 min-w-[180px]">
          <Filter className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          <span className="text-xs text-text-muted whitespace-nowrap">EV Mín: {minEV}%</span>
          <input
            type="range" min={0} max={15} step={1} value={minEV}
            onChange={e => setMinEV(Number(e.target.value))}
            className="flex-1 accent-tennis-orange cursor-pointer"
          />
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Conectando con Supabase y Scrapers...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Dumbbell className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos disponibles con los filtros actuales</p>
          </div>
        ) : filtered.map(match => {
          const p = match.pred
          const isConfirmed = confirmed.has(match.id)
          const evGood = p.ev >= 0.08
          const evOk   = p.ev >= 0.05
          const surfConf = SURFACES.find(s => s.key === match.surface)

          // Data to show based on market tab
          const probs = activeMarket === 'moneyline' ? [
            { label: 'P1 Win', desc: match.player1, prob: p.p1WinProb, odd: match.odds.p1, best: p.bestMarket === 'p1_win' },
            { label: 'P2 Win', desc: match.player2, prob: p.p2WinProb, odd: match.odds.p2, best: p.bestMarket === 'p2_win' }
          ] : activeMarket === 'handicap' ? [
            { label: 'P1 -1.5', desc: match.player1, prob: p.pHandicapP1, odd: match.hnOdds.p1, best: p.bestMarket === 'handicap_p1' },
            { label: 'P2 -1.5', desc: match.player2, prob: p.pHandicapP2, odd: match.hnOdds.p2, best: p.bestMarket === 'handicap_p2' }
          ] : activeMarket === 'over_under' ? [
            { label: `+${p.ouLine}`, desc: 'Over Games', prob: p.pOverGames, odd: match.ouOdds.over, best: p.bestMarket === 'over_games' },
            { label: `-${p.ouLine}`, desc: 'Under Games', prob: p.pUnderGames, odd: match.ouOdds.under, best: p.bestMarket === 'under_games' }
          ] : [
            { label: 'P1 1er Set', desc: match.player1, prob: p.pFirstSetP1, odd: match.fsOdds.p1, best: p.bestMarket === 'first_set_p1' },
            { label: 'P2 1er Set', desc: match.player2, prob: p.pFirstSetP2, odd: match.fsOdds.p2, best: p.bestMarket === 'first_set_p2' }
          ]

          return (
            <div key={match.id} className={cn('card relative overflow-hidden', p.betType === 'parlay' && 'border-orange-500/20', p.betType === 'fixed' && 'border-green-500/20')}>
              {/* Ribbon */}
              <div className={cn('absolute top-0 right-0 px-2.5 py-1 text-xs font-bold', p.betType === 'parlay' ? 'bg-orange-500 text-white' : 'bg-tennis-orange text-white')} style={{ borderRadius: '0 0 0 8px' }}>
                {p.betType === 'parlay' ? '⚡ PARLAY' : '🔒 FIJA'}
              </div>

              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn('text-xs font-bold capitalize', surfConf?.bgColor, 'px-2 py-0.5 rounded')}>{match.surface}</span>
                    <span className="text-xs text-text-muted font-medium">{match.tour} · {match.tournament}</span>
                  </div>
                  <div className="text-xs text-text-muted flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {match.date} · {match.round}
                  </div>
                </div>
              </div>

              {/* Players vs block */}
              <div className="flex items-center justify-between mb-4 bg-surface-2/30 p-3 rounded-lg border border-surface-2">
                <div className="text-center w-full">
                  <div className="font-bold text-sm text-text">{match.player1}</div>
                  <div className="text-xs text-text-muted flex items-center justify-center gap-1 mt-0.5">
                    <Activity className="w-3 h-3 text-tennis-orange" /> Elo: {p.eloP1}
                  </div>
                </div>
                <div className="px-3 text-xs text-text-muted font-bold">VS</div>
                <div className="text-center w-full">
                  <div className="font-bold text-sm text-text">{match.player2}</div>
                  <div className="text-xs text-text-muted flex items-center justify-center gap-1 mt-0.5">
                    <Activity className="w-3 h-3 text-tennis-orange" /> Elo: {p.eloP2}
                  </div>
                </div>
              </div>

              {/* Expected Total Games context if viewing O/U */}
              {activeMarket === 'over_under' && (
                <div className="flex items-center justify-center gap-2 mb-3 text-xs text-text-muted bg-surface-2/50 py-1.5 rounded">
                  <Target className="w-3.5 h-3.5 text-tennis-orange" />
                  Juegos esperados según modelo Elo: <span className="text-text font-bold">{p.expTotalGames.toFixed(1)}</span>
                </div>
              )}

              {/* Probabilities */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                {probs.map(pr => (
                  <div key={pr.label} className={cn('flex flex-col items-center p-2 rounded-lg border transition-all', pr.best ? 'bg-tennis-orange/10 border-tennis-orange/30' : 'bg-surface-2/30 border-transparent')}>
                    <span className={cn('text-lg font-black', pr.best ? 'text-tennis-orange' : 'text-text-muted')}>{pr.odd.toFixed(2)}</span>
                    <span className="text-sm font-bold text-text truncate w-full text-center">{pr.label}</span>
                    <span className="text-xs text-text-muted">{(pr.prob * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>

              {/* Conclusion & Button */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <MarketBadge market={p.bestMarket} />
                <span className={cn('badge', evGood ? 'badge-success' : evOk ? 'badge-warning' : 'badge-danger')}>
                  {evGood ? '✓' : evOk ? '~' : '!'} EV {(p.ev * 100).toFixed(1)}%
                </span>
                {p.amount > 0 && <span className="badge badge-blue">💰 {formatCOP(p.amount)}</span>}
              </div>

              {isConfirmed ? (
                <div className="w-full py-2 rounded-lg bg-success/10 border border-success/20 text-success text-sm font-semibold text-center">✓ Registrada</div>
              ) : (
                <button
                  onClick={() => setActiveBet(buildBetCandidate(match))}
                  disabled={p.ev < 0.03}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all',
                    p.ev >= 0.03 ? 'bg-tennis-orange hover:bg-orange-600 text-white shadow-lg' : 'bg-surface-2 text-text-muted cursor-not-allowed'
                  )}
                >
                  <PlusCircle className="w-4 h-4" />
                  {p.ev >= 0.03 ? 'Agregar apuesta' : 'EV insuficiente'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="card bg-tennis-orange/5 border-tennis-orange/10 flex items-start gap-3 mt-4">
        <Trophy className="w-5 h-5 text-tennis-orange flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Ventaja del Modelo:</span>{' '}
          Los rankings ATP/WTA tradicionales no reflejan el nivel actual en cada superficie.
          Nuestro modelo ajusta el puntaje Elo de cada jugador basándose en su rendimiento histórico en la superficie específica del torneo, combinándolo con Machine Learning.
        </div>
      </div>

      <ConfirmBetModal
        bet={activeBet}
        onClose={() => setActiveBet(null)}
        onConfirm={id => { setConfirmed(prev => new Set(Array.from(prev).concat(activeBet?.matchId || ''))); setActiveBet(null) }}
      />
    </div>
  )
}
