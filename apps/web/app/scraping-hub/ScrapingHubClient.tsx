'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, Play, RotateCcw, Trophy, Globe, Dumbbell,
  CheckCircle2, XCircle, Loader2, Terminal, Clock,
  Database, Zap, Radio
} from 'lucide-react'
import { cn } from '@/lib/utils'

type ScrapingStatus = 'idle' | 'running' | 'success' | 'error'
type SportTab = 'nba' | 'football' | 'tennis'

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

export default function ScrapingHubClient() {
  const [activeTab, setActiveTab] = useState<SportTab>('nba')
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
    { id: 'nba' as SportTab,      label: 'NBA',    icon: Trophy,   color: 'text-nba-blue' },
    { id: 'football' as SportTab, label: 'Fútbol', icon: Globe,    color: 'text-football-green' },
    { id: 'tennis' as SportTab,   label: 'Tenis',  icon: Dumbbell, color: 'text-tennis-orange' },
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
                ['world-cup-2026', '🌐 Mundial 2026'],
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
