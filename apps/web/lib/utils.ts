import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCOP(amount: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

export function formatOdd(value: number): string {
  return value.toFixed(2)
}

export function getEVBadgeColor(ev: number): string {
  if (ev > 0.05) return 'success'
  if (ev > 0) return 'warning'
  return 'danger'
}

export function getEVLabel(ev: number): string {
  return `EV: ${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%`
}
