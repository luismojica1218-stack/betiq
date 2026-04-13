import type { Metadata } from 'next'
import FutbolClient from './FutbolClient'

export const metadata: Metadata = { title: 'Fútbol' }

export default function Page() {
  return <FutbolClient />
}
