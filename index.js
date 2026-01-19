'use strict';

module.exports = function(config) {
  const db = config && config.common && config.common.storage && config.common.storage.db;
  if (!db) {
    console.log('[market-deals-seed] ERROR: config.common.storage.db not available');
    return;
  }

  // ---- Settings ----
  var DAYS = 14;
  var MIN_DEALS_PER_DAY = 10;
  var AMOUNT_PER_DEAL = 1000;
  var SEED_TAG = 'market-deals-seed';
  var USER_ID = 'system'; // not a real player
  var RUN_EVERY_MS = 12 * 60 * 60 * 1000; // 12h
  var PRICE_SCALE = 1000; // if Orders are milli-Credits
  var COUNT_ALL_DEALS = true; // Default: all deals (real + seeded) count
  // Resources that are NOT seeded (default: empty) e.g. ['energy', 'G', 'X']
  var BLACKLIST = (process.env.MARKET_SEED_BLACKLIST || '')
      .split(',')
      .map(function(s){ return s.trim(); })
      .filter(Boolean);

  function dayWindowLocal(daysAgo) {
      var now = new Date();
      var base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 0, 0, 0, 0);
      var start = new Date(base.getTime()); start.setHours(10,0,0,0);
      var end   = new Date(base.getTime()); end.setHours(18,0,0,0);
      return { start: start, end: end };
    }

  function randomDateBetween(start, end) {
    var t = start.getTime() + Math.floor(Math.random() * (end.getTime() - start.getTime() + 1));
    return new Date(t);
  }

  function safeNumber(n, fallback) {
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function hasCollections() {
    return !!(db && db['market.orders'] && db['users.money']);
  }

  async function calcAvgPricesFromOrders() {
    if (!db['market.orders']) return {};

    var orders = await db['market.orders'].find({ active: true }).catch(function() { return []; });
    var mp = {}; // rt -> [prices]

    (orders || []).forEach(function(o) {
      if (!o || !o.resourceType) return;
      var p = o.price;
      if (typeof p !== 'number' || !isFinite(p)) return;
      if (!mp[o.resourceType]) mp[o.resourceType] = [];
      mp[o.resourceType].push(p);
    });

    var avg = {};
    Object.keys(mp).forEach(function(rt) {
      var arr = mp[rt];
      if (!arr || !arr.length) return;
      var sum = arr.reduce(function(a, b) { return a + b; }, 0);
      avg[rt] = sum / arr.length;
    });

    return avg;
  }

  async function countDeals(rt, start, end) {
    if (!db['users.money']) return 0;

    var andParts = [
      { type: 'market.sell' },
      { 'market.resourceType': rt },
      { date: { $gte: start, $lte: end } }
    ];

    // If NOT all deals are to be counted, only count our seeded ones.
    if (!COUNT_ALL_DEALS) {
      andParts.push({ __seededBy: SEED_TAG });
    }

    var docs = await db['users.money'].find({ $and: andParts }).catch(function() { return []; });
    return (docs || []).length;
  }

  async function insertSeedDeal(rt, avgPrice, start, end) {
    var jitter = 1 + ((Math.random() - 0.5) * 0.10); // +/-5%
    var raw = safeNumber(avgPrice, 1);
    var price = (raw / PRICE_SCALE) * jitter;
    var amount = AMOUNT_PER_DEAL;

    var doc = {
      user: USER_ID,
      type: 'market.sell',
      date: randomDateBetween(start, end),
      change: amount * price, // Credits inflow
      market: {
        resourceType: rt,
        amount: amount,
        price: price
      },
      __seededBy: SEED_TAG
    };

    return db['users.money'].insert(doc);
  }

  async function seedOnce() {
    var avgPrices = await calcAvgPricesFromOrders();
    var rts = Object.keys(avgPrices);

    if (BLACKLIST && BLACKLIST.length) {
      rts = rts.filter(function(rt) { return BLACKLIST.indexOf(rt) === -1; });
    }
      
    if (!rts.length) {
      console.log('[market-deals-seed] No avg prices found from active orders; nothing to seed.');
      return { resources: 0, inserted: 0 };
    }

    var inserted = 0;

    for (var ri = 0; ri < rts.length; ri++) {
      var rt = rts[ri];
      var avg = avgPrices[rt];

      for (var d = 0; d < DAYS; d++) {
        var range = dayWindowLocal(d);
        var have = await countDeals(rt, range.start, range.end);
        var need = Math.max(0, MIN_DEALS_PER_DAY - have);

        for (var k = 0; k < need; k++) {
          await insertSeedDeal(rt, avg, range.start, range.end);
          inserted++;
        }
      }
    }

    console.log('[market-deals-seed] Done. resources=' + rts.length + ' inserted=' + inserted);
    return { resources: rts.length, inserted: inserted };
  }

  function runWithRetry(attempt) {
    attempt = attempt || 1;

    if (!hasCollections()) {
      if (attempt === 1) {
        console.log('[market-deals-seed] waiting for collections: market.orders / users.money ...');
      }
      if (attempt <= 60) {
        return setTimeout(function() { runWithRetry(attempt + 1); }, 1000);
      }
      console.log('[market-deals-seed] giving up after 60s; collections still not ready');
      return;
    }

    seedOnce()
      .then(function(r) { console.log('[market-deals-seed] startup seed ok', r); })
      .catch(function(e) { console.log('[market-deals-seed] ERROR (startup seed)', e); });

    // Periodically retrigger (if another job regularly recalculates/trims the stats)
    setInterval(function() {
      seedOnce().catch(function(e) { console.log('[market-deals-seed] ERROR (periodic seed)', e); });
    }, RUN_EVERY_MS);

    console.log('[market-deals-seed] periodic seeding scheduled every ' + (RUN_EVERY_MS/3600000) + 'h');
  }

  // Start
  runWithRetry(1);
};
