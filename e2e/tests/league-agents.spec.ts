import { expect, test, type Page } from '@playwright/test'
import { openDemo } from './helpers'

async function headlineStats(page: Page) {
  return {
    picks: await page.locator('#sPicks').textContent(),
    commits: await page.locator('#sCommits').textContent(),
    portfolio: await page.locator('#pfTotal').textContent(),
  }
}

test.describe('trader follows and agent creation', () => {
  test('follow lifecycle is a receipt-alert watchlist and never copies a position', async ({ page }) => {
    await openDemo(page)
    const before = await headlineStats(page)

    await page.locator('#board .prophet').first().click()
    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · UNFOLLOWED')
    await page.getByRole('button', { name: /follow verified receipt alerts/i }).click()
    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · REQUESTED')
    await page.getByRole('button', { name: /activate requested alerts/i }).click()
    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · ACTIVE')
    await page.getByRole('button', { name: /pause receipt alerts/i }).click()
    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · PAUSED')
    await page.getByRole('button', { name: /resume receipt alerts/i }).click()
    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · ACTIVE')
    await page.getByRole('button', { name: /^unfollow$/i }).click()

    await expect(page.locator('#modalbox')).toContainText('Receipt-alert watchlist · UNFOLLOWED')
    await expect(page.locator('#modalbox')).toContainText('LOCAL DEMO · NOT PERSISTED')
    await expect(page.locator('#modalbox')).toContainText('No execution, custody, automatic bets, portfolio copying, or paid access')
    await expect.poll(() => headlineStats(page)).toEqual(before)

    const marketLink = page.locator('#modalbox a.poly-btn')
    await expect(marketLink).toHaveAttribute('target', '_blank')
    await expect(marketLink).toHaveAttribute('rel', 'noopener')
    await expect(marketLink).toHaveAttribute('href', /^https:\/\/polymarket\.com\/search\?/)
  })

  test('rule builder validates names, deploys, backtests, and exposes the new profile', async ({ page }) => {
    await openDemo(page)
    await page.locator('#buildAgentBtn').click()

    await page.locator('#abName').fill('@<unsafe>')
    await page.locator('#abDeploy').click()
    await expect(page.locator('#toasts')).toContainText('agent name must be')
    await expect(page.locator('#abName')).toBeFocused()

    await page.locator('#abName').fill('@chalk')
    await page.locator('#abDeploy').click()
    await expect(page.locator('#toasts')).toContainText('already exists')

    await page.locator('#abName').fill('@accept-rule')
    await page.locator('#abCond').selectOption('kickoff')
    await page.locator('#abBet').selectOption('fav')
    await expect(page.locator('#abPreview')).toContainText('"kickoff"')
    await expect(page.locator('#abPreview')).toContainText('visibility: public')
    await page.locator('#abDeploy').click()

    await expect(page.locator('#toasts')).toContainText('@accept-rule deployed — backtested on 4 fixtures')
    await expect(page.locator('#modalbox')).toContainText('@accept-rule')
    await expect(page.locator('#modalbox')).toContainText(/rule agent.*public/i)
    await expect(page.locator('#modalbox')).toContainText('strategy:')
    await expect(page.locator('#board .prophet.fresh')).toContainText('@accept-rule')
    await expect(page.locator('#board .prophet.fresh')).toBeVisible()
  })

  test('prompt builder rejects unsupported signals and deploys a private compiled strategy', async ({ page }) => {
    await openDemo(page)
    await page.locator('#buildAgentBtn').click()
    await page.getByRole('tab', { name: /prompt/i }).click()

    await page.locator('#abPrompt').fill('when Messi comes on, back Argentina')
    await expect(page.locator('#abPreview')).toContainText("TxLINE doesn't provide")
    await expect(page.locator('#abDeploy')).toBeDisabled()

    await page.locator('#abPrompt').fill('when a team is 2 goals up after 80 minutes, back them')
    await expect(page.locator('#abDeploy')).toBeEnabled()
    await page.locator('#abName').fill('@accept-prompt')
    await page.locator('#abPriv').click()
    await expect(page.locator('#abPriv')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#abPreview')).toContainText('visibility: private')
    await page.locator('#abDeploy').click()

    await expect(page.locator('#toasts')).toContainText('@accept-prompt deployed — backtested on 4 fixtures')
    await expect(page.locator('#modalbox')).toContainText('@accept-prompt')
    await expect(page.locator('#modalbox')).toContainText(/prompt agent.*private/i)
    await expect(page.locator('#modalbox')).toContainText('strategy is private')
    await expect(page.locator('#modalbox')).not.toContainText('when a team is 2 goals up')
    await expect(page.locator('#board .prophet.fresh')).toContainText('@accept-prompt')
  })

  test('API builder matches the implemented signed-ingest contract and stays an honest local stand-in', async ({ page }) => {
    await openDemo(page)
    await page.locator('#buildAgentBtn').click()
    await page.getByRole('tab', { name: /external api/i }).click()

    await expect(page.locator('#abBody')).toContainText('POST /v1/agent-commits')
    await expect(page.locator('#abBody')).toContainText('FORESIGHT_AGENT_COMMIT_V1')
    await expect(page.locator('#abBody')).toContainText('IMPLEMENTED · NOT DEPLOYED')
    await expect(page.locator('#abBody')).toContainText('never executes a trade')
    await expect(page.locator('#abPub')).toBeDisabled()
    await expect(page.locator('#abPriv')).toBeDisabled()
    await expect(page.locator('#abPriv')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#abPreview')).toContainText('external API agent (local stand-in for the demo)')

    await page.locator('#abName').fill('@accept-api')
    await page.locator('#abDeploy').click()
    await expect(page.locator('#toasts')).toContainText('@accept-api deployed — backtested on 4 fixtures')
    await expect(page.locator('#modalbox')).toContainText('@accept-api')
    await expect(page.locator('#modalbox')).toContainText(/external algo \/ ML via API.*black box/i)
    await expect(page.locator('#modalbox')).toContainText('strategy is private')
    await expect(page.locator('#board .prophet.fresh')).toContainText('@accept-api')
  })
})
