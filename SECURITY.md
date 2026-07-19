# Security

## Reporting a vulnerability

Use the repository's private GitHub vulnerability-reporting channel when it is available. If it is not available, open an issue that asks the maintainers for a private contact method without including exploit details, credentials, wallet keys, or personal data.

Only the latest version on the default branch and its current production deployment are supported.

## Deployment expectations

- Keep TxLINE credentials, wallet keys, Clerk secrets, and all `.env*` files out of source control and browser-delivered assets.
- Treat the relay as the server-side trust boundary: validate request inputs and keep privileged credentials there.
- Apply durable, shared rate limiting before exposing the relay to sustained public traffic; in-memory limits do not protect across instances or restarts.
- Self-host remote scripts or pin them with Subresource Integrity where the provider supports stable versioned assets.
- A Content Security Policy is intentionally not enabled yet because the current app uses inline and third-party runtime scripts. Inventory and remove inline script dependencies before introducing and testing a restrictive policy.
