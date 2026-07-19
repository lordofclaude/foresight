import { clerkSetup } from '@clerk/testing/playwright'
import { test as setup } from '@playwright/test'
import { clerkSkipReason } from './helpers'

// Clerk requires project-based setup so CLERK_FAPI / testing-token state is
// inherited by dependent workers. A function-based globalSetup is not used.
setup.describe.configure({ mode: 'serial' })

setup('prepare Clerk development testing token', async () => {
  const reason = clerkSkipReason()
  if (reason) console.warn(reason)
  setup.skip(Boolean(reason), reason || '')
  await clerkSetup()
})
