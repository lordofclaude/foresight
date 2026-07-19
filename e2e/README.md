# Foresight browser E2E

This standalone Playwright suite serves the parent static app without changing
its package or source files. Local practice tests are deterministic and require
no secrets. Relay frames and Solana behavior come from fixtures explicitly labeled
as mocks; they never contact a wallet, Solana RPC, or TxLINE.

## Success criteria

- `?demo=1` selects guided replay mode; tests add a localhost-only `e2e_auth=1`
  seam to bypass OAuth. Production hosts ignore that seam and remain locked.
- Guest commit → verify → forgery rejection → instant grading works.
- A reload discards local practice history, matching the product's truth label.
- 390×844 has no horizontal overflow and pick buttons work by keyboard.
- Live status stays CONNECTING until a mocked frame, then reports LIVE/STALE.
- Explicit Solana provider/RPC test doubles cover rejection, pending, and
  confirmation without faking a production wallet result.
- Clerk specs use `@clerk/testing`, project-based `clerkSetup`, and call
  `setupClerkTestingToken()` before auth navigation. They skip with a precise
  reason unless every required development credential is available.

## Run

```powershell
cd C:\Users\lordo\Desktop\Foresight\e2e
npm ci
npx playwright install chromium
npm run test:guest
```

Optional Clerk coverage requires test/development credentials only:

```powershell
$env:CLERK_PUBLISHABLE_KEY='pk_test_...'
$env:CLERK_SECRET_KEY='sk_test_...'
$env:CLERK_TESTING_TOKEN='...'
$env:E2E_CLERK_USER_EMAIL='existing-test-user@example.com' # session spec only
npm run test:auth
```

Production Clerk keys are deliberately rejected. The first auth spec opens the
real Clerk component but does not automate Google OAuth or claim an auth success.
The session spec uses Clerk's server-side test helper for an existing development
user and then verifies the app's real reload/session restoration path.

Current Clerk setup reference:
<https://clerk.com/docs/guides/development/testing/playwright/overview>
