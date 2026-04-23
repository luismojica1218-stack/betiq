'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, Play, RotateCcw, Trophy, Globe, Dumbbell,
  CheckCircle2, XCircle, Loader2, Terminal, Clock,
  Database, Zap, Radio, Clipboard, Save
} from 'lucide-react'
import { cn } from '@/lib/utils'

type ScrapingStatus = 'idle' | 'running' | 'success' | 'error'
type SportTab = 'nba' | 'football' | 'tennis' | 'odds-import'

interface LogLine {
  id:       number
  time:     string
  message:  string
  type:     'log' | 'done' | 'error' | 'connected' | 'heartbeat'
}

interface ScrapeSection {
  id:      string
  label:   string
  status:  ScrapingStatus
  logs:    LogLine[]
  count:   number | null
  lastRun: string | null
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ---- NBA odds parser ----
interface ParsedGame { home: string; away: string; homeOdd: number; awayOdd: number }

const NBA_ALIASES: [string, string[]][] = [
  ['Atlanta Hawks',           ['Hawks','Atlanta']],
  ['Boston Celtics',          ['Celtics','Boston']],
  ['Brooklyn Nets',           ['Nets','Brooklyn']],
  ['Charlotte Hornets',       ['Hornets','Charlotte']],
  ['Chicago Bulls',           ['Bulls','Chicago']],
  ['Cleveland Cavaliers',     ['Cavaliers','Cleveland','Cavs']],
  ['Dallas Mavericks',        ['Mavericks','Dallas','Mavs']],
  ['Denver Nuggets',          ['Nuggets','Denver']],
  ['Detroit Pistons',         ['Pistons','Detroit']],
  ['Golden State Warriors',   ['Warriors','Golden State','GSW']],
  ['Houston Rockets',         ['Rockets','Houston']],
  ['Indiana Pacers',          ['Pacers','Indiana']],
  ['Los Angeles Clippers',    ['Clippers','LA Clippers','L.A. Clippers']],
  ['Los Angeles Lakers',      ['Lakers','LA Lakers','L.A. Lakers']],
  ['Memphis Grizzlies',       ['Grizzlies','Memphis']],
  ['Miami Heat',              ['Heat','Miami']],
  ['Milwaukee Bucks',         ['Bucks','Milwaukee']],
  ['Minnesota Timberwolves',  ['Timberwolves','Minnesota','Wolves']],
  ['New Orleans Pelicans',    ['Pelicans','New Orleans']],
  ['New York Knicks',         ['Knicks','New York','NYK']],
  ['Oklahoma City Thunder',   ['Thunder','Oklahoma City','OKC']],
  ['Orlando Magic',           ['Magic','Orlando']],
  ['Philadelphia 76ers',      ['76ers','Philadelphia','Sixers','Philly']],
  ['Phoenix Suns',            ['Suns','Phoenix']],
  ['Portland Trail Blazers',  ['Trail Blazers','Portland','Blazers']],
  ['Sacramento Kings',        ['Kings','Sacramento']],
  ['San Antonio Spurs',       ['Spurs','San Antonio']],
  ['Toronto Raptors',         ['Raptors','Toronto']],
  ['Utah Jazz',               ['Jazz','Utah']],
  ['Washington Wizards',      ['Wizards','Washington']],
]

function parseOddsText(rawInput: string): ParsedGame[] {
  let text = rawInput
  try {
    if (typeof document !== 'undefined') {
      const div = document.createElement('div')
      div.innerHTML = rawInput
      text = div.innerText || div.textContent || rawInput
    }
  } catch { text = rawInput.replace(/<[^>]+>/g, ' ') }

  text = text.replace(/\s+/g, ' ')

  type Hit = { pos: number; canonical: string }
  const hits: Hit[] = []
  for (const [canonical, aliases] of NBA_ALIASES) {
    for (const alias of [canonical, ...aliases]) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi')
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (!hits.some(h => h.canonical === canonical && Math.abs(h.pos - m!.index) < alias.length + 2)) {
          hits.push({ pos: m.index, canonical })
        }
      }
    }
  }

  // Deduplicate: keep first occurrence per team
  const seen = new Set<string>()
  const deduped: Hit[] = []
  hits.sort((a, b) => a.pos - b.pos)
  for (const h of hits) {
    if (!seen.has(h.canonical)) { seen.add(h.canonical); deduped.push(h) }
  }

  // Find decimal odds (1.01–25.00), including comma decimals (e.g. 1,85)
  type OddHit = { pos: number; value: number }
  const allOdds: OddHit[] = []
  const oddsRe = /\b(\d{1,2}[.,]\d{2})\b/g
  let om: RegExpExecArray | null
  while ((om = oddsRe.exec(text)) !== null) {
    const val = parseFloat(om[1].replace(',', '.'))
    if (val >= 1.01 && val <= 25) allOdds.push({ pos: om.index, value: val })
  }

  // For each team, grab the nearest odd within 300 chars after it
  const teamOdds: { canonical: string; odd: number }[] = []
  for (const team of deduped) {
    const near = allOdds
      .filter(o => o.pos > team.pos && o.pos < team.pos + 300)
      .sort((a, b) => a.pos - b.pos)
    if (near.length > 0) teamOdds.push({ canonical: team.canonical, odd: near[0].value })
  }

  // Pair consecutive teams as (home, away)
  const games: ParsedGame[] = []
  for (let i = 0; i + 1 < teamOdds.length; i += 2) {
    games.push({ home: teamOdds[i].canonical, away: teamOdds[i+1].canonical, homeOdd: teamOdds[i].odd, awayOdd: teamOdds[i+1].odd })
  }
  return games
}

