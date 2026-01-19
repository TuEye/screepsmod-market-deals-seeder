# screepsmod-market-deals-seeder
Seeds synthetic market deals to bootstrap market history on Screeps private servers.

## What it does
This mod inserts synthetic `market.sell` deals into `users.money` using average prices from
active `market.orders`. It helps new private servers show a market history immediately.

## Install
```bash
npm install @TuEye/screepsmod-market-deals-seeder
```

## Enable in Screeps server
Add the mod to your server config (example `config.json`):
```json
{
  "mods": [
    "@TuEye/screepsmod-market-deals-seeder"
  ]
}
```

If you keep it locally, you can also use a relative or absolute path in `mods`.

## Configuration
All settings are inside `market-deals-seed.js` and can be edited directly.
The mod entry point is `module.exports = function(config)` and uses
`config.common.storage.db`.

Defaults:
- `DAYS` = 14
- `MIN_DEALS_PER_DAY` = 10
- `AMOUNT_PER_DEAL` = 1000
- `SEED_TAG` = `market-deals-seed`
- `USER_ID` = `system`
- `RUN_EVERY_MS` = 12 hours
- `PRICE_SCALE` = 1000 (use 1 if your orders are full credits)
- `COUNT_ALL_DEALS` = true (count real + seeded deals)

Environment:
- `MARKET_SEED_BLACKLIST` = comma separated list of resources to exclude

## Notes
- The mod waits for `market.orders` and `users.money` to exist before seeding.
- It runs once at startup and then periodically.

## Publishing to GitHub Packages
Update `package.json` with your GitHub scope (replace `@TuEye`).
Then push a release; the workflow publishes the package to GitHub Packages.
