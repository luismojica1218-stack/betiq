'use client'

import { useState, useEffect } from 'react'
import { Globe, Clock, Filter, PlusCircle, Flame, TrendingUp, Loader2 } from 'lucide-react'
import { cn, formatCOP } from '@/lib/utils'
import ConfirmBetModal, { type BetCandidate } from '@/components/ui/ConfirmBetModal'

// ---- League config ----------------------------------------------------------
const LEAGUES = [
  { key: 'all',              name: 'Todas',           flag: '🌍', color: 'text-text' },
  { key: 'premier-league',  name: 'Premier League',  flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: 'text-purple-400' },
  { key: 'la-liga',         name: 'La Liga',          flag: '🇪🇸', color: 'text-yellow-400' },
  { key: 'bundesliga',      name: 'Bundesliga',       flag: '🇩🇪', color: 'text-red-400' },
  { key: 'serie-a',         name: 'Serie A',          flag: '🇮🇹', color: 'text-blue-400' },
  { key: 'ligue-1',         name: 'Ligue 1',          flag: '🇫🇷', color: 'text-sky-400' },
  { key: 'champions-league', name: 'Champions',       flag: '⭐', color: 'text-yellow-300' },
  { key: 'libertadores',    name: 'Libertadores',     flag: '🌎', color: 'text-green-400' },
  { key: 'copa-sudamericana', name: 'Sudamericana',  flag: '🏆', color: 'text-orange-400' },
  { key: 'world-cup-2026',  name: 'Mundial 2026',     flag: '🌐', color: 'text-accent' },
]

// ---- Types ------------------------------------------------------------------
type BestMarket = 'home_win' | 'draw' | 'away_win' | 'over_2.5' | 'under_2.5' | 'btts_yes' | 'btts_no'

interface MatchPred {
  pHome: number; pDraw: number; pAway: number
  pOver: number; pBtts: number; expGoals: number
  bestMarket: BestMarket; bestOdd: number; ev: number
  betType: 'fixed' | 'parlay'; amount: number
}

// ---- Market tabs -----------------------------------------------------------
type Market = 'moneyline' | 'over_under' | 'btts'