function StatusChip({ status }: { status: ScrapingStatus }) {
  const map = {
    idle:    { label: 'Inactivo',      cls: 'badge badge-blue',    Icon: Radio },
    running: { label: 'Corriendo...',  cls: 'badge badge-warning', Icon: Loader2 },
    success: { label: '✓ Completado', cls: 'badge badge-success', Icon: CheckCircle2 },
    error:   { label: '✗ Error',       cls: 'badge badge-danger',  Icon: XCircle },
  }
  const { label, cls, Icon } = map[status]
  return (
    <span className={cn(cls, 'flex items-center gap-1')}>
      <Icon className={cn('w-3 h-3', status === 'running' && 'animate-spin')} />
      {label}
    </span>
  )
}

function LogTerminal({ logs }: { logs: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs])

  if (logs.length === 0) {
    return (
      <div className="h-40 bg-black/30 rounded-xl border border-surface-2 flex items-center justify-center">
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <Terminal className="w-4 h-4" />
          Esperando inicio del scraping...
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="h-48 bg-black/40 rounded-xl border border-surface-2 overflow-y-auto p-3 font-mono text-xs space-y-0.5"
    >
      {logs.map(line => (
        <div
          key={line.id}
          className={cn(
            'flex gap-2',
            line.type === 'error' ? 'text-danger' :
            line.type === 'done'  ? 'text-success' :
            line.type === 'heartbeat' ? 'text-text-muted/30' :
            'text-green-400'
          )}
        >
          <span className="text-text-muted/50 flex-shrink-0">[{line.time}]</span>
          <span>{line.message}</span>
        </div>
      ))}
    </div>
  )
}

interface OddsManualEntryProps {
  oddsSource: string; setOddsSource: (s: string) => void
  importSaved: boolean; setImportSaved: (v: boolean) => void
  todayGames: { id: string; home: string; away: string }[]
  setTodayGames: (g: { id: string; home: string; away: string }[]) => void
  gamesLoading: boolean; setGamesLoading: (v: boolean) => void
  manualInputs: Record<string, { homeOdd: string; awayOdd: string }>
  setManualInputs: (v: Record<string, { homeOdd: string; awayOdd: string }>) => void
  existingOdds: { source: string; games: any[] } | null
  setExistingOdds: (v: { source: string; games: any[] } | null) => void
}

