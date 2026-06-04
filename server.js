/**
 * server.js - Backend Proxy for Rome Public Transit Dashboard (Transitland Edition)
 * 
 * Exposes a single GET /api/transit endpoint.
 * Fetches departures from Transitland REST API v2 for exactly 4 stops.
 * Seamlessly resolves 5-digit local ATAC codes to worldwide Onestop IDs,
 * caching results in memory to minimize API queries.
 * 
 * Fully handles timezone arithmetic, route branding colors, live GPS indicators,
 * and isolated station error recovery.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

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
 * GET /api/transit
 * Query departures across all 4 configured stations.
 */
app.get('/api/transit', async (req, res) => {
  if (!CONFIG.TRANSITLAND_APIKEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Transitland API key is missing. Please set TRANSITLAND_APIKEY in your .env file.'
    });
  }

  const apikey = CONFIG.TRANSITLAND_APIKEY;
  const feedId = CONFIG.TRANSITLAND_FEED;

  // Query stops concurrently
  const fetchPromises = CONFIG.STOP_IDS.map(async (rawStopId) => {
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
              // Realtime check: GTFS-RT estimates provide estimated_local
              const isLive = dep.departure?.estimated_local !== null && dep.departure?.estimated_local !== undefined;
              
              // Pick correct local timestamp (fallback to scheduled local time)
              const timeStr = isLive ? dep.departure.estimated_local : dep.departure.scheduled_local;
              const scheduledTimeOnly = dep.departure?.scheduled ? dep.departure.scheduled.substring(0, 5) : '--:--';
              
              // Calculate minutes remaining (absolute timezone-safe math)
              let minutesRemaining = 0;
              if (timeStr) {
                const depTimeMs = Date.parse(timeStr);
                const diffMs = depTimeMs - nowMs;
                minutesRemaining = Math.floor(diffMs / 60000);
              }

              // Color configuration formatting
              const rawColor = dep.trip?.route?.route_color;
              const rawTextColor = dep.trip?.route?.route_text_color;
              
              const lineColor = rawColor ? (rawColor.startsWith('#') ? rawColor : `#${rawColor}`) : null;
              const lineTextColor = rawTextColor ? (rawTextColor.startsWith('#') ? rawTextColor : `#${rawTextColor}`) : null;

              // Extract delay details
              const delaySec = dep.departure?.delay;
              const delayMin = (delaySec !== null && delaySec !== undefined) ? Math.round(delaySec / 60) : null;

              return {
                line: dep.trip?.route?.route_short_name || '?',
                direction: dep.trip?.trip_headsign || 'Unknown Direction',
                time: scheduledTimeOnly,
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
          // 1. Show all departures scheduled/estimated within the next 20 minutes.
          // 2. If there are fewer than 5 departures within 20 minutes, pad the list to show at least the next 5 departures.
          const soonDepartures = departures.filter(dep => dep.minutesRemaining <= 20);
          if (soonDepartures.length >= 5) {
            departures = soonDepartures;
          } else {
            departures = departures.slice(0, 5);
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

// Start proxy server
app.listen(CONFIG.PORT, () => {
  console.log(`==================================================`);
  console.log(` Rome Transit Proxy running on http://localhost:${CONFIG.PORT}`);
  console.log(` Active stop IDs: [ ${CONFIG.STOP_IDS.join(', ')} ]`);
  console.log(` Bounded feed: ${CONFIG.TRANSITLAND_FEED}`);
  console.log(`==================================================`);
});
