/**
 * gtfsDirect.js - Direct GTFS + GTFS-Realtime client for Rome (Roma Servizi per la Mobilita).
 *
 * Bypasses Transitland and reads the source feeds published by Roma Mobilita:
 *   - Static schedule (zip):   rome_static_gtfs.zip
 *   - Realtime trip updates:   rome_rtgtfs_trip_updates_feed.pb  (GTFS-RT protobuf)
 *
 * Scoped on purpose: we only ever keep schedule rows for the handful of stop IDs
 * the dashboard cares about, so memory stays small even though Rome's full
 * stop_times.txt is huge. The static schedule is parsed once per service day and
 * cached; realtime is fetched on a short TTL and merged on top.
 *
 * Output contract matches the old Transitland path exactly, so the frontend is
 * untouched. Each stop returns:
 *   { stopId, stopName, departures: [ { line, direction, time, minutesRemaining,
 *     status, lineColor, lineTextColor, delayMin } ], status, message? }
 *
 * NOTE: Written without optional chaining / nullish coalescing so it runs on
 * older Node.js versions, consistent with the rest of server.js.
 */

const yauzl = require('yauzl');
const GtfsRt = require('gtfs-realtime-bindings');

// Resolve a fetch implementation that works across Node versions.
let fetchFn;
if (typeof globalThis.fetch === 'function') {
  fetchFn = globalThis.fetch;
} else {
  fetchFn = require('node-fetch');
}

// Roma Mobilita migrated these feeds off the old Drupal path
// (/sites/default/files/) to /wp-content/uploads/shared/. The old path now
// answers with a 301 (Moved Permanently) to the new one, so we point at the
// canonical location directly instead of relying on the redirect. fetch /
// node-fetch still follow redirects, which keeps this resilient if the path
// shifts again.
const FEED_BASE = 'https://romamobilita.it/wp-content/uploads/shared/';
const STATIC_URL = FEED_BASE + 'rome_static_gtfs.zip';
const TRIP_UPDATES_URL = FEED_BASE + 'rome_rtgtfs_trip_updates_feed.pb';

// How long a realtime fetch is reused before refetching (ms).
const RT_TTL_MS = 20 * 1000;
// Look-ahead window (minutes): surface every departure up to this far out so the
// Commute Radar can show ~the next hour of buses, not just imminent arrivals.
// Override with LOOKAHEAD_MIN in .env. When a stop has fewer than MIN_DEPARTURES
// within the window we still pad to the next few, so sparse stops (night service,
// metro) never render empty.
const LOOKAHEAD_MIN = (function () {
  const v = parseInt(process.env.LOOKAHEAD_MIN, 10);
  return (!isNaN(v) && v > 0) ? v : 60;
})();
const MIN_DEPARTURES = 5;

// ---- In-memory caches -------------------------------------------------------
let staticCache = null;       // { serviceDate, builtAt, stopNames, byStop }
let staticBuildPromise = null; // de-dupes concurrent rebuilds
let rtCache = null;           // { fetchedAt, byTripStop }
let rtFetchPromise = null;

// ---- Small utilities --------------------------------------------------------

/**
 * Minimal CSV line parser that handles double-quoted fields containing commas
 * and escaped quotes (""). GTFS files use standard CSV quoting.
 */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Builds a name->index map from a parsed GTFS header row. */
function headerIndex(headerFields) {
  const idx = {};
  for (let i = 0; i < headerFields.length; i++) {
    idx[headerFields[i].trim().replace(/^﻿/, '')] = i;
  }
  return idx;
}

/** Converts a GTFS "HH:MM:SS" time (may exceed 24h) to seconds after midnight. */
function gtfsTimeToSeconds(t) {
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

/** Formats seconds-after-midnight to "HH:MM" (wraps past 24h). */
function secondsToHHMM(sec) {
  const wrapped = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return pad(h) + ':' + pad(m);
}

/** Formats an absolute epoch (seconds) as the Europe/Rome wall-clock "HH:MM". */
function epochToRomeHHMM(epochSec) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(epochSec * 1000));
  let hh = '00';
  let mm = '00';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'hour') hh = parts[i].value;
    else if (parts[i].type === 'minute') mm = parts[i].value;
  }
  if (hh === '24') hh = '00';
  return hh + ':' + mm;
}

