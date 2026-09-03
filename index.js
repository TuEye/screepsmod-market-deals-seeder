'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULTS = {
  mode: 'maintain',
  days: 14,
  minDealsPerDay: 10,
  amountPerDeal: 1000,
  intervalHours: 12,
  countAllDeals: true,
  blacklist: []
};

var SEED_TAG = 'market-deals-seed';
var USER_ID = 'system'; // not a real player
var PRICE_SCALE = 1000; // Orders are stored in milli-Credits
var BOOTSTRAP_MARKER_KEY = 'marketDealsSeeder.bootstrapVersion';
var BOOTSTRAP_VERSION = 1;

function parseBoolean(value, name) {
  if (typeof value === 'boolean') return value;

  var normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(normalized) !== -1) return true;
  if (['0', 'false', 'no', 'off'].indexOf(normalized) !== -1) return false;

  throw new Error(name + ' must be true or false');
}

function parsePositiveInteger(value, name) {
  var parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(name + ' must be a positive integer');
  }
  return parsed;
}

function parsePositiveNumber(value, name) {
  var parsed = Number(value);
  if (!isFinite(parsed) || parsed <= 0) {
    throw new Error(name + ' must be a positive number');
  }
  return parsed;
}

function normalizeBlacklist(value) {
  var items;

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    items = value.split(',');
  } else if (value == null) {
    items = [];
  } else {
    throw new Error('blacklist must be an array or comma-separated string');
  }

  return items
    .map(function(item) { return String(item).trim(); })
    .filter(Boolean);
}

function loadConfiguration() {
  var settings = Object.assign({}, DEFAULTS);
  var configPath = path.resolve(process.cwd(), 'marketDealsSeederConfig.js');

  if (fs.existsSync(configPath)) {
    var fileSettings = require(configPath);
    if (!fileSettings || typeof fileSettings !== 'object' || Array.isArray(fileSettings)) {
      throw new Error('marketDealsSeederConfig.js must export an object');
    }
    settings = Object.assign(settings, fileSettings);
    console.log('[market-deals-seed] loaded configuration from ' + configPath);
  }

  // Environment variables override both defaults and the config file.
  if (process.env.MARKET_SEED_MODE != null) {
    settings.mode = process.env.MARKET_SEED_MODE;
  }
  if (process.env.MARKET_SEED_DAYS != null) {
    settings.days = process.env.MARKET_SEED_DAYS;
  }
  if (process.env.MARKET_SEED_MIN_DEALS_PER_DAY != null) {
    settings.minDealsPerDay = process.env.MARKET_SEED_MIN_DEALS_PER_DAY;
  }
  if (process.env.MARKET_SEED_AMOUNT_PER_DEAL != null) {
    settings.amountPerDeal = process.env.MARKET_SEED_AMOUNT_PER_DEAL;
  }
  if (process.env.MARKET_SEED_INTERVAL_HOURS != null) {
    settings.intervalHours = process.env.MARKET_SEED_INTERVAL_HOURS;
  }
  if (process.env.MARKET_SEED_COUNT_ALL_DEALS != null) {
    settings.countAllDeals = process.env.MARKET_SEED_COUNT_ALL_DEALS;
  }
  if (process.env.MARKET_SEED_BLACKLIST != null) {
    settings.blacklist = process.env.MARKET_SEED_BLACKLIST;
  }

  settings.mode = String(settings.mode).trim().toLowerCase();
  if (['maintain', 'bootstrap', 'off'].indexOf(settings.mode) === -1) {
    throw new Error('mode must be maintain, bootstrap, or off');
  }

  settings.days = parsePositiveInteger(settings.days, 'days');
  settings.minDealsPerDay = parsePositiveInteger(settings.minDealsPerDay, 'minDealsPerDay');
  settings.amountPerDeal = parsePositiveInteger(settings.amountPerDeal, 'amountPerDeal');
  settings.intervalHours = parsePositiveNumber(settings.intervalHours, 'intervalHours');
  settings.countAllDeals = parseBoolean(settings.countAllDeals, 'countAllDeals');
  settings.blacklist = normalizeBlacklist(settings.blacklist);

  return settings;
}