// ---- Demo data --------------------------------------------------------------
const DEMO_MATCHES: Array<{
  id: string; league: string; homeTeam: string; awayTeam: string; date: string
  odds: { home: number; draw: number; away: number }
  ouOdds: { over: number; under: number }
  bttsOdds: { yes: number; no: number }
  pred: MatchPred
}> = [
  {
    id: 'f1', league: 'champions-league',
    homeTeam: 'Arsenal', awayTeam: 'Real Madrid',
    date: 'Hoy, 14:00',
    odds: { home: 2.30, draw: 3.40, away: 2.85 },
    ouOdds: { over: 1.85, under: 1.95 },
    bttsOdds: { yes: 1.72, no: 2.05 },
    pred: {
      pHome: 0.42, pDraw: 0.27, pAway: 0.31,
      pOver: 0.64, pBtts: 0.61,
      expGoals: 2.9,
      bestMarket: 'over_2.5' as const, bestOdd: 1.85, ev: 0.092, betType: 'parlay' as const, amount: 30000,
    },
  },
  {
    id: 'f2', league: 'champions-league',
    homeTeam: 'Manchester City', awayTeam: 'Inter Milan',
    date: 'Hoy, 14:00',
    odds: { home: 1.60, draw: 3.80, away: 5.30 },
    ouOdds: { over: 1.80, under: 2.00 },
    bttsOdds: { yes: 1.88, no: 1.85 },
    pred: {
      pHome: 0.65, pDraw: 0.22, pAway: 0.13,
      pOver: 0.59, pBtts: 0.57,
      expGoals: 2.7,
      bestMarket: 'home_win' as const, bestOdd: 1.60, ev: 0.040, betType: 'fixed' as const, amount: 35000,
    },
  },
  {
    id: 'f3', league: 'premier-league',
    homeTeam: 'Liverpool', awayTeam: 'Chelsea',
    date: 'Mañana, 09:00',
    odds: { home: 1.80, draw: 3.60, away: 4.50 },
    ouOdds: { over: 2.00, under: 1.80 },
    bttsOdds: { yes: 1.90, no: 1.90 },
    pred: {
      pHome: 0.58, pDraw: 0.23, pAway: 0.19,
      pOver: 0.52, pBtts: 0.53,
      expGoals: 2.5,
      bestMarket: 'home_win' as const, bestOdd: 1.80, ev: 0.044, betType: 'fixed' as const, amount: 0,
    },
  },
  {
    id: 'f4', league: 'libertadores',
    homeTeam: 'Millonarios', awayTeam: 'Flamengo',
    date: 'Mañana, 19:00',
    odds: { home: 3.20, draw: 3.10, away: 2.20 },
    ouOdds: { over: 2.10, under: 1.70 },
    bttsOdds: { yes: 1.95, no: 1.80 },
    pred: {
      pHome: 0.32, pDraw: 0.28, pAway: 0.40,
      pOver: 0.45, pBtts: 0.48,
      expGoals: 2.2,
      bestMarket: 'under_2.5' as const, bestOdd: 1.70, ev: 0.085, betType: 'parlay' as const, amount: 22000,
    },
  },
  {
    id: 'f5', league: 'la-liga',
    homeTeam: 'Atletico Madrid', awayTeam: 'Girona',
    date: 'Próx. 7 días',
    odds: { home: 1.95, draw: 3.30, away: 3.80 },
    ouOdds: { over: 1.90, under: 1.90 },
    bttsOdds: { yes: 1.80, no: 1.95 },
    pred: {
      pHome: 0.54, pDraw: 0.25, pAway: 0.21,
      pOver: 0.51, pBtts: 0.62,
      expGoals: 2.5,
      bestMarket: 'btts_yes' as const, bestOdd: 1.80, ev: 0.052, betType: 'fixed' as const, amount: 15000,
    },
  },
  {
    id: 'f6', league: 'bundesliga',
    homeTeam: 'Bayer Leverkusen', awayTeam: 'Bayern München',
    date: 'Próx. 7 días',
    odds: { home: 2.40, draw: 3.50, away: 2.70 },
    ouOdds: { over: 1.65, under: 2.20 },
    bttsOdds: { yes: 1.60, no: 2.30 },
    pred: {
      pHome: 0.44, pDraw: 0.24, pAway: 0.32,
      pOver: 0.63, pBtts: 0.66,
      expGoals: 3.1,
      bestMarket: 'over_2.5' as const, bestOdd: 1.65, ev: 0.040, betType: 'parlay' as const, amount: 28000,
    },
  },
]


function MarketBadge({ market }: { market: string }) {
  const map: Record<string, string> = {
    home_win: '🏠 Local', draw: '🤝 Empate', away_win: '✈️ Visitante',
    'over_2.5': '🔥 Over 2.5', 'under_2.5': '🧊 Under 2.5',
    btts_yes: '⚡ BTTS Sí', btts_no: '🚫 BTTS No',
  }
  return <span className="badge badge-orange">{map[market] || market}</span>
}


