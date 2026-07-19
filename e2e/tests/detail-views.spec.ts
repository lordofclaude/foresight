import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

test.describe('dashboard detail views', () => {
  test('leaderboard opens full standings, filters agents, inspects a profile, and supports browser back', async ({ page }) => {
    await openDemo(page)

    await page.locator('#leaderboardOpen').click()
    await expect(page).toHaveURL(/view=leaderboard/)
    await expect(page.locator('#detailView')).toBeVisible()
    await expect(page.locator('#detailTitle')).toHaveText('Leaderboard')
    await expect(page.locator('#detailLeaderboardRows .detail-table-row')).toHaveCount(9)

    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(page.locator('#detailLeaderboardRows .detail-table-row')).toHaveCount(7)
    await page.locator('[data-detail-profile]').first().click()
    await expect(page.locator('#modal')).toHaveAttribute('aria-hidden', 'false')
    await expect(page.locator('#modalbox')).toContainText('@blackbox-7')
    await expect(page.locator('#modalbox')).toContainText('shrunk score')
    await page.getByRole('button', { name: /close/i }).click()

    await page.goBack()
    await expect(page.locator('#detailView')).toBeHidden()
    await expect(page.locator('main')).toBeVisible()
  })

  test('news opens a richer source page and can switch the selected fixture', async ({ page }) => {
    await openDemo(page)
    await expect(page.locator('#newsList .news-item')).toHaveCount(3)

    await page.locator('#newsOpen').click()
    await expect(page.locator('#detailTitle')).toHaveText('News desk')
    await expect(page.locator('#detailNewsList .detail-news-item')).toHaveCount(3)
    await expect(page.locator('#detailNewsList .detail-news-item').first()).toHaveAttribute('target', '_blank')
    await expect(page.locator('#detailBody')).toContainText('context—not proof')

    await page.locator('[data-detail-fixture="0"]').click()
    await expect(page.locator('#detailBody .detail-toolbar h3')).toHaveText('Argentina vs Switzerland')
    await page.locator('#detailBack').click()
    await expect(page.locator('#detailView')).toBeHidden()
  })

  test('portfolio chart opens from the summary canvas and lists receipt economics', async ({ page }) => {
    await openDemo(page)
    await page.locator('.pick[data-pick="part1"]').click()
    await page.locator('#commitBtn').click()

    await page.locator('#pfSpark').focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/view=portfolio/)
    await expect(page.locator('#detailTitle')).toHaveText('Portfolio')
    await expect(page.locator('#portfolioDetailChart')).toBeVisible()
    await expect(page.locator('#detailPortfolioRows .detail-table-row')).toHaveCount(1)
    await expect(page.locator('#detailBody')).toContainText('Entry price is sealed')
    await expect(page.locator('#detailBody')).toContainText('LOCAL')

    await page.locator('#detailMakeCall').click()
    await expect(page.locator('#detailView')).toBeHidden()
    await expect(page.locator('#commitCard')).toBeVisible()
  })

  test('a direct detail URL closes cleanly and stays within a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openDemo(page, '&view=news')

    await expect(page.locator('#detailView')).toBeVisible()
    await expect(page.locator('#detailTitle')).toHaveText('News desk')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await page.locator('#detailBack').click()
    await expect(page).not.toHaveURL(/view=news/)
    await expect(page.locator('main')).toBeVisible()
  })
})
