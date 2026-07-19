# Safe TxLINE capture workflow

`shared/live-poll.js` captures current TxLINE score and 1X2 odds update windows
into the flattened deploy repository's `real-data/` directory. It is not part of
the browser or judge path.

## Safety contract

- The default command is a dry run: zero network requests and zero writes.
- A material capture needs both `--write` and
  `--yes-i-understand-this-writes-capture-files`.
- Fixture IDs must be in `FORESIGHT_CAPTURE_FIXTURES`, the explicit private
  config's `allowedFixtureIds`, or the built-in hackathon allowlist.
- Output resolves to an absolute target inside this repository's `real-data/`.
  Symlink/path escapes are rejected.
- Credentials come only from `TXLINE_JWT` + `TXLINE_API_TOKEN`, or an explicitly
  passed private config. In-repository configs are limited to the currently
  ignored `.txline.json` or `shared/.txline.json` paths.
- Credentials are used only in request headers. Tape, state, manifest, errors,
  and console output never contain them.
- Writes use a temporary file, flush it, and replace the destination. The first
  pre-capture version is retained as `<file>.bak` for recovery.
- Ctrl+C aborts the active request, cancels the poll timer, and exits cleanly.

## Usage

First inspect the exact plan:

```powershell
node shared/live-poll.js --fixture 18257865 --once
```

Then set credentials in the process environment and explicitly authorize one
capture window:

```powershell
$env:TXLINE_JWT='...'
$env:TXLINE_API_TOKEN='...'
$env:FORESIGHT_CAPTURE_FIXTURES='18257865'
node shared/live-poll.js --fixture 18257865 --once --write --yes-i-understand-this-writes-capture-files
```

For continuous capture, omit `--once`. The process automatically stops when an
accepted `game_finalised` event makes the capture final.

An explicit private config is also supported:

```powershell
Copy-Item shared/live-poll.config.example.json .txline.json
# Fill values locally. .txline.json is gitignored.
node shared/live-poll.js --fixture 18257865 --config .txline.json
```

## Outputs

For fixture `18257865`:

- `real-data/18257865.tape.js` — current browser tape shape:
  `window.TXLINE_TAPE = { fixture, historical, odds, capture }`.
- `real-data/18257865.live-state.json` — ignored resumable raw accumulator.
- `real-data/18257865.capture-manifest.json` — machine-readable provenance,
  source endpoints, observed source timestamps, counts, status, and tape hash.

Both tape and manifest say `incomplete` until `game_finalised` is actually
captured; they then say `final`. Re-running merges by score sequence/timestamp
and odds message ID, so repeated update windows remain idempotent.

Run deterministic no-network tests with:

```powershell
node test/live-poll.test.js
```