/**
 * Returns the current wall-clock context in Europe/Rome:
 *   { dateNum: YYYYMMDD, weekday: 0..6 (Sun=0), secondsOfDay }
 * Uses Intl so we never do manual timezone/DST math.
 */
function romeNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
  }).formatToParts(now);

  const get = function (type) {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === type) return parts[i].value;
    }
    return '';
  };

  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some environments emit 24 for midnight
  const minute = parseInt(get('minute'), 10);
  const second = parseInt(get('second'), 10);

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get('weekday')];

  return {
    dateNum: year * 10000 + month * 100 + day,
    weekday: weekday,
    secondsOfDay: hour * 3600 + minute * 60 + second
  };
}

/** Downloads a URL and returns a Buffer, across node-fetch v2 / global fetch. */
async function downloadBuffer(url) {
  const res = await fetchFn(url, {
    headers: {
      // Some CDNs reject the default client UA; present a browser-like one.
      'User-Agent': 'Mozilla/5.0 (compatible; RomeTransitDashboard/1.0)'
    }
  });
  if (!res.ok) {
    throw new Error('Download failed (' + res.status + ') for ' + url);
  }
  if (typeof res.buffer === 'function') {
    return res.buffer(); // node-fetch v2
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---- yauzl helpers ----------------------------------------------------------

/**
 * Reads selected small entries fully from the zip buffer. `wanted` is a Set of
 * lowercase base filenames (e.g. "trips.txt"). Returns { name: string }.
 * stop_times.txt is intentionally NOT read here (it is streamed separately).
 */
function readSmallEntries(zipBuffer, wanted) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, function (err, zip) {
      if (err) return reject(err);
      const result = {};
      zip.on('error', reject);
      zip.on('entry', function (entry) {
        const base = entry.fileName.split('/').pop().toLowerCase();
        if (!wanted.has(base)) { zip.readEntry(); return; }
        zip.openReadStream(entry, function (e, stream) {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', function (c) { chunks.push(c); });
          stream.on('end', function () {
            result[base] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', function () { resolve(result); });
      zip.readEntry();
    });
  });
}

/**
 * Streams stop_times.txt line-by-line, invoking onRow(cols, idx) for each data
 * row. Avoids holding the (very large) decompressed file in memory.
 */
function streamStopTimes(zipBuffer, onRow) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, function (err, zip) {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('entry', function (entry) {
        const base = entry.fileName.split('/').pop().toLowerCase();
        if (base !== 'stop_times.txt') { zip.readEntry(); return; }
        zip.openReadStream(entry, function (e, stream) {
          if (e) return reject(e);
          let leftover = '';
          let idx = null;
          stream.on('data', function (chunk) {
            const text = leftover + chunk.toString('utf8');
            const lines = text.split('\n');
            leftover = lines.pop(); // last partial line carries over
            for (let i = 0; i < lines.length; i++) {
              let line = lines[i];
              if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // strip CR
              if (!line) continue;
              const cols = parseCsvLine(line);
              if (idx === null) { idx = headerIndex(cols); continue; }
              onRow(cols, idx);
            }
          });
          stream.on('end', function () {
            if (leftover) {
              let line = leftover;
              if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
              if (line && idx) onRow(parseCsvLine(line), idx);
            }
            resolve();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', function () { resolve(); }); // stop_times missing -> resolve empty
      zip.readEntry();
    });
  });
}

// ---- Static schedule build --------------------------------------------------

/** Parses a buffered CSV string into { idx, rows: cols[][] }. */
function parseCsv(text) {
  const rows = [];
  const lines = text.split('\n');
  let idx = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (idx === null) { idx = headerIndex(cols); continue; }
    rows.push(cols);
  }
  return { idx: idx || {}, rows: rows };
}

/** Determines the set of service_ids active on the given Rome date. */
function computeActiveServices(calendarText, calendarDatesText, dateNum, weekday) {
  const active = {};
  const dayCols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayCol = dayCols[weekday];

  if (calendarText) {
    const parsed = parseCsv(calendarText);
    const idx = parsed.idx;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const sid = r[idx['service_id']];
      const runsToday = r[idx[todayCol]] === '1';
      const start = parseInt(r[idx['start_date']], 10);
      const end = parseInt(r[idx['end_date']], 10);
      if (runsToday && dateNum >= start && dateNum <= end) {
        active[sid] = true;
      }
    }
  }

  if (calendarDatesText) {
    const parsed = parseCsv(calendarDatesText);
    const idx = parsed.idx;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      if (parseInt(r[idx['date']], 10) !== dateNum) continue;
      const sid = r[idx['service_id']];
      const ex = r[idx['exception_type']];
      if (ex === '1') active[sid] = true;       // service added
      else if (ex === '2') delete active[sid];   // service removed
    }
  }

  return active;
}

/**
 * Builds (and caches) the per-stop schedule for today, scoped to `stopIds`.
 * stopIds may be GTFS stop_id values or stop_code values; both are matched.
 */
async function buildStaticSchedule(stopIds, rome) {
  const zipBuffer = await downloadBuffer(STATIC_URL);

  // Pass 1: read the small reference files fully.
  const small = await readSmallEntries(zipBuffer, new Set([
    'stops.txt', 'routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt'
  ]));

  // Resolve requested codes to actual stop_ids (match stop_id OR stop_code).
  const wantedRaw = {};
  for (let i = 0; i < stopIds.length; i++) wantedRaw[String(stopIds[i]).trim()] = true;

  const stopNames = {};        // stop_id -> stop_name
  const targetStopIds = {};    // resolved stop_id -> requested code (for output key)
  if (small['stops.txt']) {
    const parsed = parseCsv(small['stops.txt']);
    const idx = parsed.idx;
    const hasCode = idx['stop_code'] !== undefined;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const stopId = r[idx['stop_id']];
      const stopCode = hasCode ? r[idx['stop_code']] : undefined;
      if (wantedRaw[stopId]) {
        targetStopIds[stopId] = stopId;
        stopNames[stopId] = r[idx['stop_name']];
      } else if (stopCode && wantedRaw[stopCode]) {
        targetStopIds[stopId] = stopCode; // output keyed by the code the user asked for
        stopNames[stopId] = r[idx['stop_name']];
      }
    }
  }

  // Routes: route_id -> branding.
  const routesById = {};
  if (small['routes.txt']) {
    const parsed = parseCsv(small['routes.txt']);
    const idx = parsed.idx;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      routesById[r[idx['route_id']]] = {
        shortName: r[idx['route_short_name']] || '',
        color: idx['route_color'] !== undefined ? r[idx['route_color']] : '',
        textColor: idx['route_text_color'] !== undefined ? r[idx['route_text_color']] : ''
      };
    }
  }

  // Active services for today, then trips restricted to those services.
  const activeServices = computeActiveServices(
    small['calendar.txt'], small['calendar_dates.txt'], rome.dateNum, rome.weekday
  );

  const tripsById = {}; // trip_id -> { routeId, headsign }  (only active-today trips)
  if (small['trips.txt']) {
    const parsed = parseCsv(small['trips.txt']);
    const idx = parsed.idx;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const serviceId = r[idx['service_id']];
      if (!activeServices[serviceId]) continue;
      tripsById[r[idx['trip_id']]] = {
        routeId: r[idx['route_id']],
        headsign: idx['trip_headsign'] !== undefined ? r[idx['trip_headsign']] : ''
      };
    }
  }

  // Pass 2: stream stop_times, keeping only rows for our target stops whose trip
  // is active today.
  const byStop = {}; // outputKey -> [ { tripId, stopId, depSec, line, headsign, lineColor, lineTextColor } ]
  const targetIdSet = targetStopIds; // map resolved stop_id -> outputKey

  await streamStopTimes(zipBuffer, function (cols, idx) {
    const stopId = cols[idx['stop_id']];
    const outputKey = targetIdSet[stopId];
    if (!outputKey) return;
    const tripId = cols[idx['trip_id']];
    const trip = tripsById[tripId];
    if (!trip) return; // not active today
    const timeStr = idx['departure_time'] !== undefined ? cols[idx['departure_time']] : cols[idx['arrival_time']];
    const depSec = gtfsTimeToSeconds(timeStr);
    if (depSec === null) return;

    const route = routesById[trip.routeId] || {};
    if (!byStop[outputKey]) byStop[outputKey] = [];
    byStop[outputKey].push({
      tripId: tripId,
      stopId: stopId,
      depSec: depSec,
      line: route.shortName || '?',
      headsign: trip.headsign || 'Unknown Direction',
      lineColor: normalizeColor(route.color),
      lineTextColor: normalizeColor(route.textColor)
    });
  });

  return {
    serviceDate: rome.dateNum,
    builtAt: Date.now(),
    stopNames: stopNames,
    targetStopIds: targetStopIds,
    activeServicesCount: Object.keys(activeServices).length,
    activeTripsCount: Object.keys(tripsById).length,
    stopsFileRows: small['stops.txt'] ? true : false,
    byStop: byStop
  };
}

