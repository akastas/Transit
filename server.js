/**
 * server.js - Backend Proxy for Rome Public Transit Dashboard
 *
 * Endpoints:
 *   GET /api/transit            departures for the configured default stops
 *   GET /api/transit?stops=...  departures for a custom comma-separated stop list
 *                               (lets every browser/tablet run its own board)
 *   GET /api/stops?q=...        search Rome stops by name or code (direct mode)
 *   GET /api/alerts             active ATAC service alerts (GTFS-RT, direct mode)
 *   GET /api/debug              per-stop schedule/realtime diagnostics
 *
 * Default data source reads Roma Mobilita's GTFS + GTFS-RT feeds directly; a
 * legacy Transitland REST proxy remains available (DATA_SOURCE=transitland),
 * which seamlessly resolves 5-digit local ATAC codes to worldwide Onestop IDs.
 *
 * Fully handles timezone arithmetic, route branding colors, live GPS indicators,
 * and isolated station error recovery.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const gtfsDirect = require('./gtfsDirect');

// Dynamically handle node-fetch import for compatibility across Node versions
let fetch;
if (typeof globalThis.fetch === 'function') {
  fetch = globalThis.fetch;
} else {
  fetch = require('node-fetch');
}

const app = express();

// Config settings read from .env
const CONFIG = {
  PORT: process.env.PORT || 5000,
  // Data source: 'direct' reads Roma Mobilita's GTFS + GTFS-RT feeds directly
  // (fresh, keyless). 'transitland' uses the legacy Transitland REST proxy.
  DATA_SOURCE: (process.env.DATA_SOURCE || 'direct').toLowerCase(),
  // Look-ahead window (minutes) for how far out departures are listed. Default 60
  // so the Commute Radar shows ~the next hour. Shared by both data sources.
  LOOKAHEAD_MIN: (function () { const v = parseInt(process.env.LOOKAHEAD_MIN, 10); return (!isNaN(v) && v > 0) ? v : 60; })(),
  MIN_DEPARTURES: 5,
  // Max stops a single ?stops= request may ask for (keeps custom boards sane).
  MAX_CUSTOM_STOPS: 10,
  TRANSITLAND_APIKEY: process.env.TRANSITLAND_APIKEY,
  TRANSITLAND_FEED: process.env.TRANSITLAND_FEED || 'f-sr-atac~romatpl~trenitalia',
  // Exactly 4 Stop IDs from environment variables, with fallback Rome/ATAC example stop codes
  STOP_IDS: [
    process.env.STOP_ID_1 || '71223',
    process.env.STOP_ID_2 || '72100',
    process.env.STOP_ID_3 || '81953',
    process.env.STOP_ID_4 || '70335',
    process.env.STOP_ID_2_ALT || '81993',
    process.env.STOP_ID_METRO || 'CP22'
  ]
};

// In-memory cache for mapping stop codes to Transitland Onestop IDs
const onestopIdCache = {
  '71223': 's-sr2yk9hv89-portasgiovanni',
  '72100': 's-sr2yk9hzef-portasgiovanni~carlofelice',
  '81953': 's-sr2yk9m366-carlofelice',
  '70335': 's-sr2yk9hv94-portasgiovanni',
  '81993': 's-sr2yk9jpkp-portasgiovanni~carlofelice',
  'CP22': 's-sr2yk9j36s-sangiovanni'
};

app.use(cors());
app.use(express.static('public'));

/**
 * Resolves a stop code into a worldwide unique Transitland Onestop ID.
 * If the stop code already looks like a Onestop ID, returns it directly.
 * Caches successful lookups to speed up subsequent queries.
 */