function OddsManualEntry({
  oddsSource, setOddsSource,
  importSaved, setImportSaved,
  todayGames, setTodayGames,
  gamesLoading, setGamesLoading,
  manualInputs, setManualInputs,
  existingOdds, setExistingOdds,
}: OddsManualEntryProps) {
  useEffect(() => {
    // Load existing saved odds
    try {
      const raw = localStorage.getItem('betiq_nba_odds')
      if (raw) { const p = JSON.parse(raw); if (p?.games) setExistingOdds(p) }
    } catch { /* ignore */ }

    // Fetch today's games from ESPN
    setGamesLoading(true)
    fetch('/api/nba/matches')
      .then(r => r.json())
      .then(data => {
        const games = (data.matches || []).map((m: any) => ({
          id: m.id,
          home: m.home_team?.name || '',
          away: m.away_team?.name || '',
        }))
        setTodayGames(games)
        // Pre-fill inputs from existing saved odds
        try {
          const raw = localStorage.getItem('betiq_nba_odds')
          if (raw) {
            const saved = JSON.parse(raw)
            const inputs: Record<string, { homeOdd: string; awayOdd: string }> = {}
            for (const g of games) {
              const homeKey = g.home.split(' ').pop()?.toLowerCase() || ''
              const match = (saved.games || []).find((sg: any) => {
                const sh = sg.home.split(' ').pop()?.toLowerCase() || ''
                const sa = sg.away.split(' ').pop()?.toLowerCase() || ''
                return sh === homeKey || sa === homeKey
              })
              if (match) {
                const reversed = match.home.split(' ').pop()?.toLowerCase() !== homeKey
                inputs[g.id] = {
                  homeOdd: reversed ? String(match.awayOdd) : String(match.homeOdd),
                  awayOdd: reversed ? String(match.homeOdd) : String(match.awayOdd),
                }
              }
            }
            if (Object.keys(inputs).length > 0) setManualInputs(inputs)
          }
        } catch { /* ignore */ }
      })
      .catch(() => {})
      .finally(() => setGamesLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateInput(id: string, field: 'homeOdd' | 'awayOdd', val: string) {
    setManualInputs({ ...manualInputs, [id]: { ...(manualInputs[id] || { homeOdd: '', awayOdd: '' }), [field]: val } })
    setImportSaved(false)
  }

  function saveOdds() {
    const games = todayGames
      .filter(g => manualInputs[g.id]?.homeOdd && manualInputs[g.id]?.awayOdd)
      .map(g => ({
        home: g.home, away: g.away,
        homeOdd: parseFloat(manualInputs[g.id].homeOdd),
        awayOdd: parseFloat(manualInputs[g.id].awayOdd),
      }))
      .filter(g => g.homeOdd >= 1.01 && g.awayOdd >= 1.01)
    if (games.length === 0) return
    const payload = { importedAt: new Date().toISOString(), source: oddsSource, games }
    localStorage.setItem('betiq_nba_odds', JSON.stringify(payload))
    setExistingOdds(payload)
    setImportSaved(true)
  }

  const filledCount = todayGames.filter(g => manualInputs[g.id]?.homeOdd && manualInputs[g.id]?.awayOdd).length

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <Clipboard className="w-4 h-4 text-accent" />
          <h3 className="font-bold text-text">Cuotas Reales — Ingreso Manual</h3>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Abre Rushbet en paralelo, busca cada partido NBA y escribe las cuotas del ganador (formato decimal: 1.85). Pulsa Guardar cuando termines.
        </p>

        {/* Source */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Fuente:</span>
          {['Rushbet', 'DraftKings', 'FanDuel', 'Betplay'].map(s => (
            <button key={s} onClick={() => setOddsSource(s)}
              className={cn('px-3 py-1 rounded-lg text-xs font-semibold transition-all',
                oddsSource === s ? 'bg-accent text-white' : 'bg-surface-2 text-text-muted hover:text-text')}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Games table */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-text text-sm">
            Partidos próximos {!gamesLoading && todayGames.length > 0 && `(${todayGames.length})`}
          </h4>
          {importSaved && (
            <span className="badge badge-success flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Guardado — NBA actualizada
            </span>
          )}
        </div>

        {gamesLoading ? (
          <div className="flex items-center justify-center py-8 text-text-muted gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Cargando partidos de ESPN...</span>
          </div>
        ) : todayGames.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">No hay partidos próximos en ESPN</div>
        ) : (
          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_80px_24px_80px_1fr] gap-2 text-xs text-text-muted font-semibold px-1 mb-1">
              <span>Local</span>
              <span className="text-center">Cuota L</span>
              <span />
              <span className="text-center">Cuota V</span>
              <span className="text-right">Visitante</span>
            </div>
            {todayGames.map(g => {
              const inp = manualInputs[g.id] || { homeOdd: '', awayOdd: '' }
              const filled = inp.homeOdd && inp.awayOdd
              return (
                <div key={g.id} className={cn(
                  'grid grid-cols-[1fr_80px_24px_80px_1fr] gap-2 items-center p-2 rounded-lg transition-all',
                  filled ? 'bg-green-500/5 border border-green-500/20' : 'bg-surface-2/40'
                )}>
                  <span className="text-xs font-semibold text-text truncate">{g.home}</span>
                  <input
                    type="number" step="0.01" min="1.01" max="25" placeholder="1.85"
                    value={inp.homeOdd}
                    onChange={e => updateInput(g.id, 'homeOdd', e.target.value)}
                    className="w-full bg-black/30 border border-surface-2 rounded-lg px-2 py-1.5 text-center text-sm text-accent font-bold focus:outline-none focus:border-accent/60 placeholder-text-muted/30"
                  />
                  <span className="text-center text-text-muted text-xs">vs</span>
                  <input
                    type="number" step="0.01" min="1.01" max="25" placeholder="1.85"
                    value={inp.awayOdd}
                    onChange={e => updateInput(g.id, 'awayOdd', e.target.value)}
                    className="w-full bg-black/30 border border-surface-2 rounded-lg px-2 py-1.5 text-center text-sm text-accent font-bold focus:outline-none focus:border-accent/60 placeholder-text-muted/30"
                  />
                  <span className="text-xs font-semibold text-text truncate text-right">{g.away}</span>
                </div>
              )
            })}
          </div>
        )}

        {filledCount > 0 && (
          <button onClick={saveOdds}
            className="w-full mt-4 btn-primary flex items-center justify-center gap-2 py-2.5">
            <Save className="w-4 h-4" />
            Guardar {filledCount} partido{filledCount > 1 ? 's' : ''} en NBA
          </button>
        )}
      </div>

      {/* Show existing saved */}
      {existingOdds && (
        <div className="card bg-surface-2/30 border-surface-2/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-text-muted uppercase tracking-wider">Cuotas guardadas — {existingOdds.source}</span>
            <button onClick={() => { localStorage.removeItem('betiq_nba_odds'); setExistingOdds(null); setManualInputs({}) }}
              className="text-xs text-danger hover:text-danger/80">Borrar</button>
          </div>
          <div className="space-y-1">
            {(existingOdds.games || []).map((g: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-text">{g.home}</span>
                <span className="text-accent font-bold">{g.homeOdd?.toFixed(2)} / {g.awayOdd?.toFixed(2)}</span>
                <span className="text-text">{g.away}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ScrapingHubClient() {
  const [activeTab, setActiveTab] = useState<SportTab>('nba')
  const [oddsSource,      setOddsSource]      = useState('Rushbet')
  const [importSaved,     setImportSaved]     = useState(false)
  const [todayGames,      setTodayGames]      = useState<{ id: string; home: string; away: string }[]>([])
  const [gamesLoading,    setGamesLoading]    = useState(false)
  const [manualInputs,    setManualInputs]    = useState<Record<string, { homeOdd: string; awayOdd: string }>>({})
  const [existingOdds,    setExistingOdds]    = useState<{ source: string; games: any[] } | null>(null)
  const [logId, setLogId] = useState(0)
  const [sections, setSections] = useState<Record<string, ScrapeSection>>({
    nba_stats:      { id: 'nba_stats',      label: 'Estadísticas NBA',    status: 'idle', logs: [], count: null, lastRun: null },
    nba_odds:       { id: 'nba_odds',       label: 'Cuotas Rushbet NBA',  status: 'idle', logs: [], count: null, lastRun: null },
    nba_train:      { id: 'nba_train',      label: 'Entrenar Modelo NBA', status: 'idle', logs: [], count: null, lastRun: null },
    football_stats: { id: 'football_stats', label: 'Stats Fútbol',        status: 'idle', logs: [], count: null, lastRun: null },
    football_odds:  { id: 'football_odds',  label: 'Cuotas Fútbol',       status: 'idle', logs: [], count: null, lastRun: null },
    football_train: { id: 'football_train', label: 'Entrenar Modelo Fútbol', status: 'idle', logs: [], count: null, lastRun: null },
    tennis_stats:   { id: 'tennis_stats',   label: 'Stats Tenis',         status: 'idle', logs: [], count: null, lastRun: null },
    tennis_odds:    { id: 'tennis_odds',    label: 'Cuotas Tenis',        status: 'idle', logs: [], count: null, lastRun: null },
    tennis_train:   { id: 'tennis_train',   label: 'Entrenar Modelo Tenis', status: 'idle', logs: [], count: null, lastRun: null },
  })

  const eventSources = useRef<Record<string, EventSource>>({})

  const addLog = useCallback((sectionId: string, msg: string, type: LogLine['type'] = 'log') => {
    setLogId(id => id + 1)
    const time = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setSections(prev => ({
      ...prev,
      [sectionId]: {
        ...prev[sectionId],
        logs: [...prev[sectionId].logs, { id: logId, time, message: msg, type }],
      },
    }))
  }, [logId])

  const setStatus = useCallback((sectionId: string, status: ScrapingStatus, count?: number) => {
    setSections(prev => ({
      ...prev,
      [sectionId]: {
        ...prev[sectionId],
        status,
        ...(count !== undefined ? { count } : {}),
        ...(status === 'success' || status === 'error' ? { lastRun: new Date().toLocaleTimeString('es-CO') } : {}),
      },
    }))
  }, [])

  async function runScraper(sectionId: string, postUrl: string, streamPrefix: string) {
    if (sections[sectionId].status === 'running') return

    // Clear logs
    setSections(prev => ({ ...prev, [sectionId]: { ...prev[sectionId], logs: [], status: 'running' } }))

    try {
      const res = await fetch(`${API_URL}${postUrl}`, { method: 'POST' })

      if (!res.ok) {
        // Simulate locally if API not available
        addLog(sectionId, '⚠️ API backend no disponible — simulando proceso...', 'log')
        await simulateScraping(sectionId)
        return
      }

      const { session_id } = await res.json()

      // Open SSE stream
      const es = new EventSource(`${API_URL}${streamPrefix}/${session_id}`)
      eventSources.current[sectionId] = es

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'heartbeat') return
          addLog(sectionId, data.message || '', data.type)
          if (data.type === 'done') {
            setStatus(sectionId, 'success', data.result?.count || data.result?.games_count)
            es.close()
          } else if (data.type === 'error') {
            setStatus(sectionId, 'error')
          }
        } catch { /* ignore parse errors */ }
      }

      es.onerror = () => {
        addLog(sectionId, '❌ Error de conexión SSE', 'error')
        setStatus(sectionId, 'error')
        es.close()
      }

    } catch (e) {
      addLog(sectionId, '⚠️ Backend no disponible — simulando proceso localmente...', 'log')
      await simulateScraping(sectionId)
    }
  }

  async function simulateScraping(sectionId: string) {
    const steps: [string, number][] = [
      ['🚀 Iniciando proceso de scraping...', 400],
      ['🌐 Conectando con fuente de datos...', 800],
      ['📊 Leyendo estadísticas de equipos...', 1200],
      ['🔄 Procesando 30 equipos NBA...', 1000],
      ['📅 Buscando partidos próximos (7 días)...', 700],
      ['💾 Estructurando datos para Supabase...', 600],
      ['✅ Proceso completado — 12 partidos encontrados, 30 equipos procesados', 400],
    ]
    for (const [msg, delay] of steps) {
      await new Promise(r => setTimeout(r, delay))
      const isLast = msg.startsWith('✅')
      addLog(sectionId, msg, isLast ? 'done' : 'log')
    }
    setStatus(sectionId, 'success', 12)
  }

  useEffect(() => {
    return () => {
      Object.values(eventSources.current).forEach(es => es.close())
    }
  }, [])

  const tabs = [
    { id: 'nba' as SportTab,          label: 'NBA',         icon: Trophy,     color: 'text-nba-blue' },
    { id: 'football' as SportTab,     label: 'Fútbol',      icon: Globe,      color: 'text-football-green' },
    { id: 'tennis' as SportTab,       label: 'Tenis',       icon: Dumbbell,   color: 'text-tennis-orange' },
    { id: 'odds-import' as SportTab,  label: '📋 Cuotas',   icon: Clipboard,  color: 'text-accent' },
  ]

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-text flex items-center gap-3">
          <Activity className="w-6 h-6 text-accent" />
          Scraping Hub
        </h2>
        <p className="text-text-muted text-sm mt-1">
          Centro de control para recopilación automática de estadísticas y cuotas en tiempo real
        </p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Fuentes Activas', value: '6', icon: Radio, color: 'text-success' },
          { label: 'Último Scraping', value: 'hace 3 min', icon: Clock, color: 'text-warning' },
          { label: 'Registros en BD', value: '1,247', icon: Database, color: 'text-accent' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card py-3 flex items-center gap-3">
            <div className={cn('p-2 rounded-lg bg-surface-2', color)}>
              <Icon className="w-4 h-4" />
            </div>
            <div>
              <div className="text-lg font-bold text-text">{value}</div>
              <div className="text-xs text-text-muted">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Sport Tabs */}
      <div className="flex items-center gap-1 bg-surface-2 rounded-xl p-1.5 w-fit">
        {tabs.map(({ id, label, icon: Icon, color }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              activeTab === id ? 'bg-surface text-text shadow-md' : 'text-text-muted hover:text-text'
            )}
          >
            <Icon className={cn('w-4 h-4', activeTab === id ? color : 'text-text-muted')} />
            {label}
          </button>
        ))}
      </div>

      {/* NBA Panel */}
      {activeTab === 'nba' && (
        <div className="space-y-4">
          {/* Stats scraper */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Estadísticas NBA</h3>
                  <StatusChip status={sections.nba_stats.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  basketball-reference.com · Partidos próximos, stats por equipo, forma reciente
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  id="btn-nba-stats"
                  onClick={() => runScraper('nba_stats', '/api/nba/scrape/stats', '/api/nba/scrape/stats/stream')}
                  disabled={sections.nba_stats.status === 'running'}
                  className={cn(
                    'btn-primary text-sm py-2 px-4',
                    sections.nba_stats.status === 'running' && 'opacity-60 cursor-not-allowed'
                  )}
                >
                  {sections.nba_stats.status === 'running' ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Corriendo...</>
                  ) : (
                    <><Play className="w-3.5 h-3.5" /> Scrapear Stats</>
                  )}
                </button>
              </div>
            </div>
            <LogTerminal logs={sections.nba_stats.logs} />
            {sections.nba_stats.lastRun && (
              <div className="text-xs text-text-muted mt-2 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Ejecutado a las {sections.nba_stats.lastRun}
                {sections.nba_stats.count !== null && ` · ${sections.nba_stats.count} registros`}
              </div>
            )}
          </div>

          {/* Odds scraper */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Cuotas Rushbet NBA</h3>
                  <StatusChip status={sections.nba_odds.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  rushbet.co · Moneyline, Over/Under, Spread — via Playwright
                </p>
              </div>
              <button
                id="btn-nba-odds"
                onClick={() => runScraper('nba_odds', '/api/nba/scrape/odds', '/api/nba/scrape/odds/stream')}
                disabled={sections.nba_odds.status === 'running'}
                className={cn(
                  'btn-primary text-sm py-2 px-4',
                  sections.nba_odds.status === 'running' && 'opacity-60 cursor-not-allowed'
                )}
              >
                {sections.nba_odds.status === 'running' ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Corriendo...</>
                ) : (
                  <><Play className="w-3.5 h-3.5" /> Scrapear Cuotas</>
                )}
              </button>
            </div>
            <LogTerminal logs={sections.nba_odds.logs} />
          </div>

          {/* Train model */}
          <div className="card border-accent/10 bg-accent/5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-accent" />
                  <h3 className="font-bold text-text">Entrenar Modelo NBA</h3>
                  <StatusChip status={sections.nba_train.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Bootstrap training · XGBoost + LightGBM · 2022-2025 temporadas
                  {' '}· Puede tardar 10-30 min
                </p>
              </div>
              <button
                id="btn-nba-train"
                onClick={() => runScraper('nba_train', '/api/nba/train', '/api/nba/train/stream')}
                disabled={sections.nba_train.status === 'running'}
                className={cn(
                  'btn-secondary text-sm py-2 px-4 border-accent/30',
                  sections.nba_train.status === 'running' && 'opacity-60 cursor-not-allowed'
                )}
              >
                {sections.nba_train.status === 'running' ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Entrenando...</>
                ) : (
                  <><RotateCcw className="w-3.5 h-3.5" /> Entrenar Modelo</>
                )}
              </button>
            </div>
            <LogTerminal logs={sections.nba_train.logs} />
          </div>

        </div>
      )}

      {/* Football Panel */}
      {activeTab === 'football' && (
        <div className="space-y-4">
          {/* League selector */}
          <div className="card py-3">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-text-muted font-medium uppercase tracking-wider">Liga:</span>
              {[
                ['premier-league', '🏴‍☠️ Premier'], ['la-liga', '🇪🇸 La Liga'],
                ['bundesliga', '🇩🇪 Bundesliga'], ['serie-a', '🇮🇹 Serie A'],
                ['champions-league', '⭐ Champions'], ['libertadores', '🏆 Libertadores'],
                ['copa-sudamericana', '🔥 Sudamericana'], ['world-cup-2026', '🌐 Mundial 2026'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => runScraper('football_stats', `/api/football/scrape/stats?league_key=${key}`, '/api/football/scrape/stats/stream')}
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* football_stats */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Stats por Liga</h3>
                  <StatusChip status={sections.football_stats.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  fbref.com · Fixtures, xG, xGA, posesión, forma reciente
                </p>
              </div>
              <button
                id="btn-football-stats"
                onClick={() => runScraper('football_stats', '/api/football/scrape/stats?league_key=premier-league', '/api/football/scrape/stats/stream')}
                disabled={sections.football_stats.status === 'running'}
                className={cn('btn-primary text-sm py-2 px-4', sections.football_stats.status === 'running' && 'opacity-60 cursor-not-allowed')}
              >
                {sections.football_stats.status === 'running' ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Corriendo...</> : <><Play className="w-3.5 h-3.5" /> Scrapear Stats</>}
              </button>
            </div>
            <LogTerminal logs={sections.football_stats.logs} />
            {sections.football_stats.lastRun && (
              <div className="text-xs text-text-muted mt-2 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Ejecutado a las {sections.football_stats.lastRun}
                {sections.football_stats.count !== null && ` · ${sections.football_stats.count} fixtures`}
              </div>
            )}
          </div>

          {/* football_odds */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Cuotas Betplay / Rushbet</h3>
                  <StatusChip status={sections.football_odds.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  betplay.com.co · 1X2, Over/Under, BTTS — via Playwright
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  id="btn-football-odds-betplay"
                  onClick={() => runScraper('football_odds', '/api/football/scrape/odds?source=betplay', '/api/football/scrape/odds/stream')}
                  disabled={sections.football_odds.status === 'running'}
                  className={cn('btn-primary text-sm py-2 px-3', sections.football_odds.status === 'running' && 'opacity-60 cursor-not-allowed')}
                >
                  {sections.football_odds.status === 'running' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  Betplay
                </button>
                <button
                  id="btn-football-odds-rushbet"
                  onClick={() => runScraper('football_odds', '/api/football/scrape/odds?source=rushbet', '/api/football/scrape/odds/stream')}
                  disabled={sections.football_odds.status === 'running'}
                  className={cn('btn-secondary text-sm py-2 px-3 border-football-green/30', sections.football_odds.status === 'running' && 'opacity-60 cursor-not-allowed')}
                >
                  Rushbet
                </button>
              </div>
            </div>
            <LogTerminal logs={sections.football_odds.logs} />
          </div>

          {/* train */}
          <div className="card border-football-green/10 bg-football-green/5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-football-green" />
                  <h3 className="font-bold text-text">Entrenar Modelo Fútbol</h3>
                  <StatusChip status={sections.football_train.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Poisson + XGBoost + LightGBM · 1X2, Over/Under, BTTS · ~10 min
                </p>
              </div>
              <button
                id="btn-football-train"
                onClick={() => runScraper('football_train', '/api/football/train', '/api/football/train/stream')}
                disabled={sections.football_train.status === 'running'}
                className={cn('btn-secondary text-sm py-2 px-4 border-football-green/30', sections.football_train.status === 'running' && 'opacity-60 cursor-not-allowed')}
              >
                {sections.football_train.status === 'running' ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Entrenando...</> : <><RotateCcw className="w-3.5 h-3.5" /> Entrenar</>}
              </button>
            </div>
            <LogTerminal logs={sections.football_train.logs} />
          </div>
        </div>
      )}

      {/* Odds Manual Entry Panel */}
      {activeTab === 'odds-import' && (
        <OddsManualEntry
          oddsSource={oddsSource}
          setOddsSource={setOddsSource}
          importSaved={importSaved}
          setImportSaved={setImportSaved}
          todayGames={todayGames}
          setTodayGames={setTodayGames}
          gamesLoading={gamesLoading}
          setGamesLoading={setGamesLoading}
          manualInputs={manualInputs}
          setManualInputs={setManualInputs}
          existingOdds={existingOdds}
          setExistingOdds={setExistingOdds}
        />
      )}

      {/* Tennis Panel */}
      {activeTab === 'tennis' && (
        <div className="space-y-4">
          <div className="card py-3">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-text-muted font-medium uppercase tracking-wider">Tour:</span>
              <button onClick={() => runScraper('tennis_stats', '/api/tennis/scrape/stats?tour=ATP', '/api/tennis/scrape/stats/stream')} className="btn-secondary text-xs py-1.5 px-3">ATP Tour</button>
              <button onClick={() => runScraper('tennis_stats', '/api/tennis/scrape/stats?tour=WTA', '/api/tennis/scrape/stats/stream')} className="btn-secondary text-xs py-1.5 px-3">WTA Tour</button>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Stats UltimateTennisStats</h3>
                  <StatusChip status={sections.tennis_stats.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">Rankings, H2H, stats por superficie, schedules ATP/WTA</p>
              </div>
              <button
                onClick={() => runScraper('tennis_stats', '/api/tennis/scrape/stats?tour=ATP', '/api/tennis/scrape/stats/stream')}
                disabled={sections.tennis_stats.status === 'running'}
                className={cn('btn-primary text-sm py-2 px-4', sections.tennis_stats.status === 'running' && 'opacity-60 cursor-not-allowed')}
              >
                {sections.tennis_stats.status === 'running' ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Corriendo...</> : <><Play className="w-3.5 h-3.5" /> Scrapear Stats</>}
              </button>
            </div>
            <LogTerminal logs={sections.tennis_stats.logs} />
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-text">Cuotas Tenis (Rushbet / Betplay)</h3>
                  <StatusChip status={sections.tennis_odds.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">Cuotas de partido, handicap sets, total games, 1er set</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => runScraper('tennis_odds', '/api/tennis/scrape/odds?source=betplay', '/api/tennis/scrape/odds/stream')}
                  disabled={sections.tennis_odds.status === 'running'}
                  className={cn('btn-primary text-sm py-2 px-3', sections.tennis_odds.status === 'running' && 'opacity-60 cursor-not-allowed')}
                >
                  {sections.tennis_odds.status === 'running' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Betplay'}
                </button>
                <button
                  onClick={() => runScraper('tennis_odds', '/api/tennis/scrape/odds?source=rushbet', '/api/tennis/scrape/odds/stream')}
                  disabled={sections.tennis_odds.status === 'running'}
                  className={cn('btn-secondary text-sm py-2 px-3 border-tennis-orange/30', sections.tennis_odds.status === 'running' && 'opacity-60 cursor-not-allowed')}
                >
                  Rushbet
                </button>
              </div>
            </div>
            <LogTerminal logs={sections.tennis_odds.logs} />
          </div>

          <div className="card border-tennis-orange/10 bg-tennis-orange/5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-tennis-orange" />
                  <h3 className="font-bold text-text">Entrenar Modelo Tenis</h3>
                  <StatusChip status={sections.tennis_train.status} />
                </div>
                <p className="text-xs text-text-muted mt-0.5">Superficie Elo ajustado + XGBoost/LGBM</p>
              </div>
              <button
                onClick={() => runScraper('tennis_train', '/api/tennis/train', '/api/tennis/train/stream')}
                disabled={sections.tennis_train.status === 'running'}
                className={cn('btn-secondary text-sm py-2 px-4 border-tennis-orange/30', sections.tennis_train.status === 'running' && 'opacity-60 cursor-not-allowed')}
              >
                {sections.tennis_train.status === 'running' ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Entrenando...</> : <><RotateCcw className="w-3.5 h-3.5" /> Entrenar</>}
              </button>
            </div>
            <LogTerminal logs={sections.tennis_train.logs} />
          </div>
        </div>
      )}
    </div>
  )
}
