import { create } from 'zustand'

interface UserState {
  weeklyBudgetCOP: number
  strategy: 'aggressive' | 'moderate' | 'conservative'
  fixedPct: number
  parlayPct: number
  setStrategy: (s: UserState['strategy']) => void
  setBudget: (amount: number) => void
  setAllocation: (fixedPct: number, parlayPct: number) => void
}

export const useUserStore = create<UserState>((set) => ({
  weeklyBudgetCOP: 200000,
  strategy: 'aggressive',
  fixedPct: 50,
  parlayPct: 50,
  setStrategy: (strategy) => {
    const allocations = {
      aggressive: { fixedPct: 50, parlayPct: 50 },
      moderate: { fixedPct: 70, parlayPct: 30 },
      conservative: { fixedPct: 85, parlayPct: 15 },
    }
    set({ strategy, ...allocations[strategy] })
  },
  setBudget: (weeklyBudgetCOP) => set({ weeklyBudgetCOP }),
  setAllocation: (fixedPct, parlayPct) => set({ fixedPct, parlayPct }),
}))
