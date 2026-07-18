# _keys/

Put your own Solana **devnet** keypair here as `wallet.json` (the standard
`solana-keygen` output format — a JSON array of 64 bytes) to run
`anchor-commit.js` or `verify-wallet-flow.js` from the command line.

This is only needed for those two CLI proof scripts. **The live app itself
needs none of this** — open `index.html`, click "Connect Wallet," and
Phantom (or any Solana wallet extension) signs commits directly in the
browser. Nothing here, nothing committed, no key ever leaves your machine.

Generate a fresh throwaway devnet keypair if you don't have one:
```bash
solana-keygen new --outfile _keys/wallet.json
solana airdrop 1 --url devnet $(solana-keygen pubkey _keys/wallet.json)
```

This folder is gitignored except for this file — never commit a real key.
