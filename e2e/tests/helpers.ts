import { expect, type Page, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'fixtures')

export const e2ePort = Number(process.env.FORESIGHT_E2E_PORT || 4188)
export const relayBase = `http://127.0.0.1:${e2ePort}`

function buildEligibleOddsWindow(seed: string) {
  const dataLine = seed.split(/\r?\n/).find(line => line.startsWith('data: '))
  if (!dataLine) throw new Error('live odds fixture needs one data frame')
  const quote = JSON.parse(dataLine.slice(6))
  // The real-tape builder intentionally requires 50 quotes before the target
  // becomes selectable; expand one readable seed into that minimum window.
  return Array.from({ length: 50 }, (_, index) => {
    const sequence = String(index + 1).padStart(3, '0')
    const frame = { ...quote, MessageId: `odds-e2e-${sequence}`, Ts: Number(quote.Ts) + index * 500 }
    return `id: odds-e2e-${sequence}\nevent: message\ndata: ${JSON.stringify(frame)}\n`
  }).join('\n') + '\n'
}

export async function openDemo(page: Page, extra = '') {
  await page.goto(`/?demo=1&autoplay=0&relay=${encodeURIComponent(relayBase)}${extra}`)
  await expect(page.locator('#globalMode')).toHaveText('PRACTICE REPLAY')
  await expect(page.locator('#sClock')).toHaveText("0'")
}

export async function installSolanaWeb3Mock(page: Page) {
  const body = await readFile(join(fixtures, 'solana-web3.mock.js'), 'utf8')
  await page.route('https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body }),
  )
}

export async function installSolanaProviderMock(
  page: Page,
  mode: 'confirmed' | 'pending' | 'rejected',
  injection: 'legacy' | 'phantom' = 'legacy',
) {
  await page.addInitScript(({ providerMode, injectionShape }) => {
    const address = 'ForesightE2EWallet1111111111111111111111111'
    const publicKey = { toString: () => address }
    let resolveConnect: ((value: { publicKey: typeof publicKey }) => void) | null = null
    const provider = {
      isPhantom: true,
      async connect() {
        if (providerMode === 'rejected') throw new Error('FORESIGHT_E2E_MOCK_REJECTED')
        if (providerMode === 'pending') {
          return new Promise<{ publicKey: typeof publicKey }>(resolve => { resolveConnect = resolve })
        }
        return { publicKey }
      },
      async signAndSendTransaction() {
        window.__FORESIGHT_SOLANA_PROVIDER_MOCK_SIGNED__ = true
        return { signature: 'foresight-e2e-confirmed-signature' }
      },
      async signMessage() {
        return { signature: new Uint8Array([1, 2, 3]) }
      },
    }
    if (injectionShape === 'phantom') {
      Object.defineProperty(window, 'phantom', { configurable: true, value: { solana: provider } })
    } else {
      Object.defineProperty(window, 'solana', { configurable: true, value: provider })
    }
    window.__FORESIGHT_SOLANA_PROVIDER_MOCK__ = true
    window.__resolveForesightSolanaProviderMock = () => {
      if (!resolveConnect) throw new Error('mock connect is not pending')
      resolveConnect({ publicKey })
      resolveConnect = null
    }
  }, { providerMode: mode, injectionShape: injection })
}

declare global {
  interface Window {
    __FORESIGHT_SOLANA_PROVIDER_MOCK__: boolean
    __FORESIGHT_SOLANA_PROVIDER_MOCK_SIGNED__: boolean
    __FORESIGHT_SOLANA_RPC_MOCK_USED__: boolean
    __FORESIGHT_SOLANA_CONFIRMED_SIGNATURE__: string
    __resolveForesightSolanaProviderMock: () => void
  }
}

export async function holdLiveFrames(page: Page) {
  const score = await readFile(join(fixtures, 'live-score.sse'), 'utf8')
  const odds = buildEligibleOddsWindow(await readFile(join(fixtures, 'live-odds.sse'), 'utf8'))
  const pending: Array<{ route: Route; body: string }> = []

  await page.route('**/api/scores/stream?**', route => {
    pending.push({ route, body: score })
  })
  await page.route('**/api/odds/stream?**', route => {
    pending.push({ route, body: odds })
  })

  return {
    async waitUntilRequested() {
      await expect.poll(() => pending.length).toBe(2)
    },
    async release() {
      const frames = pending.splice(0)
      await Promise.all(frames.map(({ route, body }) => route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body,
      })))
    },
  }
}

export function clerkSkipReason() {
  const missing = ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_TESTING_TOKEN']
    .filter(name => !process.env[name])
  if (missing.length) return `Clerk auth E2E skipped: missing ${missing.join(', ')}`
  if (!process.env.CLERK_PUBLISHABLE_KEY!.startsWith('pk_test_')) {
    return 'Clerk auth E2E skipped: CLERK_PUBLISHABLE_KEY must be a pk_test_* development key'
  }
  if (!process.env.CLERK_SECRET_KEY!.startsWith('sk_test_')) {
    return 'Clerk auth E2E skipped: CLERK_SECRET_KEY must be an sk_test_* development key'
  }
  return null
}