function normalizeColor(raw) {
  if (!raw) return null;
  const c = String(raw).trim();
  if (!c) return null;
  return c.charAt(0) === '#' ? c : '#' + c;
}

/** Returns a cached static schedule for today, rebuilding when the day rolls. */
async function getStaticSchedule(stopIds, rome) {
  if (staticCache && staticCache.serviceDate === rome.dateNum) {
    return staticCache;
  }
  if (staticBuildPromise) {
    return staticBuildPromise;
  }
  staticBuildPromise = buildStaticSchedule(stopIds, rome)
    .then(function (built) {
      staticCache = built;
      staticBuildPromise = null;
      return built;
    })
    .catch(function (err) {
      staticBuildPromise = null;
      throw err;
    });
  return staticBuildPromise;
}

// ---- Realtime (trip updates) ------------------------------------------------

/**
 * Fetches and decodes the GTFS-RT trip updates feed, indexed as
 * byTripStop[tripId + '|' + stopId] = { delaySec, timeEpochSec }.
 * Cached briefly so concurrent stop lookups share one fetch.
 */
async function getRealtime() {
  if (rtCache && (Date.now() - rtCache.fetchedAt) < RT_TTL_MS) {
    return rtCache;
  }
  if (rtFetchPromise) return rtFetchPromise;

  rtFetchPromise = (async function () {
    const buffer = await downloadBuffer(TRIP_UPDATES_URL);
    const feed = GtfsRt.transit_realtime.FeedMessage.decode(buffer);
    const byTripStop = {};

    const entities = feed.entity || [];
    for (let i = 0; i < entities.length; i++) {
      const tu = entities[i].tripUpdate;
      if (!tu || !tu.trip) continue;
      const tripId = tu.trip.tripId;
      if (!tripId) continue;
      const updates = tu.stopTimeUpdate || [];
      for (let j = 0; j < updates.length; j++) {
        const stu = updates[j];
        const stopId = stu.stopId;
        if (!stopId) continue;
        const est = stu.departure || stu.arrival;
        if (!est) continue;

        let delaySec = null;
        if (est.delay !== null && est.delay !== undefined) delaySec = est.delay;

        let timeEpochSec = null;
        if (est.time !== null && est.time !== undefined) {
          // protobufjs may return a Long for 64-bit fields.
          timeEpochSec = (typeof est.time === 'object' && typeof est.time.toNumber === 'function')
            ? est.time.toNumber()
            : Number(est.time);
        }

        byTripStop[tripId + '|' + stopId] = { delaySec: delaySec, timeEpochSec: timeEpochSec };
      }
    }

    rtCache = { fetchedAt: Date.now(), byTripStop: byTripStop };
    rtFetchPromise = null;
    return rtCache;
  })().catch(function (err) {
    rtFetchPromise = null;
    throw err;
  });

  return rtFetchPromise;
}

