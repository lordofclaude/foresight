import { expect, test } from '@playwright/test'
import { openDemo, relayBase } from './helpers'

test.describe('guest demo golden path', () => {
  test('autoplay=0 keeps deterministic tests paused at the opening historical frame', async ({ page }) => {
    await openDemo(page)

    await expect(page.locator('#gate')).toHaveClass(/hidden/)
    await expect(page.locator('#demoRail')).toBeVisible()
    await expect(page.locator('#run')).toContainText('RUN REPLAY')
    await expect(page.locator('#globalModeCopy')).toContainText('Historical')

    await page.waitForTimeout(600)
    await expect(page.locator('#sClock')).toHaveText("0'")
  })

  test('guided demo autoplays the historical probability tape at a true 30×', async ({ page }) => {
    await page.goto(`/?demo=1&e2e_auth=1&relay=${encodeURIComponent(relayBase)}`)
    await expect(page.locator('#gate')).toHaveClass(/hidden/)
    await expect(page.locator('#speed')).toHaveValue('30')
    await expect(page.locator('#run')).toContainText('PLAYING · PRACTICE REPLAY ×30')
    const openingSummary = await page.locator('#chartSummaryText').textContent()

    await expect.poll(() => page.locator('#sClock').textContent(), { timeout: 5_000 }).not.toBe("0'")
    await expect.poll(() => page.locator('#chartSummaryText').textContent()).not.toBe(openingSummary)
    await expect(page.locator('#chartSummaryText')).toContainText(/practice [1-9]\d*'/)
  })

  test('commit, verify, reject a forgery, and settle instantly', async ({ page }) => {
    await openDemo(page)

    const draw = page.locator('.pick[data-pick="draw"]')
    await draw.click()
    await expect(draw).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#commitBtn')).toBeEnabled()
    await page.locator('#commitBtn').click()

    await expect(page.locator('#sPicks')).toHaveText('1')
    await expect(page.locator('#mycommits .commitrow')).toHaveCount(1)
    await expect(page.locator('#verifyBtn')).toBeEnabled()

    await page.locator('#verifyBtn').click()
    await expect(page.locator('#verifyOut')).toContainText('commitment verifies')
    await expect(page.locator('#verifyOut')).toContainText('MATCH')
    await expect(page.locator('#verifyOut')).toContainText('local integrity passes')

    await page.locator('#forgeBtn').click()
    await expect(page.locator('#verifyOut')).toContainText('forgery rejected')
    await expect(page.locator('#verifyOut')).toContainText('NO COMMITMENT FOUND')

    await page.locator('#instant').click()
    await expect(page.locator('#sSettled')).toContainText('4/4')
    await expect(page.locator('#mycommits .commitrow')).toContainText('GRADED')
  })

  test('practice commits are deliberately ephemeral across reloads', async ({ page }) => {
    await openDemo(page)
    await page.locator('.pick[data-pick="part1"]').click()
    await page.locator('#commitBtn').click()
    await expect(page.locator('#sPicks')).toHaveText('1')

    await page.reload()
    await expect(page.locator('#sClock')).toHaveText("0'")
    await expect(page.locator('#sPicks')).toHaveText('0')
    await expect(page.locator('#mycommits .commitrow')).toHaveCount(0)
  })

  test('shows aligned market divergence, headlines, and a rich match timeline', async ({ page }) => {
    await openDemo(page)

    await expect(page.locator('#compareRows .compare-row')).toHaveCount(3)
    await expect(page.locator('#compareThesis')).toContainText('largest disagreement')
    await expect(page.locator('#compareStatus')).toContainText('timestamp aligned')
    await expect(page.locator('#newsList .news-item')).toHaveCount(3)
    const openingQuoteTime = await page.locator('#compareFreshness').textContent()

    await page.locator('#instant').click()
    await expect.poll(() => page.locator('#compareFreshness').textContent()).not.toBe(openingQuoteTime)
    await expect(page.locator('#compareStatus')).toContainText('timestamp aligned')
    await expect(page.locator('#matchTimeline')).toContainText('Shot')
    await expect(page.locator('#matchTimeline')).toContainText('Corner')
    await expect(page.locator('#matchTimeline')).toContainText('Goal')
    await expect(page.locator('#timelineMore')).toBeVisible()
    await page.locator('#timelineMore').click()
    await expect.poll(() => page.locator('#matchTimeline .timeline-event').count()).toBeGreaterThan(40)
    await page.locator('[data-event-filter="setpiece"]').click()
    await expect(page.locator('#matchTimeline')).toContainText(/Corner|Free kick|Penalty/)
  })
})
