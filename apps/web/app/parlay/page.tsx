import type { Metadata } from 'next'
import ParlayClient from './ParlayClient'

export const metadata: Metadata = { title: 'Parlays' }

export default function Page() {
  return <ParlayClient />
}
