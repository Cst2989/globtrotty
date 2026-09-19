import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Globetrotty',
  description: 'Plan a trip with Globetrotty',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <aside className="sidebar" aria-label="Conversations" />
          <main className="main">{children}</main>
        </div>
        <footer className="footer">We never ask for payment or passport details.</footer>
      </body>
    </html>
  )
}
