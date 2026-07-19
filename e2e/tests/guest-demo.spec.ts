import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

test.describe('guest demo golden path', () => {
  test('demo mode skips the gate and does not autoplay', async ({ page }) => {
    await openDemo(page)

    await expect(page.locator('#gate')).toHaveClass(/hidden/)
    await expect(page.locator('#demoRail')).toBeVisible()
    await expect(page.locator('#run')).toContainText('RUN REPLAY')
    await expect(page.locator('#globalModeCopy')).toContainText('Historical')

    await page.waitForTimeout(600)
    await expect(page.locator('#sClock')).toHaveText("0'")
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
    await expect(page.locator('#sSettled')).toContainText('3/4')
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
})
