import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright'
import { expect, test } from '@playwright/test'
import { clerkSkipReason } from '../helpers'

test.beforeEach(async ({ page }) => {
  const reason = clerkSkipReason()
  test.skip(Boolean(reason), reason || '')

  // Must happen before the first navigation to any Clerk auth surface.
  await setupClerkTestingToken({ page })
})

test('loads the real Clerk callback/sign-in surface with a testing token', async ({ page }) => {
  await page.goto('/')
  await page.locator('#gateGoogle').click()
  await clerk.loaded({ page })
  await expect(page.locator('[data-clerk-component]').first()).toBeVisible()
})

test('restores a real Clerk test session after reload', async ({ page }) => {
  const emailAddress = process.env.E2E_CLERK_USER_EMAIL
  test.skip(!emailAddress, 'Clerk session E2E skipped: missing E2E_CLERK_USER_EMAIL')

  await page.goto('/')
  await clerk.loaded({ page })
  await clerk.signIn({ page, emailAddress })
  await expect(page.locator('#gate')).toHaveClass(/hidden/)

  await page.reload()
  await expect(page.locator('#gate')).toHaveClass(/hidden/)
  await expect(page.locator('#identityState')).toHaveAttribute('data-state', 'ACCOUNT_ONLY')
  await expect(page.locator('#identityState')).toContainText('Clerk session')
})