async function resolveOnestopId(stopId, apikey, feedId) {
  const cleanId = stopId.trim();
  
  // If already a Onestop ID (starts with "s-")
  if (cleanId.startsWith('s-')) {
    return cleanId;
  }
  
  // Check memory cache
  if (onestopIdCache[cleanId]) {
    return onestopIdCache[cleanId];
  }
  
  // Search stop by code in the configured GTFS feed (defaults to Rome ATAC feed)
  const searchUrl = `https://transit.land/api/v2/rest/stops?apikey=${apikey}&stop_id=${cleanId}&feed_onestop_id=${feedId}`;
  
  const response = await fetch(searchUrl);
  if (!response.ok) {
    throw new Error(`Transitland search returned status ${response.status}`);
  }
  
  const data = await response.json();
  if (!data.stops || data.stops.length === 0) {
    throw new Error(`Stop code "${cleanId}" not found in feed "${feedId}"`);
  }
  
  // Save resolved ID to cache
  const resolvedOnestopId = data.stops[0].onestop_id;
  onestopIdCache[cleanId] = resolvedOnestopId;
  console.log(`[Cache] Resolved stop code ${cleanId} -> ${resolvedOnestopId}`);
  
  return resolvedOnestopId;
}

/**
 * Parses the optional ?stops=ID1,ID2,... query into a sanitized stop list.
 * Returns null when the parameter is absent/unusable, so callers fall back to
 * the server's configured default stops.
 */
function parseStopsParam(req) {
  const raw = req.query && req.query.stops;
  if (!raw || typeof raw !== 'string') return null;

  const seen = {};
  const out = [];
  raw.split(',').forEach(function (part) {
    const code = part.trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) return; // GTFS ids are simple tokens
    if (seen[code]) return;
    seen[code] = true;
    out.push(code);
  });

  if (out.length === 0) return null;
  return out.slice(0, CONFIG.MAX_CUSTOM_STOPS);
}

/**
 * GET /api/transit
 * Query departures for the configured stations, or for a custom set passed as
 * ?stops=70030,72013 (stop codes or GTFS stop_ids) so any user can run their
 * own board without touching the server's .env.
 */
