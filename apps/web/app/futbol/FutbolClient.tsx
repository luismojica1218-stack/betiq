'use client'

import { useState, useEffect } from 'react'
import { Globe, Clock, BarChart2, Target, TrendingUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---- League config ----------------------------------------------------------
const LEAGUES = [
  { key: 'all',               name: 'Todas',          flag: '🌍', color: 'text-text' },
  { key: 'premier-league',   name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: 'text-purple-400' },
  { key: 'la-liga',          name: 'La Liga',         flag: '🇪🇸', color: 'text-yellow-400' },
  { key: 'bundesliga',       name: 'Bundesliga',      flag: '🇩🇪', color: 'text-red-400' },
  { key: 'serie-a',          name: 'Serie A',         flag: '🇮🇹', color: 'text-blue-400' },
  { key: 'ligue-1',          name: 'Ligue 1',         flag: '🇫🇷', color: 'text-sky-400' },
  { key: 'champions-league', name: 'Champions',       flag: '⭐', color: 'text-yellow-300' },
  { key: 'libertadores',     name: 'Libertadores',    flag: '🌎', color: 'text-green-400' },
  { key: 'copa-sudamericana',name: 'Sudamericana',   flag: '🏆', color: 'text-orange-400' },
  { key: 'liga-colombiana',  name: 'Liga BetPlay',   flag: '🇨🇴', color: 'text-yellow-500' },
  { key: 'world-cup-2026',   name: 'Mundial 2026',    flag: '🌐', color: 'text-accent' },
]

// ---- Types ------------------------------------------------------------------
type AnalysisView = 'resultado' | 'goles' | 'corners' | 'noticias'

interface GoalsRange {
  p_0_1: number
  p_2_3: number
  p_4_plus: number
}

interface FootballPrediction {
  p_home: number
  p_draw: number
  p_away: number
  predicted_winner: 'home' | 'draw' | 'away'
  winner_confidence: 'alta' | 'media' | 'baja'
  p_over: number
  p_btts: number
  exp_goals: number
  xg_home: number
  xg_away: number
  most_likely_score: string
  goals_range: GoalsRange
  corners_estimate: number
  home_scores_first_pct: number
  home_news?: any
  away_news?: any
  weather?: any
  h2h_history?: any
}

interface MappedMatch {
  id: string
  league: string
  homeTeam: string
  awayTeam: string
  date: string
  pred: FootballPrediction
}

// ---- Helpers ----------------------------------------------------------------
function leagueSlug(raw: string): string {
  const s = (raw || '').toLowerCase().replace(/\s+/g, '-')
  if (s.includes('libertadores'))  return 'libertadores'
  if (s.includes('sudamericana'))  return 'copa-sudamericana'
  if (s.includes('mundial') || s.includes('world-cup') || s.includes('fifa-2026')) return 'world-cup-2026'
  if (s.includes('champions'))     return 'champions-league'
  if (s.includes('premier'))       return 'premier-league'
  if (s.includes('bundesliga'))    return 'bundesliga'
  if (s.includes('serie') && s.includes('a')) return 'serie-a'
  if (s.includes('ligue'))         return 'ligue-1'
  if (s.includes('betplay') || s.includes('colombian') || s.includes('col.1')) return 'liga-colombiana'
  if (s.includes('liga') || s.includes('laliga')) return 'la-liga'
  return s || 'all'
}

function ConfidenceBadge({ level }: { level: 'alta' | 'media' | 'baja' }) {
  const map = {
    alta:  { cls: 'badge badge-success', label: 'Confianza Alta' },
    media: { cls: 'badge badge-warning', label: 'Confianza Media' },
    baja:  { cls: 'badge badge-danger',  label: 'Confianza Baja' },
  }
  const { cls, label } = map[level]
  return <span className={cls}>{label}</span>
}

function ProbBar({ label, prob, highlight, color = 'bg-football-green' }: {
  label: string; prob: number; highlight: boolean; color?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 p-2.5 rounded-lg border', highlight ? 'bg-football-green/10 border-football-green/30' : 'bg-surface-2/30 border-transparent')}>
      <div className="flex justify-between items-center text-xs">
        <span className={cn('font-semibold', highlight ? 'text-football-green' : 'text-text-muted')}>{label}</span>
        <span className={cn('font-bold', highlight ? 'text-football-green' : 'text-text')}>{(prob * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-700', highlight ? color : 'bg-surface-2')}
          style={{ width: `${prob * 100}%`, backgroundColor: highlight ? undefined : 'rgb(var(--color-text-muted) / 0.3)' }}
        />
      </div>
    </div>
  )
}

// ---- Main component ---------------------------------------------------------
export default function FutbolClient() {
  const [activeLeague,     setActiveLeague]     = useState('all')
  const [activeView,       setActiveView]       = useState<AnalysisView>('resultado')
  const [activeConfidence, setActiveConfidence] = useState<'all' | 'alta' | 'media' | 'baja'>('all')
  const [liveMatches,      setLiveMatches]      = useState<MappedMatch[]>([])
  const [isLoading,        setIsLoading]        = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const res = await fetch('/api/football/matches')
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
            const mapped: MappedMatch[] = data.matches.map((m: any) => {
              const pred = m.prediction || {}
              return {
                id: m.id,
                league: leagueSlug(m.league || ''),
                homeTeam: m.home_team?.name || 'Local',
                awayTeam: m.away_team?.name || 'Visitante',
                date: new Date(m.match_date).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
                pred: {
                  p_home:               pred.p_home ?? 0.40,
                  p_draw:               pred.p_draw ?? 0.25,
                  p_away:               pred.p_away ?? 0.35,
                  predicted_winner:     pred.predicted_winner ?? 'home',
                  winner_confidence:    pred.winner_confidence ?? 'baja',
                  p_over:               pred.p_over ?? 0.50,
                  p_btts:               pred.p_btts ?? 0.50,
                  exp_goals:            pred.exp_goals ?? 2.5,
                  xg_home:              pred.xg_home ?? 1.2,
                  xg_away:              pred.xg_away ?? 1.1,
                  most_likely_score:    pred.most_likely_score ?? '1-0',
                  goals_range:          pred.goals_range ?? { p_0_1: 0.25, p_2_3: 0.50, p_4_plus: 0.25 },
                  corners_estimate:     pred.corners_estimate ?? 9.5,
                  home_scores_first_pct: pred.home_scores_first_pct ?? 0.55,
                  home_news:            pred.home_news,
                  away_news:            pred.away_news,
                  weather:              pred.weather,
                  h2h_history:          pred.h2h_history,
                },
              }
            })
            setLiveMatches(mapped)
          }
        }
      } catch (err) {
        console.error('Football fetch error', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchMatches()
  }, [])

  const filtered = liveMatches.filter(m => {
    if (activeLeague !== 'all' && m.league !== activeLeague) return false
    if (activeConfidence !== 'all' && m.pred.winner_confidence !== activeConfidence) return false
    return true
  })

  const winnerLabel = (w: 'home' | 'draw' | 'away', homeTeam: string, awayTeam: string) => {
    if (w === 'home') return `Local (${homeTeam})`
    if (w === 'away') return `Visitante (${awayTeam})`
    return 'Empate'
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Globe className="w-6 h-6 text-football-green" />
            Fútbol — Análisis Estadístico
          </h2>
          <p className="text-text-muted text-sm mt-1">
            Probabilidades de resultado · xG · Goles esperados · Córners — Modelos Poisson + XGBoost
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted bg-surface-2 px-3 py-2 rounded-lg">
          <Clock className="w-3.5 h-3.5" />
          Actualizado hace 5 min
        </div>
      </div>

      {/* League tabs */}
      <div className="overflow-x-auto pb-1">
        <div className="flex items-center gap-1 bg-surface-2/40 rounded-xl p-1.5 w-max">
          {LEAGUES.map(lg => (
            <button
              key={lg.key}
              onClick={() => setActiveLeague(lg.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all',
                activeLeague === lg.key ? 'bg-surface text-text shadow-md' : 'text-text-muted hover:text-text'
              )}
            >
              <span>{lg.flag}</span>
              <span className={activeLeague === lg.key ? lg.color : ''}>{lg.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Confidence filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-muted font-medium">Confianza:</span>
        {([
          ['all',   'Todas',  'bg-surface text-text'],
          ['alta',  'Alta',   'bg-success/15 text-success'],
          ['media', 'Media',  'bg-warning/15 text-warning'],
          ['baja',  'Baja',   'bg-surface-2 text-text-muted'],
        ] as const).map(([val, label, activeClass]) => (
          <button
            key={val}
            onClick={() => setActiveConfidence(val)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all',
              activeConfidence === val
                ? activeClass + ' border-transparent shadow-sm'
                : 'bg-surface-2/40 text-text-muted border-transparent hover:text-text'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Analysis view selector */}
      <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1 w-max">
        {([
          ['resultado', 'Resultado', BarChart2],
          ['goles',     'Goles',     Target],
          ['corners',   'Córners',   TrendingUp],
          ['noticias',  'Noticias',  Target],
        ] as [AnalysisView, string, React.ElementType][]).map(([val, label, Icon]) => (
          <button
            key={val}
            onClick={() => setActiveView(val)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
              activeView === val ? 'bg-football-green/80 text-white' : 'text-text-muted hover:text-text'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Match cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Cargando predicciones...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Globe className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos disponibles con los filtros actuales</p>
          </div>
        ) : filtered.map(match => {
          const p  = match.pred
          const lg = LEAGUES.find(l => l.key === match.league)

          return (
            <div key={match.id} className="card space-y-4">
              {/* Card header */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span>{lg?.flag}</span>
                    <span className={cn('text-xs font-semibold', lg?.color)}>{lg?.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.weather?.condition && (
                      <span className="text-[10px] text-text-muted bg-surface-2 px-1.5 py-0.5 rounded flex items-center gap-1">
                        {p.weather.rain_mm > 0 ? '🌧️' : p.weather.wind_kmh > 20 ? '💨' : '☀️'}
                        {p.weather.temp_c}°C
                      </span>
                    )}
                    <span className="text-text-muted text-xs flex items-center gap-1">
                      <Clock className="w-3 h-3" />{match.date}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between font-bold text-text">
                  <span className="text-sm">{match.homeTeam}</span>
                  <span className="text-text-muted text-xs px-2">vs</span>
                  <span className="text-sm">{match.awayTeam}</span>
                </div>
              </div>

              {/* Confidence badge */}
              <div className="flex items-center gap-2">
                <ConfidenceBadge level={p.winner_confidence} />
              </div>

              {/* ── Resultado view ── */}
              {activeView === 'resultado' && (
                <div className="space-y-2">
                  <ProbBar
                    label={`Local — ${match.homeTeam}`}
                    prob={p.p_home}
                    highlight={p.predicted_winner === 'home'}
                  />
                  <ProbBar
                    label="Empate"
                    prob={p.p_draw}
                    highlight={p.predicted_winner === 'draw'}
                  />
                  <ProbBar
                    label={`Visitante — ${match.awayTeam}`}
                    prob={p.p_away}
                    highlight={p.predicted_winner === 'away'}
                  />
                  <p className="text-xs text-text-muted pt-1">
                    Resultado más probable:{' '}
                    <span className="text-football-green font-semibold">
                      {winnerLabel(p.predicted_winner, match.homeTeam, match.awayTeam)}
                    </span>
                  </p>
                </div>
              )}

              {/* ── Goles view ── */}
              {activeView === 'goles' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Goles esperados</span>
                    <span className="text-lg font-black text-football-green">{p.exp_goals.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Marcador más probable</span>
                    <span className="text-sm font-bold text-text">{p.most_likely_score}</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Distribución de goles</p>
                    <ProbBar label="0–1 goles"  prob={p.goals_range.p_0_1}   highlight={false} />
                    <ProbBar label="2–3 goles"  prob={p.goals_range.p_2_3}   highlight={p.goals_range.p_2_3 >= Math.max(p.goals_range.p_0_1, p.goals_range.p_4_plus)} />
                    <ProbBar label="4+ goles"   prob={p.goals_range.p_4_plus} highlight={false} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-surface-2/60 rounded-lg px-3 py-2 text-center">
                      <div className="text-xs text-text-muted">Ambos marcan</div>
                      <div className="text-sm font-bold text-text">{(p.p_btts * 100).toFixed(0)}%</div>
                    </div>
                    <div className="bg-surface-2/60 rounded-lg px-3 py-2 text-center">
                      <div className="text-xs text-text-muted">Más de 2.5</div>
                      <div className="text-sm font-bold text-text">{(p.p_over * 100).toFixed(0)}%</div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Corners view ── */}
              {activeView === 'corners' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Córners estimados</span>
                    <span className="text-lg font-black text-football-green">{p.corners_estimate.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Marca primero (Local)</span>
                    <span className="text-sm font-bold text-text">{(p.home_scores_first_pct * 100).toFixed(0)}%</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">xG por equipo</p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted w-20 truncate">{match.homeTeam}</span>
                      <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-football-green rounded-full transition-all duration-700"
                          style={{ width: `${(p.xg_home / (p.xg_home + p.xg_away)) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold text-text w-8 text-right">{p.xg_home.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted w-20 truncate">{match.awayTeam}</span>
                      <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-400 rounded-full transition-all duration-700"
                          style={{ width: `${(p.xg_away / (p.xg_home + p.xg_away)) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold text-text w-8 text-right">{p.xg_away.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Noticias view ── */}
              {activeView === 'noticias' && (
                <div className="space-y-4">
                  {/* Home News */}
                  <div className="bg-surface-2/40 rounded-lg p-3 space-y-2 border border-surface-2">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-xs text-text">{match.homeTeam}</span>
                      <span className={cn('text-xs px-2 py-0.5 rounded font-semibold', 
                        p.home_news?.sentiment_label === 'Positivo' ? 'bg-green-500/20 text-green-400' : 
                        p.home_news?.sentiment_label === 'Negativo' ? 'bg-red-500/20 text-red-400' : 'bg-surface-2 text-text-muted')}>
                        {p.home_news?.sentiment_label || 'Neutral'}
                      </span>
                    </div>
                    {p.home_news?.headlines?.length > 0 ? (
                      <ul className="text-xs text-text-muted list-disc list-inside space-y-1">
                        {p.home_news.headlines.map((h: string, i: number) => <li key={i} className="truncate">{h}</li>)}
                      </ul>
                    ) : <p className="text-xs text-text-muted italic">Sin noticias recientes</p>}
                  </div>
                  {/* Away News */}
                  <div className="bg-surface-2/40 rounded-lg p-3 space-y-2 border border-surface-2">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-xs text-text">{match.awayTeam}</span>
                      <span className={cn('text-xs px-2 py-0.5 rounded font-semibold', 
                        p.away_news?.sentiment_label === 'Positivo' ? 'bg-green-500/20 text-green-400' : 
                        p.away_news?.sentiment_label === 'Negativo' ? 'bg-red-500/20 text-red-400' : 'bg-surface-2 text-text-muted')}>
                        {p.away_news?.sentiment_label || 'Neutral'}
                      </span>
                    </div>
                    {p.away_news?.headlines?.length > 0 ? (
                      <ul className="text-xs text-text-muted list-disc list-inside space-y-1">
                        {p.away_news.headlines.map((h: string, i: number) => <li key={i} className="truncate">{h}</li>)}
                      </ul>
                    ) : <p className="text-xs text-text-muted italic">Sin noticias recientes</p>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Info note */}
      <div className="card bg-football-green/5 border-football-green/10 flex items-start gap-3">
        <TrendingUp className="w-5 h-5 text-football-green flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Modelos estadísticos.</span>{' '}
          Las predicciones usan modelos Poisson para goles y xG, combinados con XGBoost entrenado con datos históricos
          de fbref.com. Las probabilidades reflejan el análisis del modelo, no garantías de resultado.
        </div>
      </div>
    </div>
  )
}
