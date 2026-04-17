'use client'

import { useState, useEffect } from 'react'
import { X, CheckCircle, Loader2, DollarSign, TrendingUp, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatCOP, getEVLabel, getEVBadgeColor } from '@/lib/utils'

export interface BetCandidate {
  matchId:         string
  homeTeam:        string
  awayTeam:        string
  sport:           'nba' | 'football' | 'tennis'
  market:          string
  selection:       string
  suggestedOdd:    number
  suggestedAmount: number
  confidence:      number
  expectedValue:   number
  betType:         'fixed' | 'parlay'
  predictionId?:   string
}

interface Props {
  bet:      BetCandidate | null
  onClose:  () => void
  onConfirm: (betId: string) => void
}

const MARKETS = ['Moneyline', 'Over/Under', 'Spread', 'BTTS', 'Handicap Asiático']
const BOOKMAKERS = [
  { id: 'rushbet',  label: 'Rushbet',  color: 'text-orange-400' },
  { id: 'betplay',  label: 'Betplay',  color: 'text-blue-400' },
]

export default function ConfirmBetModal({ bet, onClose, onConfirm }: Props) {
  const [amount,     setAmount]     = useState(0)
  const [odd,        setOdd]        = useState(2.0)
  const [bookmaker,  setBookmaker]  = useState('rushbet')
  const [market,     setMarket]     = useState('Moneyline')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')

  useEffect(() => {
    if (bet) {
      setAmount(bet.suggestedAmount)
      setOdd(bet.suggestedOdd)
      setMarket(bet.market || 'Moneyline')
      setBookmaker(bet.betType === 'parlay' ? 'rushbet' : 'betplay')
    }
  }, [bet])

  if (!bet) return null

  const potentialWin = Math.round(amount * odd)
  const profit       = potentialWin - amount
  const evClass      = getEVBadgeColor(bet.expectedValue)

  async function handleConfirm() {
    setError('')
    const activeBet = bet
    if (!activeBet) return
    if (amount <= 0)    { setError('El monto debe ser mayor a 0'); return }
    if (odd <= 1.0)     { setError('La cuota debe ser mayor a 1.0'); return }
    setLoading(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('No autenticado')

      const isDemoMatch = activeBet.matchId === 'demo' || activeBet.matchId.startsWith('nba-') || !(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeBet.matchId))

      // Perform direct insert via Supabase replacing python API proxy
      const { data, error: sbErr } = await supabase.from('bets').insert({
        user_id:    user.id,
        match_id:   !isDemoMatch ? activeBet.matchId : null,
        prediction_id: activeBet.predictionId || null,
        bet_type:   activeBet.betType,
        bookmaker,
        market,
        selection:  activeBet.selection,
        odd_at_bet: odd,
        amount_cop: amount,
        status:     'pending',
        bet_week:   new Date().toISOString().split('T')[0],
      }).select().single()
      
      if (sbErr) throw new Error(`[DB Error]: ${sbErr.message}`)
      onConfirm(data.id)
    } catch (e: unknown) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Error al guardar la apuesta')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-surface border border-surface-2 rounded-2xl shadow-2xl animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
          <div>
            <h3 className="text-lg font-bold text-text">Confirmar Apuesta</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {bet.homeTeam} vs {bet.awayTeam}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          {/* Prediction summary */}
          <div className="flex items-center gap-3 p-3 bg-surface-2/50 rounded-xl">
            <div className="flex-1">
              <div className="text-sm font-semibold text-text">{bet.selection}</div>
              <div className="text-xs text-text-muted">{bet.market}</div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className={`badge badge-${evClass === 'success' ? 'success' : evClass === 'warning' ? 'warning' : 'danger'}`}>
                {getEVLabel(bet.expectedValue)}
              </span>
              <span className="text-xs text-text-muted">{(bet.confidence * 100).toFixed(0)}% confianza</span>
            </div>
          </div>

          {/* Bookmaker */}
          <div>
            <label className="block text-xs text-text-muted font-medium mb-2 uppercase tracking-wider">
              Casa de Apuestas
            </label>
            <div className="grid grid-cols-2 gap-2">
              {BOOKMAKERS.map(bk => (
                <button
                  key={bk.id}
                  onClick={() => setBookmaker(bk.id)}
                  className={`py-2.5 rounded-lg border-2 text-sm font-semibold transition-all ${
                    bookmaker === bk.id
                      ? 'bg-accent/10 border-accent text-text'
                      : 'border-surface-2 text-text-muted hover:border-accent/30'
                  }`}
                >
                  <span className={bookmaker === bk.id ? 'text-accent' : bk.color}>{bk.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Market */}
          <div>
            <label className="block text-xs text-text-muted font-medium mb-2 uppercase tracking-wider">
              Mercado
            </label>
            <select
              value={market}
              onChange={e => setMarket(e.target.value)}
              className="input text-sm"
            >
              {MARKETS.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Amount & Odd */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted font-medium mb-1.5 uppercase tracking-wider">
                Monto (COP)
              </label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                <input
                  type="number"
                  min={1000}
                  step={5000}
                  value={amount}
                  onChange={e => setAmount(Number(e.target.value))}
                  className="input pl-8 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-text-muted font-medium mb-1.5 uppercase tracking-wider">
                Cuota Real
              </label>
              <input
                type="number"
                min={1.01}
                max={50}
                step={0.01}
                value={odd}
                onChange={e => setOdd(Number(e.target.value))}
                className="input text-sm"
              />
            </div>
          </div>

          {/* Potential win preview */}
          <div className="flex items-center justify-between p-3 bg-success/10 border border-success/20 rounded-xl">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-success" />
              <span className="text-sm text-text-muted">Ganancia potencial</span>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-success">{formatCOP(potentialWin)}</div>
              <div className="text-xs text-text-muted">+{formatCOP(profit)} neto</div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-2 flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1 justify-center">
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="btn-primary flex-1 justify-center"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Guardando...</>
            ) : (
              <><CheckCircle className="w-4 h-4" /> Confirmar</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
