'use strict';

module.exports = function(config) {
  // Mods are loaded by multiple Screeps processes. Only the backend owns
  // cronjobs, so registering here prevents duplicate seeders from running.
  if (!config || !config.backend || !config.cronjobs) {
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

  function getDb() {
    var db = config && config.common && config.common.storage && config.common.storage.db;
    if (!db || !db['market.orders'] || !db['users.money']) {
      throw new Error('required collections market.orders / users.money are not available');
    }
    return db;
  }

  function dayRangesLocal(daysAgo) {
    var now = new Date();
    var base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 0, 0, 0, 0);

    // Count real and seeded deals across the complete calendar day.
    var countStart = new Date(base.getTime());
    var countEnd = new Date(base.getTime());
    countEnd.setHours(23, 59, 59, 999);
    if (countEnd.getTime() > now.getTime()) {
      countEnd = new Date(now.getTime());
    }

    // Keep synthetic deal timestamps in the original daytime window, but
    // never create a timestamp in the future for the current day.
    var seedStart = new Date(base.getTime());
    seedStart.setHours(10, 0, 0, 0);
    var seedEnd = new Date(base.getTime());
    seedEnd.setHours(18, 0, 0, 0);
    if (seedEnd.getTime() > now.getTime()) {
      seedEnd = new Date(now.getTime());
    }

    return {
      countStart: countStart,
      countEnd: countEnd,
      seedStart: seedStart,
      seedEnd: seedEnd
    };
  }

  function randomDateBetween(start, end) {
    var t = start.getTime() + Math.floor(Math.random() * (end.getTime() - start.getTime() + 1));
    return new Date(t);
  }

  function safeNumber(n, fallback) {
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  async function calcAvgPricesFromOrders() {
    var db = getDb();
    var orders = await db['market.orders'].find({ active: true });
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
    var db = getDb();
    var andParts = [
      { type: 'market.sell' },
      { 'market.resourceType': rt },
      { date: { $gte: start, $lte: end } }
    ];

    // If NOT all deals are to be counted, only count our seeded ones.
    if (!COUNT_ALL_DEALS) {
      andParts.push({ __seededBy: SEED_TAG });
    }

    return db['users.money'].count({ $and: andParts });
  }

  async function insertSeedDeal(rt, avgPrice, start, end) {
    var db = getDb();
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
        var range = dayRangesLocal(d);
        var have = await countDeals(rt, range.countStart, range.countEnd);
        var need = Math.max(0, MIN_DEALS_PER_DAY - have);

        // Before 10:00 on the current day there is no valid daytime seed
        // window yet. Existing deals are still counted, but nothing synthetic
        // is backdated or placed in the future.
        if (range.seedEnd.getTime() < range.seedStart.getTime()) {
          continue;
        }

        for (var k = 0; k < need; k++) {
          await insertSeedDeal(rt, avg, range.seedStart, range.seedEnd);
          inserted++;
        }
      }
    }

    console.log('[market-deals-seed] Done. resources=' + rts.length + ' inserted=' + inserted);
    return { resources: rts.length, inserted: inserted };
  }

  config.cronjobs.marketDealsSeed = [RUN_EVERY_MS / 1000, function() {
    return seedOnce().catch(function(e) {
      console.log('[market-deals-seed] ERROR', e);
    });
  }];

  console.log('[market-deals-seed] backend cronjob scheduled every ' + (RUN_EVERY_MS / 3600000) + 'h');
};
