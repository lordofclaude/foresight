import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

test.describe('probability tape trend charts', () => {
  test('shot momentum progresses from confirmed historical events at 30x', async ({ page }) => {
    await openDemo(page)
    await page.getByRole('button', { name: /Argentina versus Switzerland/i }).click()
    await page.getByRole('tab', { name: 'Shot momentum' }).click()

    await expect(page.getByRole('tab', { name: 'Shot momentum' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#tapeTitle')).toHaveText('ARG v SWI — shot momentum')
    await expect(page.locator('#chartSummaryText')).toContainText('latest 5-minute shots 0–0')

    await page.locator('#speed').selectOption('30')
    await page.locator('#run').click()
    await expect.poll(() => page.locator('#chartSummaryText').textContent(), { timeout: 5_000 }).toMatch(/latest 5-minute shots (?!0–0)\d+–\d+/)
    await expect(page.locator('#trendReadout')).toContainText('Recent ≤10\' trend')
  })

  test('possession and pressure stay truth-labeled, switch fixtures, and support arrow keys', async ({ page }) => {
    await openDemo(page)
    await page.locator('#instant').click()

    await page.getByRole('tab', { name: 'Possession · 5m' }).click()
    await expect(page.locator('#tapeTitle')).toHaveText('ENG v ARG — possession signal')
    await expect(page.locator('#chartSummaryText')).toContainText(/TxLINE possession signal \d+–\d+%/)
    await expect(page.locator('#trendReadout')).toContainText('not an official optical time-on-ball statistic')

    await page.getByRole('tab', { name: 'Attack pressure' }).click()
    await expect(page.locator('#chartSummaryText')).toContainText('latest pressure')
    await expect(page.locator('#trendReadout')).toContainText('3× shots + 2× on-target')

    await page.getByRole('button', { name: /France versus Spain/i }).click()
    await expect(page.locator('#tapeTitle')).toHaveText('FRA v SPA — attack pressure')

    await page.getByRole('tab', { name: 'Probability' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Shot momentum' })).toHaveAttribute('aria-selected', 'true')
  })
})