app.get('/api/transit', async (req, res) => {
  const stopIds = parseStopsParam(req) || CONFIG.STOP_IDS;

  // Preferred path: read Rome's source feeds directly (fresh schedule + GTFS-RT).
  if (CONFIG.DATA_SOURCE === 'direct') {
    try {
      const results = await gtfsDirect.getDepartures(stopIds);
      return res.json(results);
    } catch (err) {
      console.error('[Direct] Failed to build departures:', err.message);
      return res.status(500).json({ status: 'error', message: 'Failed to build transit data from direct feeds.' });
    }
  }

  // Legacy fallback: Transitland REST proxy (set DATA_SOURCE=transitland).
  if (!CONFIG.TRANSITLAND_APIKEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Transitland API key is missing. Please set TRANSITLAND_APIKEY in your .env file.'
    });
  }

  const apikey = CONFIG.TRANSITLAND_APIKEY;
  const feedId = CONFIG.TRANSITLAND_FEED;

  // Query stops concurrently
  const fetchPromises = stopIds.map(async (rawStopId) => {
    try {
      // 1. Resolve stop code (e.g. "70030") to Onestop ID (e.g. "s-sr2yk7q0y2-termini")
      const onestopId = await resolveOnestopId(rawStopId, apikey, feedId);

      // 2. Fetch departures for this Onestop ID
      const departuresUrl = `https://transit.land/api/v2/rest/stops/${onestopId}/departures?apikey=${apikey}&limit=40`;
      const response = await fetch(departuresUrl);
      
      if (!response.ok) {
        throw new Error(`Transitland departures query returned status ${response.status}`);
      }

      const data = await response.json();
      
      let departures = [];
      let stopName = `Stop ${rawStopId}`;

      if (data.stops && data.stops.length > 0) {
        const stopData = data.stops[0];
        stopName = stopData.stop_name || stopName;
        
        if (stopData.departures && Array.isArray(stopData.departures)) {
          const nowMs = Date.now();
          
          departures = stopData.departures
            .map(dep => {
              const hasDepartureObj = dep.departure !== null && dep.departure !== undefined;
              const hasTripObj = dep.trip !== null && dep.trip !== undefined;
              const hasRouteObj = hasTripObj && dep.trip.route !== null && dep.trip.route !== undefined;

              // Realtime check: GTFS-RT estimates provide estimated_local
              const isLive = hasDepartureObj && dep.departure.estimated_local !== null && dep.departure.estimated_local !== undefined;
              
              // Pick correct local timestamp (fallback to scheduled local time)
              const timeStr = hasDepartureObj ? (isLive ? dep.departure.estimated_local : dep.departure.scheduled_local) : null;
              const scheduledTimeOnly = (hasDepartureObj && dep.departure.scheduled) ? dep.departure.scheduled.substring(0, 5) : '--:--';
              // Show the predicted clock time when live, so HH:MM matches the countdown (and Moovit).
              const displayTimeOnly = (isLive && timeStr) ? timeStr.substring(11, 16) : scheduledTimeOnly;
              
              // Calculate minutes remaining (absolute timezone-safe math)
              let minutesRemaining = 0;
              if (timeStr) {
                const depTimeMs = Date.parse(timeStr);
                const diffMs = depTimeMs - nowMs;
                minutesRemaining = Math.floor(diffMs / 60000);
              }

              // Color configuration formatting
              const rawColor = hasRouteObj ? dep.trip.route.route_color : null;
              const rawTextColor = hasRouteObj ? dep.trip.route.route_text_color : null;
              
              const lineColor = rawColor ? (rawColor.startsWith('#') ? rawColor : `#${rawColor}`) : null;
              const lineTextColor = rawTextColor ? (rawTextColor.startsWith('#') ? rawTextColor : `#${rawTextColor}`) : null;

              // Extract delay details
              const delaySec = hasDepartureObj ? dep.departure.delay : null;
              const delayMin = (delaySec !== null && delaySec !== undefined) ? Math.round(delaySec / 60) : null;

              return {
                line: (hasRouteObj && dep.trip.route.route_short_name) || '?',
                direction: (hasTripObj && dep.trip.trip_headsign) || 'Unknown Direction',
                time: displayTimeOnly,
                minutesRemaining,
                status: isLive ? 'realtime' : 'scheduled',
                lineColor,
                lineTextColor,
                delayMin
              };
            })
            // Filter out departures that have already left
            .filter(dep => dep.minutesRemaining >= 0)
            // Sort chronologically (earliest departures first)
            .sort((a, b) => a.minutesRemaining - b.minutesRemaining);

          // Adaptive Display Logic:
          // 1. Show all departures within the look-ahead window (LOOKAHEAD_MIN, default 60 min).
          // 2. If there are fewer than MIN_DEPARTURES in that window, pad to the next few.
          const soonDepartures = departures.filter(dep => dep.minutesRemaining <= CONFIG.LOOKAHEAD_MIN);
          if (soonDepartures.length >= CONFIG.MIN_DEPARTURES) {
            departures = soonDepartures;
          } else {
            departures = departures.slice(0, CONFIG.MIN_DEPARTURES);
          }
        }
      }

      return {
        stopId: rawStopId,
        onestopId,
        stopName,
        departures,
        status: 'success'
      };

    } catch (error) {
      console.error(`[Error] Failed processing stop "${rawStopId}":`, error.message);
      
      // Gracefully handle specific card error to avoid knocking the whole API down
      return {
        stopId: rawStopId,
        stopName: `Stop ${rawStopId}`,
        departures: [],
        status: 'error',
        message: error.message
      };
    }
  });

  try {
    const results = await Promise.all(fetchPromises);
    res.json(results);
  } catch (err) {
    console.error('[Critical Error] Aggregation Promise.all failed:', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to complete transit data aggregation.'
    });
  }
});

/**
 * GET /api/debug
 * Diagnostic endpoint: for each configured stop, reports how many departures
 * Transitland returns with realtime estimates (estimated_local present) versus
 * scheduled-only. Use this to confirm whether GTFS-Realtime is actually
 * attaching for ATAC. If every stop shows realtime: 0, the live data is not
 * being matched on Transitland's side (feed issue), not a bug in this app.
 */
