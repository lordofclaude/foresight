import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

test.describe('mobile and keyboard access', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('mobile layout does not overflow the viewport', async ({ page }) => {
    await openDemo(page)
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }))
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
    expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
    await expect(page.locator('#walletBtn')).toBeVisible()
    await expect(page.locator('#commitCard')).toBeVisible()
  })

  test('prediction choices work with the keyboard', async ({ page }) => {
    await openDemo(page)
    const home = page.locator('.pick[data-pick="part1"]')
    await home.focus()
    await expect(home).toBeFocused()
    await page.keyboard.press('Space')
    await expect(home).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#commitBtn')).toBeEnabled()
  })
})