// ---- Public API -------------------------------------------------------------

/**
 * Returns departures for the given stop IDs in the same shape as the old
 * Transitland-backed /api/transit handler.
 */
async function getDepartures(stopIds) {
  const rome = romeNow();

  let schedule;
  try {
    schedule = await getStaticSchedule(stopIds, rome);
  } catch (err) {
    // Static feed unavailable: report every stop as errored (frontend handles it).
    return stopIds.map(function (id) {
      return { stopId: id, stopName: 'Stop ' + id, departures: [], status: 'error', message: 'Static GTFS unavailable: ' + err.message };
    });
  }

  // Realtime is best-effort; on failure we fall back to scheduled-only.
  let rt = null;
  try {
    rt = await getRealtime();
  } catch (err) {
    rt = null;
  }
  const nowSec = rome.secondsOfDay;
  const nowMs = Date.now();

  return stopIds.map(function (rawId) {
    const code = String(rawId).trim();
    // Find the resolved stop_id(s) whose output key equals this requested code.
    const stopName = resolveStopName(schedule, code);
    const rows = schedule.byStop[code] || [];

    const departures = rows.map(function (row) {
      let minutesRemaining = Math.floor((row.depSec - nowSec) / 60);
      let status = 'scheduled';
      let delayMin = null;
      // Displayed clock time: scheduled by default, but for live departures we
      // show the *predicted* time so the HH:MM matches the countdown (and Moovit).
      let displayTime = secondsToHHMM(row.depSec);

      if (rt) {
        const hit = rt.byTripStop[row.tripId + '|' + row.stopId];
        if (hit) {
          status = 'realtime';
          if (hit.timeEpochSec) {
            minutesRemaining = Math.floor((hit.timeEpochSec * 1000 - nowMs) / 60000);
            displayTime = epochToRomeHHMM(hit.timeEpochSec);
          } else if (hit.delaySec !== null && hit.delaySec !== undefined) {
            minutesRemaining = Math.floor((row.depSec - nowSec + hit.delaySec) / 60);
            displayTime = secondsToHHMM(row.depSec + hit.delaySec);
          }
          if (hit.delaySec !== null && hit.delaySec !== undefined) {
            delayMin = Math.round(hit.delaySec / 60);
          }
        }
      }

      return {
        line: row.line,
        direction: row.headsign,
        time: displayTime,
        minutesRemaining: minutesRemaining,
        status: status,
        lineColor: row.lineColor,
        lineTextColor: row.lineTextColor,
        delayMin: delayMin
      };
    })
    .filter(function (d) { return d.minutesRemaining >= 0; })
    .sort(function (a, b) { return a.minutesRemaining - b.minutesRemaining; });

    // Adaptive display: show everything within the look-ahead window; if that is
    // fewer than MIN_DEPARTURES, pad to the next few so the card never looks empty.
    const soon = departures.filter(function (d) { return d.minutesRemaining <= LOOKAHEAD_MIN; });
    const finalDeps = soon.length >= MIN_DEPARTURES ? soon : departures.slice(0, MIN_DEPARTURES);

    return {
      stopId: rawId,
      stopName: stopName || ('Stop ' + rawId),
      departures: finalDeps,
      status: 'success'
    };
  });
}

