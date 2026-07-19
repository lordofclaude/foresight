import { expect, test } from '@playwright/test'
import { openDemo, relayBase } from './helpers'

test.describe('remaining interactive controls', () => {
  test('landing page supports offline auth fallback, returns on reload, and restores modal focus', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort())
    await page.goto(`/?relay=${encodeURIComponent(relayBase)}&acceptance=gate`)

    await expect(page.locator('#gate')).toBeVisible()
    await expect(page.locator('#gate')).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('.gate-visual')).toBeVisible()
    await expect(page.locator('.gate-visual')).toHaveCSS('opacity', '1')
    await expect(page.locator('.gate-title')).toHaveCSS('opacity', '1')
    await expect(page.locator('header')).toHaveAttribute('inert', '')
    await expect(page.getByRole('button', { name: /open match desk/i })).toBeVisible()
    await page.locator('#gateGoogle').click()
    await expect(page.locator('#gateNote')).toContainText('Clerk failed to load')
    await page.getByRole('button', { name: /enter as guest/i }).click()
    await expect(page.locator('#gate')).toHaveClass(/hidden/)

    await page.evaluate(() => localStorage.setItem('foresight_entered', '1'))
    await page.reload()
    await expect(page.locator('#gate')).toBeVisible()
    await page.locator('#gateEnter').click()
    await expect(page.locator('#gate')).toHaveClass(/hidden/)
    await expect(page.locator('header')).not.toHaveAttribute('inert', '')
    const headerSignIn = page.locator('#googleLoginBtn')
    await headerSignIn.click()
    await expect(page.locator('#modal')).toHaveAttribute('aria-hidden', 'false')
    await expect(page.locator('#modalbox')).toContainText('Google + Solana sign-in is live on the landing gate')
    await page.keyboard.press('Escape')
    await expect(page.locator('#modal')).toHaveAttribute('aria-hidden', 'true')
    await expect(headerSignIn).toBeFocused()
  })

  test('market terminal, fixture selection, replay speed, chart crosshair, and external links work', async ({ page }) => {
    await openDemo(page)
    const openingMatch = await page.locator('#fixture').textContent()

    await page.locator('#viewTable').click()
    await expect(page.locator('#viewTable')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#radar table.mkt tbody tr')).toHaveCount(4)
    await page.locator('#radar .mkt-select').nth(1).click()
    await expect.poll(() => page.locator('#fixture').textContent()).not.toBe(openingMatch)

    await page.locator('#viewTiles').click()
    await expect(page.locator('#viewTiles')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#radar .tile')).toHaveCount(4)
    await expect(page.locator('#polyBtn')).toHaveAttribute('href', /^https:\/\/polymarket\.com\/search\?/)
    await page.locator('.pick[data-pick="part2"]').click()
    await expect(page.locator('#polyBtn')).toHaveAttribute('href', /win/)

    await page.locator('#speed').selectOption('16')
    await page.locator('#run').click()
    await expect(page.locator('#run')).toContainText('PLAYING · PRACTICE REPLAY ×16')
    await expect.poll(() => page.locator('#sClock').textContent()).not.toBe("0'")
    await page.locator('#instant').click()
    await expect(page.locator('#sSettled')).toContainText('4/4')

    const canvas = page.locator('#cv')
    await canvas.scrollIntoViewIfNeeded()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.locator('#cvTip')).toBeVisible()
    await expect(page.locator('#cvTip')).toContainText('%')
    await page.mouse.move(1, 1)
    await expect(page.locator('#cvTip')).toBeHidden()

    await expect(page.locator('#compareLink')).toHaveAttribute('target', '_blank')
    await expect(page.locator('#compareLink')).toHaveAttribute('rel', 'noopener')
  })

  test('news/X tabs, leaderboard filters, event filters, disclosures, and relay allowlist respond', async ({ page }) => {
    await page.route('https://platform.x.com/widgets.js', route => route.abort())
    await openDemo(page)
    await page.locator('#instant').click()

    await page.getByRole('tab', { name: /x pulse/i }).click()
    await expect(page.locator('#xPanel')).toBeVisible()
    await expect(page.locator('#intelStatus')).toContainText('X embed blocked')
    await expect(page.locator('#xMatchLink')).toHaveAttribute('target', '_blank')
    await expect(page.locator('#xMatchLink')).toHaveAttribute('rel', 'noopener')
    await page.getByRole('tab', { name: /^news$/i }).click()
    await expect(page.locator('#newsPanel')).toBeVisible()
    await expect(page.locator('#newsList .news-item')).toHaveCount(3)

    await page.locator('#bfilter [data-f="human"]').click()
    await expect(page.locator('#board .prophet')).toHaveCount(2)
    await expect(page.locator('#board')).toContainText('👤 human')
    await page.locator('#bfilter [data-f="agent"]').click()
    await expect.poll(() => page.locator('#board .prophet').count()).toBeGreaterThan(2)
    await expect(page.locator('#board')).toContainText(/rule|prompt|API algo/)
    await page.locator('#bfilter [data-f="all"]').click()

    await page.locator('[data-event-filter="attack"]').click()
    await expect(page.locator('[data-event-filter="attack"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#matchTimeline')).toContainText(/Shot|Goal/)
    await page.locator('[data-event-filter="discipline"]').click()
    await expect(page.locator('#matchTimeline')).toContainText(/Card|VAR/)

    const commitInfoButton = page.getByRole('button', { name: /how commits work/i })
    await commitInfoButton.click()
    await expect(commitInfoButton).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#commitInfo')).toHaveClass(/open/)
    const leagueInfoButton = page.getByRole('button', { name: /how the league works/i })
    await leagueInfoButton.click()
    await expect(page.locator('#leagueInfo')).toHaveClass(/open/)
    const footerInfoButton = page.getByRole('button', { name: /real data, the five trust layers/i })
    await footerInfoButton.click()
    await expect(page.locator('#footerInfo')).toHaveClass(/open/)

    await page.locator('#liveCtl summary').click()
    await expect(page.locator('#liveStatus')).toContainText(/relay.*ready/i)
    await page.locator('#relayUrl').fill('https://evil.example')
    await page.locator('#relayUrl').dispatchEvent('change')
    await expect(page.locator('#relayUrl')).toHaveValue(relayBase)
    await expect(page.locator('#toasts')).toContainText('Relay URL blocked')
  })

  test('demo wallet fallback, proof recompute, and accessible share-card download complete', async ({ page }) => {
    await openDemo(page)

    await expect(page.locator('#walletBtn')).toContainText('USE DEMO WALLET')
    await page.locator('#walletBtn').click()
    await expect(page.locator('#modal')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('#walletBtn')).toContainText('DEMO WALLET · LOCAL')
    await expect(page.locator('#identityState')).toContainText('practice local · no signature')
    await expect(page.locator('#toasts')).toContainText('no extension, signature, funds, or on-chain transaction')

    await page.locator('.pick[data-pick="draw"]').click()
    await page.locator('#commitBtn').click()
    await page.locator('#instant').click()
    const share = page.getByRole('button', { name: /download share card/i })
    await expect(share).toBeVisible()
    const downloadPromise = page.waitForEvent('download')
    await share.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^foresight-receipt-.+\.png$/)

    await page.locator('#anchorCard summary').click()
    await expect(page.locator('#anchorCard')).toHaveAttribute('open', '')
    await page.locator('#anchorVerify').click()
    await expect(page.locator('#anchorVerifyOut')).toContainText('MATCHES the bundled artifact hash')
    await expect(page.locator('#anchorBody a[target="_blank"]')).not.toHaveCount(0)
    for (const link of await page.locator('#anchorBody a[target="_blank"]').all()) {
      await expect(link).toHaveAttribute('rel', 'noopener')
    }
  })

  test('standard mode still explains the real Phantom requirement when no provider exists', async ({ page }) => {
    await page.goto(`/?nogate=1&relay=${encodeURIComponent(relayBase)}`)
    await page.locator('#walletBtn').click()
    await expect(page.locator('#modalbox')).toContainText('No compatible Solana wallet is exposed to this browser')
    await expect(page.locator('#modalbox')).toContainText('same extension-enabled Chrome, Brave, or Edge profile')
  })
})
