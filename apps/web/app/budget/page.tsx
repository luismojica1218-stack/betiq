'use client'

import { useState } from 'react'
import { Wallet, Save, TrendingUp, Shield, Zap, CheckCircle, Loader2 } from 'lucide-react'
import { useUserStore } from '@/lib/store'
import { formatCOP } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

const strategies = [
  {
    id: 'conservative' as const,
    label: 'Conservador',
    icon: Shield,
    color: 'text-success',
    bg: 'bg-success/10',
    border: 'border-success/30',
    fixed: 85,
    parlay: 15,
    desc: 'Bajo riesgo. Apuestas fijas de alta probabilidad. ROI moderado pero consistente.',
  },
  {
    id: 'moderate' as const,
    label: 'Moderado',
    icon: TrendingUp,
    color: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-warning/30',
    fixed: 70,
    parlay: 30,
    desc: 'Balance entre seguridad y rendimiento. Mix de fijas y pocos parlays seleccionados.',
  },
  {
    id: 'aggressive' as const,
    label: 'Agresivo',
    icon: Zap,
    color: 'text-accent',
    bg: 'bg-accent/10',
    border: 'border-accent/30',
    fixed: 50,
    parlay: 50,
    desc: 'Alta varianza. 50/50 fijas vs parlays. Mayor potencial de ganancia semanal.',
  },
]

export default function BudgetPage() {
  const { weeklyBudgetCOP, strategy, fixedPct, parlayPct, setStrategy, setBudget, setAllocation } = useUserStore()
  const [budgetInput, setBudgetInput] = useState(weeklyBudgetCOP)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [customFixed, setCustomFixed] = useState(fixedPct)

  function handleStrategySelect(s: typeof strategy) {
    setStrategy(s)
    const strat = strategies.find(x => x.id === s)!
    setCustomFixed(strat.fixed)
  }

  function handleSliderChange(val: number) {
    setCustomFixed(val)
    setAllocation(val, 100 - val)
  }

  async function handleSave() {
    setSaving(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase.from('users').upsert({
        id: user.id,
        weekly_budget_cop: budgetInput,
        strategy,
        fixed_pct: customFixed,
        parlay_pct: 100 - customFixed,
      })
    }
    setBudget(budgetInput)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const fixedAmount  = Math.round(budgetInput * customFixed / 100)
  const parlayAmount = Math.round(budgetInput * (100 - customFixed) / 100)

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-text">Presupuesto Semanal</h2>
        <p className="text-text-muted text-sm mt-1">Configura tu estrategia de inversión semana a semana</p>
      </div>

      {/* Budget amount */}
      <div className="card space-y-4">
        <h3 className="section-title text-base">Monto Semanal</h3>
        <div>
          <label className="block text-sm text-text-muted mb-2">Presupuesto en COP</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted font-semibold">$</span>
            <input
              id="budget-amount"
              type="number"
              min={50000}
              max={5000000}
              step={10000}
              value={budgetInput}
              onChange={e => setBudgetInput(Number(e.target.value))}
              className="input pl-8 text-lg font-bold"
            />
          </div>
          <div className="flex gap-2 mt-2">
            {[100000, 200000, 500000, 1000000].map(v => (
              <button
                key={v}
                onClick={() => setBudgetInput(v)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${budgetInput === v ? 'bg-accent text-white border-accent' : 'border-surface-2 text-text-muted hover:border-accent/40'}`}
              >
                {formatCOP(v)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Strategy */}
      <div className="card space-y-4">
        <h3 className="section-title text-base">Estrategia</h3>
        <div className="grid grid-cols-3 gap-3">
          {strategies.map(s => (
            <button
              key={s.id}
              id={`strategy-${s.id}`}
              onClick={() => handleStrategySelect(s.id)}
              className={`p-4 rounded-xl border-2 text-left transition-all duration-200 ${strategy === s.id ? `${s.bg} ${s.border}` : 'border-surface-2 hover:border-surface-2/80'}`}
            >
              <s.icon className={`w-5 h-5 mb-2 ${strategy === s.id ? s.color : 'text-text-muted'}`} />
              <div className={`font-semibold text-sm ${strategy === s.id ? 'text-text' : 'text-text-muted'}`}>{s.label}</div>
              <div className="text-xs text-text-muted mt-1">{s.fixed}% / {s.parlay}%</div>
              {strategy === s.id && (
                <div className="text-xs text-text-muted/80 mt-2 leading-relaxed">{s.desc}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Slider */}
      <div className="card space-y-4">
        <h3 className="section-title text-base">Distribución Personalizada</h3>
        <div>
          <div className="flex justify-between text-sm mb-3">
            <span className="text-blue-400 font-semibold">Fijas {customFixed}% — {formatCOP(fixedAmount)}</span>
            <span className="text-orange-400 font-semibold">Parlays {100-customFixed}% — {formatCOP(parlayAmount)}</span>
          </div>
          <input
            id="budget-slider"
            type="range"
            min={20}
            max={90}
            step={5}
            value={customFixed}
            onChange={e => handleSliderChange(Number(e.target.value))}
            className="w-full accent-accent cursor-pointer"
          />
          <div className="flex justify-between text-xs text-text-muted/60 mt-1">
            <span>Más Parlays</span>
            <span>Balance Agresivo</span>
            <span>Más Fijas</span>
          </div>
        </div>

        {/* Distribution preview */}
        <div className="h-3 rounded-full overflow-hidden flex">
          <div className="bg-blue-500 transition-all duration-300" style={{width:`${customFixed}%`}} />
          <div className="bg-orange-500 transition-all duration-300 flex-1" />
        </div>
      </div>

      {/* Kelly info */}
      <div className="card bg-surface-2/30 border-accent/10">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-accent/10 rounded-lg flex-shrink-0">
            <Wallet className="w-5 h-5 text-accent" />
          </div>
          <div className="text-sm text-text-muted space-y-1">
            <p className="text-text font-semibold">Kelly Criterion — 25% Fraccional</p>
            <p>El sistema calcula automáticamente el monto por apuesta usando Kelly al 25% para proteger tu bankroll. Nunca arriesgarás más del 20% de tu presupuesto en una sola apuesta.</p>
          </div>
        </div>
      </div>

      {/* Save */}
      <button
        id="budget-save"
        onClick={handleSave}
        disabled={saving}
        className="btn-primary w-full justify-center h-12 text-base"
      >
        {saving ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Guardando...</>
        ) : saved ? (
          <><CheckCircle className="w-5 h-5" /> ¡Configuración guardada!</>
        ) : (
          <><Save className="w-5 h-5" /> Guardar Configuración</>
        )}
      </button>
    </div>
  )
}