module.exports = function(config) {
  // Mods are loaded by multiple Screeps processes. Only the backend owns
  // cronjobs, so registering here prevents duplicate seeders from running.
  if (!config || !config.backend || !config.cronjobs) {
    return;
  }

  var settings;
  try {
    settings = loadConfiguration();
  } catch (e) {
    console.log('[market-deals-seed] ERROR (configuration)', e);
    return;
  }

  if (settings.mode === 'off') {
    console.log('[market-deals-seed] disabled by configuration');
    return;
  }

  var bootstrapDone = false;

  function getStorage() {
    var storage = config && config.common && config.common.storage;
    var db = storage && storage.db;

    if (!storage || !storage.env || !db || !db['market.orders'] || !db['users.money']) {
      throw new Error('required Screeps storage services are not available');
    }

    return storage;
  }

  function getDb() {
    return getStorage().db;
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

    // Keep synthetic deal timestamps safely away from day boundaries, but
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

  function dayKeyLocal(date) {
    var value = new Date(date);
    if (!isFinite(value.getTime())) return null;

    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
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

  async function loadDealCounts() {
    var db = getDb();
    var oldestRange = dayRangesLocal(settings.days - 1);
    var now = new Date();
    var andParts = [
      { type: 'market.sell' },
      { date: { $gte: oldestRange.countStart, $lte: now } }
    ];

    // By default real + seeded deals both satisfy the daily minimum.
    if (!settings.countAllDeals) {
      andParts.push({ __seededBy: SEED_TAG });
    }

    var docs = await db['users.money'].find({ $and: andParts });
    var counts = {};

    (docs || []).forEach(function(doc) {
      if (!doc || !doc.market || !doc.market.resourceType || !doc.date) return;
      var dayKey = dayKeyLocal(doc.date);
      if (!dayKey) return;

      var rt = doc.market.resourceType;
      if (!counts[rt]) counts[rt] = {};
      counts[rt][dayKey] = (counts[rt][dayKey] || 0) + 1;
    });

    return counts;
  }

  async function insertSeedDeal(rt, avgPrice, start, end) {
    var db = getDb();
    var jitter = 1 + ((Math.random() - 0.5) * 0.10); // +/-5%
    var raw = safeNumber(avgPrice, 1);
    var price = (raw / PRICE_SCALE) * jitter;
    var amount = settings.amountPerDeal;

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

    if (settings.blacklist.length) {
      rts = rts.filter(function(rt) { return settings.blacklist.indexOf(rt) === -1; });
    }

    if (!rts.length) {
      console.log('[market-deals-seed] No avg prices found from active orders; nothing to seed.');
      return { resources: 0, inserted: 0, bootstrapReady: false };
    }

    // One 14-day read replaces the previous resource x day count queries.
    var dealCounts = await loadDealCounts();
    var inserted = 0;

    for (var ri = 0; ri < rts.length; ri++) {
      var rt = rts[ri];
      var avg = avgPrices[rt];

      for (var d = 0; d < settings.days; d++) {
        var range = dayRangesLocal(d);
        var dayKey = dayKeyLocal(range.countStart);
        var have = (dealCounts[rt] && dealCounts[rt][dayKey]) || 0;
        var need = Math.max(0, settings.minDealsPerDay - have);

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
    return { resources: rts.length, inserted: inserted, bootstrapReady: true };
  }

  async function runSeedCycle() {
    if (settings.mode === 'bootstrap') {
      if (bootstrapDone) {
        return { skipped: true, reason: 'bootstrap-complete' };
      }

      var storage = getStorage();
      var marker = await storage.env.get(BOOTSTRAP_MARKER_KEY);
      if (parseInt(marker, 10) >= BOOTSTRAP_VERSION) {
        bootstrapDone = true;
        console.log('[market-deals-seed] bootstrap already completed (version ' + marker + ')');
        return { skipped: true, reason: 'bootstrap-complete' };
      }
    }

    var result = await seedOnce();

    if (settings.mode === 'bootstrap' && result.bootstrapReady) {
      await getStorage().env.set(BOOTSTRAP_MARKER_KEY, String(BOOTSTRAP_VERSION));
      bootstrapDone = true;
      console.log('[market-deals-seed] bootstrap completed; marker version=' + BOOTSTRAP_VERSION);
    }

    return result;
  }

  var intervalSeconds = Math.round(settings.intervalHours * 60 * 60);
  config.cronjobs.marketDealsSeed = [intervalSeconds, function() {
    return runSeedCycle().catch(function(e) {
      console.log('[market-deals-seed] ERROR', e);
    });
  }];

  console.log(
    '[market-deals-seed] mode=' + settings.mode +
    ' cronjob scheduled every ' + settings.intervalHours + 'h'
  );
};
