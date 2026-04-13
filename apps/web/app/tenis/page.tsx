import type { Metadata } from 'next'
import TenisClient from './TenisClient'

export const metadata: Metadata = { title: 'Tenis' }

export default function Page() {
  return <TenisClient />
}
