import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

test.describe('mobile and keyboard access', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('cinematic landing stays focused and fits a 390px viewport', async ({ page }) => {
    await page.goto('/?acceptance=gate')
    await expect(page.locator('#gate')).toBeVisible()
    await expect(page.locator('.gate-visual')).toBeHidden()
    await expect(page.locator('#gateEnter')).toBeVisible()
    await expect(page.locator('header')).toHaveAttribute('inert', '')
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      gateWidth: document.querySelector('#gate')?.scrollWidth || 0,
    }))
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.clientWidth)
    expect(dimensions.gateWidth).toBeLessThanOrEqual(dimensions.clientWidth)
    await page.locator('#gateEnter').click()
    await expect(page.locator('#gate')).toHaveClass(/hidden/)
    await expect(page.locator('.workspace-nav a').first()).toBeFocused()
  })

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
    const demoSteps = await page.locator('#demoRail .demo-nav').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect()
      return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth }
    }))
    expect(demoSteps).toHaveLength(4)
    for (const step of demoSteps) {
      expect(step.left).toBeGreaterThanOrEqual(0)
      expect(step.right).toBeLessThanOrEqual(step.viewport)
    }
    await page.locator('#instant').click()
    await expect(page.locator('#compareRows .compare-row')).toHaveCount(3)
    await expect(page.locator('#matchTimeline .timeline-event').first()).toBeVisible()
    const keyPanels = await page.locator('#marketCompareCard, #timelineCard, #intelCard').evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth }
      }))
    for (const panel of keyPanels) {
      expect(panel.left).toBeGreaterThanOrEqual(0)
      expect(panel.right).toBeLessThanOrEqual(panel.viewport)
    }
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

  test('workspace keyboard shortcuts open and focus proof surfaces', async ({ page }) => {
    await openDemo(page)
    await page.keyboard.press('Alt+5')
    const anchor = page.locator('#anchorCard')
    await expect(anchor).toHaveAttribute('open', '')
    await expect(anchor).toBeFocused()
  })
})
