import { expect, test } from '@playwright/test'
import {
  holdLiveFrames,
  installSolanaProviderMock,
  installSolanaWeb3Mock,
  openDemo,
} from './helpers'

const finalLiveTime = new Date('2026-07-19T20:10:30.000Z')

test.describe('deterministic live relay states', () => {
  test('CONNECTING becomes LIVE only after a frame, then becomes STALE', async ({ page }) => {
    const frames = await holdLiveFrames(page)
    // Pin the unfinished final inside its real live window so freshness,
    // target binding, and non-finalized status remain deterministic.
    await page.clock.setFixedTime(finalLiveTime)
    await openDemo(page, '&fixture=18257739')
    await page.locator('#liveCtl').evaluate((el: HTMLDetailsElement) => { el.open = true })
    await page.locator('#goLiveBtn').click()

    await frames.waitUntilRequested()
    await expect(page.locator('#liveStatus')).toContainText('CONNECTING')
    await expect(page.locator('#globalMode')).toHaveText('PRACTICE REPLAY')

    await frames.release()
    await expect(page.locator('#liveStatus')).toContainText('LIVE')
    await expect(page.locator('#globalMode')).toHaveText('VERIFIED LIVE / ON-CHAIN')

    await page.evaluate(() => {
      // Exercise the real age threshold without a 91-second wall-clock wait.
      liveStat.lastFrameAt = Date.now() - 91_000
      liveSetStatus()
    })
    await expect(page.locator('#liveStatus')).toContainText('STALE')

    await page.locator('#goLiveBtn').click()
    await expect(page.locator('#liveStatus')).toContainText('relay idle')
  })
})

test.describe('explicit Solana provider test double', () => {
  test('shows a wallet rejection without claiming a connection', async ({ page }) => {
    await installSolanaWeb3Mock(page)
    await installSolanaProviderMock(page, 'rejected')
    await openDemo(page)

    await page.locator('#walletBtn').click()
    await expect(page.locator('#toasts')).toContainText('wallet connection rejected or failed')
    await expect(page.locator('#walletBtn')).toContainText('Connect Wallet')
    expect(await page.evaluate(() => window.__FORESIGHT_SOLANA_PROVIDER_MOCK__)).toBe(true)
  })

  test('keeps the wallet button pending until the mock provider resolves', async ({ page }) => {
    await installSolanaWeb3Mock(page)
    await installSolanaProviderMock(page, 'pending')
    await openDemo(page)

    await page.locator('#walletBtn').click()
    await expect(page.locator('#walletBtn')).toBeDisabled()
    await expect(page.locator('#walletBtn')).toHaveClass(/wallet-pending/)
    await page.evaluate(() => window.__resolveForesightSolanaProviderMock())
    await expect(page.locator('#walletBtn')).toBeEnabled()
    await expect(page.locator('#walletBtn')).toContainText('2.000 SOL')
    expect(await page.evaluate(() => window.__FORESIGHT_SOLANA_RPC_MOCK_USED__)).toBe(true)
  })

  test('confirms an eligible live commit through mocks without RPC or wallet mutation', async ({ page }) => {
    const frames = await holdLiveFrames(page)
    await installSolanaWeb3Mock(page)
    await installSolanaProviderMock(page, 'confirmed')
    await page.clock.setFixedTime(finalLiveTime)
    await openDemo(page, '&fixture=18257739')

    await page.locator('#walletBtn').click()
    await expect(page.locator('#walletBtn')).toContainText('2.000 SOL')

    await page.locator('#liveCtl').evaluate((el: HTMLDetailsElement) => { el.open = true })
    await page.locator('#goLiveBtn').click()
    await frames.waitUntilRequested()
    await frames.release()
    await expect(page.locator('#globalMode')).toHaveText('VERIFIED LIVE / ON-CHAIN')

    // GO LIVE pins the playhead to the newest captured second. Move one second
    // behind that edge so the UI's "not after this tick" commit guard permits
    // the choice while wallet eligibility still comes from the fresh frame.
    await page.evaluate(() => {
      simT = Math.max(0, FIXTURES[sel].endT - 1)
      renderAll()
    })
    await page.locator('.pick[data-pick="draw"]').click()
    await expect(page.locator('#commitBtn')).toBeEnabled()
    await page.locator('#commitBtn').click()
    // The toast auto-expires; the durable receipt and the mock's captured
    // confirmation signature are the stable evidence for this assertion.
    await expect(page.locator('#mycommits')).toContainText('REAL')
    expect(await page.evaluate(() => window.__FORESIGHT_SOLANA_PROVIDER_MOCK_SIGNED__)).toBe(true)
    expect(await page.evaluate(() => window.__FORESIGHT_SOLANA_CONFIRMED_SIGNATURE__))
      .toBe('foresight-e2e-confirmed-signature')
  })
})

declare global {
  // These are top-level lexical bindings in the static app and are intentionally
  // used only to advance the deterministic stale-age boundary in the test.
  let liveStat: { lastFrameAt: number }
  function liveSetStatus(message?: string): void
  let simT: number
  let sel: number
  const FIXTURES: Array<{ endT: number }>
  function renderAll(): void
}
