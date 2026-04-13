import type { Metadata } from 'next'
import MisApuestasClient from './MisApuestasClient'

export const metadata: Metadata = { title: 'Mis Apuestas' }

export default function Page() {
  return <MisApuestasClient />
}