app.get('/api/debug', async (req, res) => {
  const debugStopIds = parseStopsParam(req) || CONFIG.STOP_IDS;

  // In direct mode, report from Rome's source feeds (scheduled-today + RT matches).
  if (CONFIG.DATA_SOURCE === 'direct') {
    try {
      const diag = await gtfsDirect.getDiagnostics(debugStopIds);
      return res.json(diag);
    } catch (err) {
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  if (!CONFIG.TRANSITLAND_APIKEY) {
    return res.status(500).json({ status: 'error', message: 'Transitland API key is missing.' });
  }

  const apikey = CONFIG.TRANSITLAND_APIKEY;
  const feedId = CONFIG.TRANSITLAND_FEED;

  const report = await Promise.all(debugStopIds.map(async (rawStopId) => {
    try {
      const onestopId = await resolveOnestopId(rawStopId, apikey, feedId);
      const departuresUrl = `https://transit.land/api/v2/rest/stops/${onestopId}/departures?apikey=${apikey}&limit=40`;
      const response = await fetch(departuresUrl);
      if (!response.ok) {
        throw new Error(`Departures query returned status ${response.status}`);
      }

      const data = await response.json();
      const stopData = (data.stops && data.stops[0]) || {};
      const departures = Array.isArray(stopData.departures) ? stopData.departures : [];

      const realtimeCount = departures.filter(function (d) {
        return d.departure && d.departure.estimated_local !== null && d.departure.estimated_local !== undefined;
      }).length;

      // Surface one raw sample so the exact realtime fields are visible
      const firstDep = departures[0] && departures[0].departure;
      const sample = firstDep
        ? {
            scheduled_local: firstDep.scheduled_local,
            estimated_local: firstDep.estimated_local,
            delay: firstDep.delay
          }
        : null;

      return {
        stopId: rawStopId,
        stopName: stopData.stop_name || `Stop ${rawStopId}`,
        totalDepartures: departures.length,
        realtime: realtimeCount,
        scheduledOnly: departures.length - realtimeCount,
        sampleFirstDeparture: sample
      };
    } catch (error) {
      return { stopId: rawStopId, error: error.message };
    }
  }));

  const totalRealtime = report.reduce((sum, r) => sum + (r.realtime || 0), 0);
  res.json({
    feed: feedId,
    realtimeFeedHint: `${feedId}~rt`,
    anyRealtimeAvailable: totalRealtime > 0,
    checkedAt: new Date().toISOString(),
    stops: report
  });
});

/**
 * GET /api/stops?q=colosseo (or ?q=70030)
 * Searches Rome's stops by name substring or code prefix, so users can find
 * their own stop codes when configuring a custom board. Direct mode only
 * (the search index comes from the GTFS stops.txt kept in memory).
 */
app.get('/api/stops', async (req, res) => {
  if (CONFIG.DATA_SOURCE !== 'direct') {
    return res.status(501).json({
      status: 'error',
      message: 'La ricerca fermate richiede DATA_SOURCE=direct. Inserisci il codice fermata manualmente.'
    });
  }

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) {
    return res.json({ status: 'success', stops: [] });
  }

  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0) limit = 12;
  limit = Math.min(limit, 25);

  try {
    const stops = await gtfsDirect.searchStops(q, limit);
    res.json({ status: 'success', stops });
  } catch (err) {
    console.error('[Stops] Search failed:', err.message);
    res.status(500).json({ status: 'error', message: 'Ricerca fermate non disponibile: ' + err.message });
  }
});

/**
 * GET /api/alerts
 * Active ATAC service alerts from Roma Mobilita's GTFS-RT feed (strikes,
 * detours, closures), with route_ids mapped to line names where possible.
 * The frontend filters them down to the lines/stops it is showing.
 */
app.get('/api/alerts', async (req, res) => {
  if (CONFIG.DATA_SOURCE !== 'direct') {
    return res.json({ status: 'success', alerts: [], note: 'Avvisi disponibili solo con DATA_SOURCE=direct.' });
  }

  try {
    const payload = await gtfsDirect.getAlerts();
    res.json(payload);
  } catch (err) {
    console.error('[Alerts] Fetch failed:', err.message);
    res.status(500).json({ status: 'error', message: 'Impossibile leggere gli avvisi: ' + err.message, alerts: [] });
  }
});

// Start proxy server
app.listen(CONFIG.PORT, () => {
  console.log(`==================================================`);
  console.log(` Rome Transit Proxy running on http://localhost:${CONFIG.PORT}`);
  console.log(` Data source: ${CONFIG.DATA_SOURCE}`);
  console.log(` Active stop IDs: [ ${CONFIG.STOP_IDS.join(', ')} ]`);
  console.log(` Bounded feed: ${CONFIG.TRANSITLAND_FEED}`);
  console.log(`==================================================`);
});