/** Finds the friendly stop name for a requested code from the built schedule. */
function resolveStopName(schedule, code) {
  const map = schedule.targetStopIds || {};
  const names = schedule.stopNames || {};
  for (const resolvedStopId in map) {
    if (map[resolvedStopId] === code) {
      return names[resolvedStopId];
    }
  }
  return null;
}

/** Diagnostic snapshot used by /api/debug. */
async function getDiagnostics(stopIds) {
  const rome = romeNow();
  const out = { source: 'romamobilita-direct', serviceDate: rome.dateNum, romeSecondsOfDay: rome.secondsOfDay, stops: [] };

  let schedule;
  try {
    schedule = await getStaticSchedule(stopIds, rome);
  } catch (err) {
    out.error = 'Static GTFS build failed: ' + err.message;
    return out;
  }

  // Schedule-build health (helps tell "stop not found" from "no service today").
  out.activeServicesToday = schedule.activeServicesCount;
  out.activeTripsToday = schedule.activeTripsCount;

  let rt = null;
  let rtError = null;
  try { rt = await getRealtime(); } catch (err) { rtError = err.message; }
  out.realtimeAvailable = !!(rt && Object.keys(rt.byTripStop).length > 0);
  out.realtimeEntries = rt ? Object.keys(rt.byTripStop).length : 0;
  if (rtError) out.realtimeError = rtError;
  // Sample of trip IDs from the realtime feed, to compare ID format with static.
  if (rt) {
    const rtKeys = Object.keys(rt.byTripStop);
    const seen = {};
    const rtSample = [];
    for (let k = 0; k < rtKeys.length && rtSample.length < 5; k++) {
      const tid = rtKeys[k].split('|')[0];
      if (!seen[tid]) { seen[tid] = true; rtSample.push(tid); }
    }
    out.realtimeSampleTripIds = rtSample;
  }

  let totalRealtimeMatched = 0;
  for (let i = 0; i < stopIds.length; i++) {
    const code = String(stopIds[i]).trim();
    const resolved = isResolved(schedule, code);
    const rows = schedule.byStop[code] || [];
    let matched = 0;
    if (rt) {
      for (let j = 0; j < rows.length; j++) {
        if (rt.byTripStop[rows[j].tripId + '|' + rows[j].stopId]) matched++;
      }
    }
    totalRealtimeMatched += matched;

    // A few sample scheduled departures so we can eyeball times + trip IDs.
    const sample = rows
      .slice()
      .sort(function (a, b) { return a.depSec - b.depSec; })
      .slice(0, 3)
      .map(function (r) {
        return { time: secondsToHHMM(r.depSec), line: r.line, tripId: r.tripId, gtfsStopId: r.stopId };
      });

    out.stops.push({
      stopId: stopIds[i],
      resolvedInFeed: resolved,
      stopName: resolveStopName(schedule, code) || ('Stop ' + stopIds[i]),
      scheduledToday: rows.length,
      realtimeMatched: matched,
      sampleDepartures: sample,
      // Plain-language hint to speed up diagnosis.
      hint: !resolved
        ? 'stop id/code not found in stops.txt — mapping needs fixing'
        : (rows.length === 0
            ? 'stop found but no active departures today — calendar/service issue'
            : (matched === 0 ? 'scheduled OK but no realtime match for this stop' : 'ok'))
    });
  }
  out.anyRealtimeMatched = totalRealtimeMatched > 0;
  return out;
}

/** True if the requested code resolved to a stop in the feed. */
function isResolved(schedule, code) {
  const map = schedule.targetStopIds || {};
  for (const resolvedStopId in map) {
    if (map[resolvedStopId] === code) return true;
  }
  return false;
}

module.exports = {
  getDepartures: getDepartures,
  getDiagnostics: getDiagnostics,
  // exported for unit checks
  _internals: {
    parseCsvLine: parseCsvLine,
    gtfsTimeToSeconds: gtfsTimeToSeconds,
    secondsToHHMM: secondsToHHMM,
    computeActiveServices: computeActiveServices,
    romeNow: romeNow
  }
};
