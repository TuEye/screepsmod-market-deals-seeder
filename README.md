# screepsmod-market-deals-seeder
Seeds synthetic market deals to bootstrap and maintain market history on Screeps private servers.

## What it does
This mod inserts synthetic `market.sell` deals into `users.money` using average prices from
active `market.orders`. It helps new or low-activity private servers provide usable market
history to scripts that rely on `Game.market.getHistory()`.

The mod runs as a Screeps backend cronjob, so it is registered only once even though Screeps
loads mods in multiple server processes.

## Install
```bash
npm install screepsmod-market-deals-seeder
```

## Enable in Screeps server
Add the mod to your server config (example `config.json`):
```json
{
  "mods": [
    "screepsmod-market-deals-seeder"
  ]
}
```

If you keep it locally, you can also use a relative or absolute path in `mods`.

## Configuration
The mod has built-in defaults and works without a configuration file.

To customize it, copy `marketDealsSeederConfig.example.js` to the Screeps server working
directory as `marketDealsSeederConfig.js` and edit the values there.

Configuration priority is:

1. Built-in defaults
2. `marketDealsSeederConfig.js`
3. Environment variables

Environment variables therefore override values from the configuration file.

### Defaults
```js
module.exports = {
  mode: 'maintain',
  days: 14,
  minDealsPerDay: 10,
  amountPerDeal: 1000,
  intervalHours: 12,
  countAllDeals: true,
  blacklist: []
};
```

### Modes
- `maintain` (default): periodically checks the configured history window and fills missing daily deals.
- `bootstrap`: seeds the history once and stores a persistent completion marker in Screeps storage. Server restarts do not repeat a completed bootstrap.
- `off`: disables the seeder.

### Environment variables
- `MARKET_SEED_MODE`
- `MARKET_SEED_DAYS`
- `MARKET_SEED_MIN_DEALS_PER_DAY`
- `MARKET_SEED_AMOUNT_PER_DEAL`
- `MARKET_SEED_INTERVAL_HOURS`
- `MARKET_SEED_COUNT_ALL_DEALS`
- `MARKET_SEED_BLACKLIST` (comma-separated resource list)

Example:
```bash
MARKET_SEED_MODE=maintain \
MARKET_SEED_DAYS=14 \
MARKET_SEED_BLACKLIST=energy,G \
node ...
```

## How daily maintenance works
The seeder reads existing `market.sell` records for the complete configured history window in
one database query and groups them by resource and local calendar day in memory. This retains
the per-day minimum logic without issuing a separate database count query for every resource
and every day.

By default, both real and previously seeded deals count toward `minDealsPerDay`. If a day already
contains enough real activity, no synthetic deals are added for that resource and day.

Synthetic timestamps are generated between 10:00 and 18:00 local server time to keep them away
from day boundaries. On the current day, timestamps are never generated in the future.

## Notes
- Synthetic deals are tagged with `__seededBy: 'market-deals-seed'`.
- `amountPerDeal` remains 1000 by default so seeded history has meaningful trade volume for scripts that use `Game.market.getHistory().volume`.
- Price calculation currently uses the average price of active market orders. More robust order-book pricing may be added later.
- A bootstrap completion marker is written only after a successful bootstrap with usable active market orders.

## Publishing
Publish to npmjs with `npm publish`.