export default function FutbolClient() {
  const [activeLeague, setActiveLeague] = useState('all')
  const [activeMarket, setActiveMarket] = useState<Market>('moneyline')
  const [minEV,        setMinEV]        = useState(0)
  const [activeBet,    setActiveBet]    = useState<BetCandidate | null>(null)
  const [confirmed,    setConfirmed]    = useState<Set<string>>(new Set())
  const [liveMatches,  setLiveMatches]  = useState<typeof DEMO_MATCHES>(DEMO_MATCHES)
  const [isLoading,    setIsLoading]    = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
        const res = await fetch(`${API_URL}/api/football/matches`)
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
             const mapped = data.matches.map((m: any) => {
                const pred = m.prediction || {}
                const homeOdd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('home'))?.odd_value || 2.10
                const awayOdd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('away'))?.odd_value || 3.30
                const drawOdd = m.odds?.find((o: any) => (o.selection || '').toLowerCase().includes('draw'))?.odd_value || 3.10
                
                return {
                  id: m.id,
                  league: m.league?.toLowerCase().replace(/\s+/g, '-') || 'all',
                  homeTeam: m.home_team?.name || 'Local',
                  awayTeam: m.away_team?.name || 'Visitante',
                  date: new Date(m.match_date).toLocaleString('es-CO', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}),
                  odds: { home: homeOdd, draw: drawOdd, away: awayOdd },
                  ouOdds: { over: 1.90, under: 1.90 },
                  bttsOdds: { yes: 1.85, no: 1.85 },
                  pred: {
                    pHome: pred.confidence || 0.45,
                    pDraw: 0.25,
                    pAway: 0.30,
                    pOver: 0.50,
                    pBtts: 0.50,
                    expGoals: 2.5,
                    bestMarket: pred.recommended_market || 'home_win',
                    bestOdd: homeOdd,
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
    if (activeLeague !== 'all' && m.league !== activeLeague) return false
    if (m.pred.ev * 100 < minEV) return false
    return true
  })

  function buildBetCandidate(match: typeof DEMO_MATCHES[0]): BetCandidate {
    const p = match.pred
    const selectionMap: Record<string, string> = {
      home_win:   `${match.homeTeam} gana (1)`,
      draw:       'Empate (X)',
      away_win:   `${match.awayTeam} gana (2)`,
      'over_2.5': 'Más de 2.5 goles',
      'under_2.5': 'Menos de 2.5 goles',
      btts_yes:   'Ambos equipos marcan',
      btts_no:    'No marcan ambos',
    }
    return {
      matchId:         match.id,
      homeTeam:        match.homeTeam,
      awayTeam:        match.awayTeam,
      sport:           'football',
      market:          p.bestMarket.includes('over') || p.bestMarket.includes('under') ? 'Over/Under' :
                       p.bestMarket.includes('btts') ? 'BTTS' : '1X2',
      selection:       selectionMap[p.bestMarket] || p.bestMarket,
      suggestedOdd:    p.bestOdd,
      suggestedAmount: p.amount,
      confidence:      Math.max(p.pHome, p.pDraw, p.pAway, p.pOver),
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
            <Globe className="w-6 h-6 text-football-green" />
            Fútbol — Predicciones Multi-mercado
          </h2>
          <p className="text-text-muted text-sm mt-1">1X2 · Over/Under · BTTS · Valores esperados con Poisson + XGBoost</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted bg-surface-2 px-3 py-2 rounded-lg">
          <Clock className="w-3.5 h-3.5" />
          Scraped hace 5 min
        </div>
      </div>

      {/* League scrollable tabs */}
      <div className="overflow-x-auto pb-1">
        <div className="flex items-center gap-1 bg-surface-2/40 rounded-xl p-1.5 w-max">
          {LEAGUES.map(lg => (
            <button
              key={lg.key}
              onClick={() => setActiveLeague(lg.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all',
                activeLeague === lg.key
                  ? 'bg-surface text-text shadow-md'
                  : 'text-text-muted hover:text-text'
              )}
            >
              <span>{lg.flag}</span>
              <span className={activeLeague === lg.key ? lg.color : ''}>{lg.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Market + EV Filter */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
          {([['moneyline', '1X2'], ['over_under', 'Over/Under'], ['btts', 'BTTS']] as [Market, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setActiveMarket(val)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                activeMarket === val ? 'bg-football-green/80 text-white' : 'text-text-muted hover:text-text'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-1 min-w-[180px]">
          <Filter className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          <span className="text-xs text-text-muted whitespace-nowrap">EV: {minEV}%</span>
          <input
            type="range" min={0} max={15} step={1} value={minEV}
            onChange={e => setMinEV(Number(e.target.value))}
            className="flex-1 accent-football-green cursor-pointer"
          />
        </div>
      </div>

      {/* Match cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Conectando con Supabase y Scrapers...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Globe className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos disponibles con los filtros actuales</p>
          </div>
        ) : filtered.map(match => {
          const p = match.pred
          const lg = LEAGUES.find(l => l.key === match.league)
          const evGood = p.ev >= 0.08
          const evOk   = p.ev >= 0.05
          const isConfirmed = confirmed.has(match.id)

          // Render probabilities by market
          const probs = activeMarket === 'moneyline'
            ? [
                { label: '1', desc: match.homeTeam, prob: p.pHome, odd: match.odds.home, best: p.bestMarket === 'home_win' },
                { label: 'X', desc: 'Empate',        prob: p.pDraw,  odd: match.odds.draw,  best: p.bestMarket === 'draw' },
                { label: '2', desc: match.awayTeam,  prob: p.pAway,  odd: match.odds.away,  best: p.bestMarket === 'away_win' },
              ]
            : activeMarket === 'over_under'
            ? [
                { label: '+2.5', desc: 'Over', prob: p.pOver,      odd: match.ouOdds.over,  best: p.bestMarket === 'over_2.5' },
                { label: '-2.5', desc: 'Under', prob: 1-p.pOver,   odd: match.ouOdds.under, best: p.bestMarket === 'under_2.5' },
              ]
            : [
                { label: 'Sí', desc: 'Ambos marcan', prob: p.pBtts,    odd: match.bttsOdds.yes, best: p.bestMarket === 'btts_yes' },
                { label: 'No', desc: 'No ambos',     prob: 1-p.pBtts, odd: match.bttsOdds.no,  best: p.bestMarket === 'btts_no' },
              ]

          return (
            <div
              key={match.id}
              className={cn(
                'card relative overflow-hidden',
                p.betType === 'parlay' && 'border-orange-500/20',
                p.betType === 'fixed' && 'border-green-500/20',
              )}
            >
              {/* Ribbon */}
              <div
                className={cn('absolute top-0 right-0 px-2.5 py-1 text-xs font-bold', p.betType === 'parlay' ? 'bg-orange-500 text-white' : 'bg-football-green text-white')}
                style={{ borderRadius: '0 0 0 8px' }}
              >
                {p.betType === 'parlay' ? '⚡ PARLAY' : '🔒 FIJA'}
              </div>

              {/* League + teams */}
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <span>{lg?.flag}</span>
                  <span className={cn('text-xs font-semibold', lg?.color)}>{lg?.name}</span>
                  <span className="text-text-muted text-xs ml-auto flex items-center gap-1">
                    <Clock className="w-3 h-3" />{match.date}
                  </span>
                </div>
                <div className="flex items-center justify-between font-bold text-text text-sm">
                  <span>{match.homeTeam}</span>
                  <span className="text-text-muted text-xs">vs</span>
                  <span>{match.awayTeam}</span>
                </div>
              </div>

              {/* Probability pills */}
              <div className={cn('grid gap-2 mb-3', probs.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
                {probs.map(pr => (
                  <div
                    key={pr.label}
                    className={cn(
                      'flex flex-col items-center p-2 rounded-lg border transition-all',
                      pr.best ? 'bg-football-green/10 border-football-green/30' : 'bg-surface-2/30 border-transparent'
                    )}
                  >
                    <span className={cn('text-base font-black', pr.best ? 'text-football-green' : 'text-text-muted')}>{pr.odd.toFixed(2)}</span>
                    <span className="text-xs font-bold text-text">{pr.label}</span>
                    <span className="text-xs text-text-muted">{(pr.prob * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>

              {/* Expected goals (O/U market context) */}
              {activeMarket === 'over_under' && (
                <div className="flex items-center gap-2 mb-3 text-xs text-text-muted">
                  <Flame className="w-3.5 h-3.5 text-orange-400" />
                  Goles esperados: <span className="text-text font-bold">{p.expGoals.toFixed(1)}</span>
                </div>
              )}

              {/* Best market + EV */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <MarketBadge market={p.bestMarket} />
                <span className={cn('badge', evGood ? 'badge-success' : evOk ? 'badge-warning' : 'badge-danger')}>
                  {evGood ? '✓' : evOk ? '~' : '!'} EV {(p.ev * 100).toFixed(1)}%
                </span>
                {p.amount > 0 && <span className="badge badge-blue">💰 {formatCOP(p.amount)}</span>}
              </div>

              {/* Action */}
              {isConfirmed ? (
                <div className="w-full py-2 rounded-lg bg-success/10 border border-success/20 text-success text-sm font-semibold text-center">
                  ✓ Registrada
                </div>
              ) : (
                <button
                  onClick={() => setActiveBet(buildBetCandidate(match))}
                  disabled={p.ev < 0.03}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all',
                    p.ev >= 0.03 ? 'btn-primary' : 'bg-surface-2 text-text-muted cursor-not-allowed'
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

      {/* Info note */}
      <div className="card bg-football-green/5 border-football-green/10 flex items-start gap-3">
        <TrendingUp className="w-5 h-5 text-football-green flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Datos de demostración.</span>{' '}
          Los partidos reales se cargan desde el{' '}
          <a href="/scraping-hub" className="text-football-green hover:underline font-medium">Scraping Hub</a>
          {' '}ejecutando los scrapers de fbref.com y Betplay/Rushbet.
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
