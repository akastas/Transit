/**
 * app.js - Frontend client logic for Rome Transit Dashboard (ATAC Lens & Tabs)
 *
 * Functions:
 * 1. Digital clock & date update (Rome/Italy timezone formatting)
 * 2. Asynchronous transit data retrieval from backend (/api/transit)
 * 3. 45-second count-down timer with animated visual progress bar
 * 4. Tab routing switcher ('lens' / 'board' / 'metro' / 'line' views)
 * 5. ATAC Lens commute filter (preferred lines, hub stops & night buses)
 * 6. Interactive opposite direction toggle for Card 2 in Board view (default setup)
 * 7. Custom boards: the ⚙️ settings panel lets any user pick their own stops,
 *    direction filters, lines and walking times (saved per browser in
 *    localStorage, shareable via #cfg= links); /api/transit?stops=... follows
 * 8. "Esci ora" walking-time assistant per departure
 * 9. ATAC service alerts banner fed by /api/alerts
 */

// Backend origin: fall back to port 5050 if loading static files on standard dev ports or via file://
const API_BASE = (window.location.protocol === 'file:' || (window.location.hostname === 'localhost' && window.location.port !== '5050' && window.location.port !== '5000'))
  ? 'http://localhost:5050'
  : '';

// Dashboard State Configurations
const CONFIG = {
  REFRESH_INTERVAL_SEC: 45,
  ALERTS_REFRESH_SEC: 120
};

// Built-in defaults mirroring the server's .env stops (the original home board).
const DEFAULTS = {
  LENS_LINES: ['81', '85', '87', '360'],
  HUB_STOPS: ['72100', '81993'],   // Carlo Felice hub: every line at these stops matters
  METRO_STOP: 'CP22'
};

// Linea Live window: the rail spans the next 20 minutes (right edge = now).
const LINE_SCALE_MIN = 20;

// Global State
let countdownTime = CONFIG.REFRESH_INTERVAL_SEC;
let refreshTimerId = null;
let countdownTimerId = null;

// Tab Selection & Toggle States
let activeTab = 'lens';      // Selected tab view: 'lens' (default) or 'board'
let card1ShowAlt = false;    // Toggles between index 1 (72100) and index 4 (81993) for Card 2
let lastTransitData = null;  // Holds client-side cache of last API fetch

// ---------------------------------------------------------------------------
// User configuration: lets anyone run their own board (stops, direction
// filters, preferred lines, walking times) without touching the server.
// Stored per browser in localStorage; shareable through a #cfg= link.
// ---------------------------------------------------------------------------
const CONFIG_STORAGE_KEY = 'transit.userConfig.v1';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Lowercases and strips accents for forgiving text matching. */
function normalizeText(s) {
  let t = String(s ?? '').toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep raw */ }
  return t;
}

/** Validates and normalizes a raw config object; null when nothing useful. */
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { stops: [], lines: [], showNight: raw.showNight !== false };
  const seen = {};

  (Array.isArray(raw.stops) ? raw.stops : []).slice(0, 10).forEach(s => {
    if (!s) return;
    const id = String(s.id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || seen[id]) return;
    seen[id] = true;
    const walk = parseInt(s.walk, 10);
    out.stops.push({
      id,
      name: String(s.name || '').slice(0, 60),
      hub: !!s.hub,                                   // hub = every line at this stop shows in the Lens
      dir: String(s.dir || '').slice(0, 40),          // headsign substring filter ("direzione contiene")
      walk: (!isNaN(walk) && walk > 0 && walk <= 120) ? walk : 0
    });
  });

  (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 20).forEach(l => {
    const line = String(l || '').trim();
    if (line && line.length <= 8 && !out.lines.includes(line)) out.lines.push(line);
  });

  if (out.stops.length === 0 && out.lines.length === 0) return null;
  return out;
}

/** Reads a shared configuration from a #cfg= link (base64url JSON). */
function readConfigFromHash() {
  const match = window.location.hash.match(/[#&]cfg=([A-Za-z0-9\-_]+)/);
  if (!match) return null;
  try {
    let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = decodeURIComponent(escape(atob(b64)));
    return sanitizeConfig(JSON.parse(json));
  } catch (err) {
    console.warn('[Config] Link di configurazione non valido:', err);
    return null;
  }
}

function loadUserConfig() {
  // A shared #cfg= link wins, gets persisted, then the hash is cleaned up.
  const fromHash = readConfigFromHash();
  if (fromHash) {
    try { localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(fromHash)); } catch (e) { /* private mode */ }
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
    return fromHash;
  }
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) return sanitizeConfig(JSON.parse(raw));
  } catch (e) {
    console.warn('[Config] Configurazione salvata illeggibile:', e);
  }
  return null;
}

function persistUserConfig(cfg) {
  userConfig = cfg;
  try {
    if (cfg) localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_STORAGE_KEY);
  } catch (e) {
    console.warn('[Config] Impossibile salvare la configurazione:', e);
  }
}

let userConfig = loadUserConfig();

// --- Config accessors (every view reads through these) ---
function customStops() {
  return (userConfig && userConfig.stops && userConfig.stops.length) ? userConfig.stops : null;
}
function customStopIds() {
  const stops = customStops();
  return stops ? stops.map(s => String(s.id)) : null;
}
function getLensLines() {
  return (userConfig && userConfig.lines && userConfig.lines.length) ? userConfig.lines : DEFAULTS.LENS_LINES;
}
function getHubStopIds() {
  const stops = customStops();
  return stops ? stops.filter(s => s.hub).map(s => String(s.id)) : DEFAULTS.HUB_STOPS;
}
function showNightBuses() {
  return !userConfig || userConfig.showNight !== false;
}
function getWalkMinutes(stopId) {
  const stops = customStops();
  if (!stops) return null;
  const stop = stops.find(s => String(s.id) === String(stopId));
  return (stop && stop.walk > 0) ? stop.walk : null;
}
function transitApiUrl() {
  const ids = customStopIds();
  return API_BASE + '/api/transit' + (ids ? `?stops=${ids.join(',')}` : '');
}

/** Applies per-stop direction filters (substring match on the headsign). */
function applyDirectionFilters(stations) {
  const stops = customStops();
  if (!stops || !Array.isArray(stations)) return stations;

  const filters = {};
  stops.forEach(s => { if (s.dir) filters[String(s.id)] = normalizeText(s.dir); });
  if (Object.keys(filters).length === 0) return stations;

  return stations.map(station => {
    const needle = station && filters[String(station.stopId)];
    if (!needle || !Array.isArray(station.departures)) return station;
    return {
      ...station,
      departures: station.departures.filter(dep => normalizeText(dep.direction).includes(needle))
    };
  });
}

/**
 * "Esci ora" walking-time assistant: when a stop has a configured walking
 * time, every departure shows whether you can still catch it leaving now.
 */
function walkBadgeHtml(dep, stopId) {
  const walkMin = getWalkMinutes(stopId);
  if (walkMin === null) return '';
  const leaveIn = dep.minutesRemaining - walkMin;
  if (leaveIn < 0) return `<span class="walk-badge walk-missed" title="${walkMin} min a piedi">🚶 troppo tardi</span>`;
  if (leaveIn <= 1) return `<span class="walk-badge walk-now" title="${walkMin} min a piedi">🚶 esci ora!</span>`;
  return `<span class="walk-badge walk-future" title="${walkMin} min a piedi">🚶 esci tra ${leaveIn}'</span>`;
}

/** Applies config-dependent chrome: metro tab visibility and subheader texts. */
function applyConfigSideEffects() {
  const stops = customStops();

  // The Metro C tab is wired to the San Giovanni stop: hide it when a custom
  // board doesn't include that stop.
  const metroBtn = document.getElementById('tab-btn-metro');
  const hasMetro = !stops || stops.some(s => String(s.id).toUpperCase() === DEFAULTS.METRO_STOP);
  if (metroBtn) metroBtn.style.display = hasMetro ? '' : 'none';
  if (!hasMetro && activeTab === 'metro') switchTab('lens');

  // Subheaders describe what is actually being monitored.
  const lines = getLensLines().join(', ');
  const hubCount = getHubStopIds().length;
  const lensSub = document.getElementById('lens-subheader');
  if (lensSub) {
    lensSub.textContent = `Priorità arrivi per linee preferite (${lines})`
      + (hubCount > 0 ? `, ${hubCount === 1 ? '1 fermata hub' : hubCount + ' fermate hub'} (tutte le linee)` : '')
      + (showNightBuses() ? ' e bus notturni live' : '');
  }
  const lineSub = document.getElementById('line-subheader');
  if (lineSub) {
    lineSub.textContent = `Gli stessi bus dell'ATAC Lens su un'unica linea temporale: prossimi ${LINE_SCALE_MIN} minuti. Più vicino a 📍 = in arrivo prima.`;
  }
}

// DOM Elements cache
const dom = {
  clock: document.getElementById('live-clock'),
  date: document.getElementById('live-date'),
  lastUpdated: document.getElementById('last-updated'),
  countdownBar: document.getElementById('countdown-bar'),
  countdownText: document.getElementById('countdown-text'),
  grid: null, // Initialized dynamically in renderBoardView
  lensList: null // Initialized dynamically in renderLensView
};

/**
 * Initializes clock updates every second.
 */
function initClock() {
  const updateClock = () => {
    const now = new Date();
    
    // Format clock in Italian locale (Rome)
    dom.clock.textContent = now.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Format date beautifully
    dom.date.textContent = now.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  updateClock();
  setInterval(updateClock, 1000);
}

/**
 * Main function to fetch transit data from our local proxy backend API.
 */
async function fetchTransitData() {
  try {
    const response = await fetch(transitApiUrl());
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    let transitData = await response.json();
    transitData = applyDirectionFilters(transitData);
    lastTransitData = transitData; // Store cache for instantaneous direction toggles

    // Update all views
    renderLensView(transitData);
    renderBoardView(transitData);
    renderMetroView(transitData);
    renderLineView(transitData);
    renderAlerts(); // re-match alerts against the lines now on screen
  } catch (error) {
    console.error('Failed to retrieve transit data:', error);
    renderGeneralError(error.message);
  } finally {
    // Always refresh the "last update check" timestamp, even when the fetch
    // failed or a render threw. This keeps the indicator from getting stuck at
    // --:--:-- so the user can always see when the dashboard last checked.
    if (dom.lastUpdated) {
      dom.lastUpdated.textContent = new Date().toLocaleTimeString('it-IT', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
  }
}

/**
 * Tab switcher routing function. Exposed globally to handle HTML button clicks.
 */
window.switchTab = function(tabName) {
  activeTab = tabName;
  
  // Toggle tab buttons state
  document.getElementById('tab-btn-lens').classList.toggle('active', tabName === 'lens');
  document.getElementById('tab-btn-board').classList.toggle('active', tabName === 'board');
  document.getElementById('tab-btn-metro').classList.toggle('active', tabName === 'metro');
  document.getElementById('tab-btn-line').classList.toggle('active', tabName === 'line');

  // Toggle view containers state
  document.getElementById('lens-view').classList.toggle('active', tabName === 'lens');
  document.getElementById('board-view').classList.toggle('active', tabName === 'board');
  document.getElementById('metro-view').classList.toggle('active', tabName === 'metro');
  document.getElementById('line-view').classList.toggle('active', tabName === 'line');
  
  console.log(`[Tabs] Displaying view: ${tabName}`);
};

/**
 * TAB 1: Renders the ATAC Lens View
 * Aggregates all departures, filters for important lines (81, 85, 87, 360) 
 * or station 72100/81993, and sorts them by minutes remaining.
 */
// Rome night lines (notturni) use route codes starting with "n" (nMA, nMC, n3d).
function isNightLine(line) {
  return typeof line === 'string' && line.charAt(0) === 'n';
}

function renderLensView(stations) {
  dom.lensList = document.getElementById('lens-list');
  if (!dom.lensList) return;
  dom.lensList.innerHTML = '';

  if (!stations || !Array.isArray(stations) || stations.length === 0) {
    dom.lensList.innerHTML = `<p class="error-message">Nessun dato disponibile per il Radar.</p>`;
    return;
  }

  const checkbox = document.getElementById('lens-show-scheduled');
  const showScheduled = checkbox ? checkbox.checked : false;

  // Preferred lines / hub stops come from the user's config (or the defaults).
  const importantLines = getLensLines();
  const hubStopIds = getHubStopIds();
  const nightIncluded = showNightBuses();
  let aggregatedDepartures = [];

  // Loop through all retrieved stations (including default & alternate ones)
  stations.forEach(station => {
    if (!station || station.status === 'error' || !station.departures) return;

    station.departures.forEach(dep => {
      const isImportantLine = importantLines.includes(dep.line);
      // Hub stops surface every line serving them (e.g. the Carlo Felice hub)
      const isHubStop = hubStopIds.includes(String(station.stopId));
      // Night service: the daytime lines stop running, so surface every night bus (n...).
      const isNightBus = nightIncluded && isNightLine(dep.line);

      if (isImportantLine || isHubStop || isNightBus) {
        // Filter out scheduled departures if toggle is unchecked
        if (!showScheduled && dep.status !== 'realtime') {
          return;
        }

        aggregatedDepartures.push({
          ...dep,
          stationName: station.stopName,
          stationStopId: station.stopId
        });
      }
    });
  });

  // Sort aggregated items by minutes remaining (soonest departures first)
  aggregatedDepartures.sort((a, b) => a.minutesRemaining - b.minutesRemaining);

  if (aggregatedDepartures.length === 0) {
    const hubCount = hubStopIds.length;
    const monitoredHint = `Vengono monitorate le linee ${escapeHtml(importantLines.join(', '))}`
      + (hubCount > 0 ? ` e ${hubCount === 1 ? '1 fermata hub' : hubCount + ' fermate hub'}` : '');
    dom.lensList.innerHTML = `
      <div class="no-departures">
        <span class="no-departures-icon">📡</span>
        <p>Nessun bus importante rilevato nei paraggi</p>
        <span style="font-size: 0.8rem;">${monitoredHint}</span>
      </div>
    `;
    return;
  }

  // Render the ranked departures rows
  aggregatedDepartures.forEach(dep => {
    const row = document.createElement('div');
    row.className = 'lens-row';

    const isLive = dep.status === 'realtime';
    const timeClass = isLive ? 'realtime-depart' : 'scheduled-depart';
    const badgeClass = isLive ? 'realtime-badge' : 'scheduled-badge';
    const badgeLabel = isLive ? '<span class="pulse-dot"></span>LIVE' : 'ORARIO';
    
    const lineStyle = dep.lineColor 
      ? `background-color: ${dep.lineColor}; color: ${dep.lineTextColor || '#ffffff'}`
      : '';

    let animationIndicator = '';
    if (dep.minutesRemaining === 1) {
      animationIndicator = getRunnerSvg();
    } else if (dep.minutesRemaining === 0) {
      animationIndicator = getPartingBusSvg();
    }

    let delayBadge = '';
    if (dep.delayMin !== undefined && dep.delayMin !== null) {
      if (dep.delayMin > 0) {
        delayBadge = `<span class="delay-badge delay-late">+${dep.delayMin}m ritardo</span>`;
      } else if (dep.delayMin < 0) {
        delayBadge = `<span class="delay-badge delay-early">-${Math.abs(dep.delayMin)}m anticipo</span>`;
      } else {
        delayBadge = `<span class="delay-badge delay-ontime">in orario</span>`;
      }
    }

    row.innerHTML = `
      <div class="line-identifier" style="${lineStyle}">
        ${dep.line}
      </div>
      <div class="route-details">
        <span class="route-direction"><span class="dir-prefix">dir.</span>${dep.direction}</span>
        <span class="route-station">
          Arrivo a <strong>${dep.stationName}</strong>
          <span class="status-badge ${badgeClass}" style="margin-left: 6px;">${badgeLabel}</span>
          ${delayBadge}
          ${walkBadgeHtml(dep, dep.stationStopId)}
        </span>
      </div>
      <div class="arrival-countdown">
        <div class="animation-container">
          ${animationIndicator}
        </div>
        <span class="arrival-minutes ${timeClass}">
          ${dep.minutesRemaining}
        </span>
        <span class="arrival-unit">min</span>
      </div>
    `;
    dom.lensList.appendChild(row);
  });
}

/**
 * TAB 2: Renders the Station Board View.
 * Default setup: maps 5 backend stops + metro into 4 fixed cards (with the
 * "Dir. Opposta" toggle on Card 2). Custom boards: one card per configured stop.
 */
const TOGGLE_BTN_HTML = `<button class="toggle-direction-btn" onclick="toggleCard1Direction(event)">
           <span class="btn-icon">🔄</span> Dir. Opposta
         </button>`;

/** Builds one departure row of a station card (shared default/custom markup). */
function boardRowHtml(dep, stopId) {
  const isLive = dep.status === 'realtime';

  // Neon green styling for live GPS data, muted amber/gray for timetable estimate
  const timeClass = isLive ? 'realtime-depart' : 'scheduled-depart';
  const badgeClass = isLive ? 'realtime-badge' : 'scheduled-badge';
  const badgeLabel = isLive ? '<span class="pulse-dot"></span>LIVE' : 'ORARIO';

  // Custom line styling if provided by API, otherwise default grey
  const lineStyle = dep.lineColor
    ? `background-color: ${dep.lineColor}; color: ${dep.lineTextColor || '#ffffff'}`
    : '';

  let animationIndicator = '';
  if (dep.minutesRemaining === 1) {
    animationIndicator = getRunnerSvg();
  } else if (dep.minutesRemaining === 0) {
    animationIndicator = getPartingBusSvg();
  }

  let delayBadge = '';
  if (dep.delayMin !== undefined && dep.delayMin !== null) {
    if (dep.delayMin > 0) {
      delayBadge = `<span class="delay-badge delay-late">+${dep.delayMin}m</span>`;
    } else if (dep.delayMin < 0) {
      delayBadge = `<span class="delay-badge delay-early">-${Math.abs(dep.delayMin)}m</span>`;
    } else {
      delayBadge = `<span class="delay-badge delay-ontime">in orario</span>`;
    }
  }

  return `
    <div class="departure-row">
      <div class="line-identifier" style="${lineStyle}">
        ${dep.line}
      </div>
      <div class="route-details">
        <span class="route-direction"><span class="dir-prefix">dir.</span>${dep.direction}</span>
        <span class="route-time-scheduled">
          Orario: <strong>${dep.time}</strong>
          <span class="status-badge ${badgeClass}">${badgeLabel}</span>
          ${delayBadge}
          ${walkBadgeHtml(dep, stopId)}
        </span>
      </div>
      <div class="arrival-countdown">
        <div class="animation-container">
          ${animationIndicator}
        </div>
        <span class="arrival-minutes ${timeClass}">
          ${dep.minutesRemaining}
        </span>
        <span class="arrival-unit">min</span>
      </div>
    </div>
  `;
}

/** Builds a full station card element (header, rows, error & empty states). */
function buildStationCard(station, opts) {
  opts = opts || {};
  const toggleBtnHtml = opts.toggleBtnHtml || '';

  const card = document.createElement('div');
  card.className = 'stop-card';
  if (opts.cardId) card.id = opts.cardId;

  // Handle individual stop errors
  if (station.status === 'error') {
    card.classList.add('error-card');
    card.innerHTML = `
      <div class="stop-header">
        <div class="stop-info">
          <span class="stop-name">${station.stopName}</span>
          <span class="stop-code">ID: ${station.stopId}</span>
        </div>
        <div class="stop-header-actions">
          ${toggleBtnHtml}
          <span class="stop-badge" style="border-color: rgba(255, 74, 74, 0.4); color: #ff4a4a;">Errore</span>
        </div>
      </div>
      <div class="error-message">
        <span class="no-departures-icon">⚠️</span>
        <span>Impossibile caricare le partenze</span>
        <span style="font-size: 0.75rem; opacity: 0.7;">${station.message || 'Errore di rete'}</span>
      </div>
    `;
    return card;
  }

  // Apply the live-only filter unless the Programmati toggle is on.
  const allDepartures = station.departures || [];
  const visibleDepartures = allDepartures.filter(dep => opts.showScheduled || dep.status === 'realtime');
  const hiddenScheduledCount = allDepartures.length - visibleDepartures.length;

  const departuresCount = visibleDepartures.length;
  const badgeText = departuresCount === 1 ? '1 arrivo' : `${departuresCount} arrivi`;

  let departuresHtml = '';
  if (departuresCount === 0) {
    // Empty state inside card. When we're hiding scheduled-only departures,
    // point the user at the Programmati toggle instead of implying no service.
    const emptyHint = (!opts.showScheduled && hiddenScheduledCount > 0)
      ? 'Nessun arrivo in tempo reale · attiva <strong>Programmati</strong> per gli orari'
      : 'Verifica gli orari più tardi';
    departuresHtml = `
      <div class="no-departures">
        <span class="no-departures-icon">⏳</span>
        <p>Nessun bus o tram in arrivo</p>
        <span style="font-size: 0.8rem;">${emptyHint}</span>
      </div>
    `;
  } else {
    departuresHtml = `
      <div class="departures-list">
        ${visibleDepartures.map(dep => boardRowHtml(dep, station.stopId)).join('')}
      </div>
    `;
  }

  // Combine Header and Body inside the card
  card.innerHTML = `
    <div class="stop-header">
      <div class="stop-info">
        <span class="stop-name">${station.stopName}</span>
        <span class="stop-code">ID: ${station.stopId}</span>
      </div>
      <div class="stop-header-actions">
        ${toggleBtnHtml}
        <span class="stop-badge">${badgeText}</span>
      </div>
    </div>
    ${departuresHtml}
  `;

  return card;
}

function renderBoardView(stations) {
  dom.grid = document.getElementById('dashboard-grid');
  if (!dom.grid) return;
  dom.grid.innerHTML = '';

  // Honour the "Programmati" toggle: off (default) shows only live arrivals.
  const boardCheckbox = document.getElementById('board-show-scheduled');
  const showScheduled = boardCheckbox ? boardCheckbox.checked : false;

  // Custom boards: one card per configured stop, in the user's order.
  if (customStops()) {
    if (!stations || !Array.isArray(stations) || stations.length === 0) {
      dom.grid.innerHTML = `
        <div class="stop-card" style="grid-column: span 2; text-align: center; padding: 3rem;">
          <p class="error-message">Nessuna stazione configurata o nessun dato disponibile.</p>
        </div>
      `;
      return;
    }
    stations.forEach((station, displayIndex) => {
      if (!station) return;
      dom.grid.appendChild(buildStationCard(station, { cardId: `card-${displayIndex}`, showScheduled }));
    });
    return;
  }

  if (!stations || !Array.isArray(stations) || stations.length < 4) {
    dom.grid.innerHTML = `
      <div class="stop-card" style="grid-column: span 2; text-align: center; padding: 3rem;">
        <p class="error-message">Nessuna stazione configurata o nessun dato disponibile.</p>
      </div>
    `;
    return;
  }

  // Map 5 backend stop endpoints into exactly 4 display cards matching custom ordering:
  // Card 0 -> STOP_ID_1 (index 0, e.g. 71223)
  // Card 1 -> STOP_ID_2 (index 1, e.g. 72100) OR STOP_ID_2_ALT (index 4, e.g. 81993)
  // Card 2 -> STOP_ID_3 (index 2, e.g. 81953)
  // Card 3 -> STOP_ID_4 (index 3, e.g. 70335)
  const activeStation2 = (card1ShowAlt && stations[4]) ? stations[4] : stations[1];

  const cardStations = [
    { data: stations[0], originalIndex: 0 },
    { data: activeStation2, originalIndex: (card1ShowAlt && stations[4]) ? 4 : 1, isTogglable: !!stations[4] },
    { data: stations[2], originalIndex: 2 },
    { data: stations[3], originalIndex: 3 }
  ];

  cardStations.forEach((cardConfig, displayIndex) => {
    const station = cardConfig.data;
    if (!station) return;
    dom.grid.appendChild(buildStationCard(station, {
      cardId: `card-${displayIndex}`,
      showScheduled,
      toggleBtnHtml: cardConfig.isTogglable ? TOGGLE_BTN_HTML : ''
    }));
  });
}

/**
 * Handles direction toggling for Card 2 between main and alternate stop IDs.
 * Utilizes local cache to instantly re-render without an additional network fetch roundtrip.
 */
window.toggleCard1Direction = function(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  card1ShowAlt = !card1ShowAlt;
  console.log(`[Toggle] Swapping Stop 2. Active alternate state: ${card1ShowAlt}`);
  if (lastTransitData) {
    renderLensView(lastTransitData);
    renderBoardView(lastTransitData);
  }
};

/**
 * Handles critical network/server failure by setting all cards to error state.
 * @param {String} errorMessage - Error details
 */
function renderGeneralError(errorMessage) {
  const containers = [document.getElementById('lens-list'), document.getElementById('dashboard-grid')];
  renderMetroError(errorMessage);
  
  containers.forEach((container) => {
    if (!container) return;
    container.innerHTML = '';
    
    // Renders error message depending on grid layout or lens view layout
    const isGrid = container.id === 'dashboard-grid';
    const cardCount = isGrid ? 4 : 1;
    
    for (let i = 0; i < cardCount; i++) {
      const card = document.createElement('div');
      card.className = 'stop-card error-card';
      if (!isGrid) card.style.width = '100%';
      
      card.innerHTML = `
        <div class="stop-header">
          <div class="stop-info">
            <span class="stop-name">Servizio Non Disponibile</span>
            <span class="stop-code">Tentativo di riconnessione...</span>
          </div>
          <span class="stop-badge" style="border-color: rgba(255, 74, 74, 0.4); color: #ff4a4a;">Errore Server</span>
        </div>
        <div class="error-message">
          <span class="no-departures-icon">🔌</span>
          <span>Errore di comunicazione con il proxy locale</span>
          <p style="font-size: 0.75rem; opacity: 0.7; margin-top: 8px;">Dettaglio: ${errorMessage}</p>
        </div>
      `;
      container.appendChild(card);
    }
  });
}

/**
 * Manages the tick-by-tick countdown of the auto-refresh progress bar.
 */
function startRefreshTimer() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  if (countdownTimerId) clearInterval(countdownTimerId);

  countdownTime = CONFIG.REFRESH_INTERVAL_SEC;
  
  // Initial update
  if (window.innerWidth <= 480) {
    dom.countdownText.textContent = `(${countdownTime}s)`;
  } else {
    dom.countdownText.textContent = `Prossimo aggiornamento in ${countdownTime}s`;
  }
  
  // Ticking function run every second
  countdownTimerId = setInterval(() => {
    countdownTime--;
    
    if (countdownTime <= 0) {
      countdownTime = CONFIG.REFRESH_INTERVAL_SEC;
      fetchTransitData();
    }
    
    // Update countdown text
    if (window.innerWidth <= 480) {
      dom.countdownText.textContent = `(${countdownTime}s)`;
    } else {
      dom.countdownText.textContent = `Prossimo aggiornamento in ${countdownTime}s`;
    }
    
    // Calculate percentage width for shrinking bar
    const percentage = (countdownTime / CONFIG.REFRESH_INTERVAL_SEC) * 100;
    dom.countdownBar.style.width = `${percentage}%`;
  }, 1000);
}

/**
 * TAB 3: Renders the Metro Line C View (direction Colosseo, stop CP22).
 */
function renderMetroView(stations) {
  const metroList = document.getElementById('metro-list');
  const metroNextMins = document.getElementById('metro-next-mins');
  const metroNextScheduled = document.getElementById('metro-next-scheduled');
  
  if (!metroList || !metroNextMins || !metroNextScheduled) return;

  if (!stations || !Array.isArray(stations)) {
    renderMetroError("Nessun dato disponibile.");
    return;
  }

  // Find the Metro Station matching stopId "CP22"
  const metroStation = stations.find(s => s && String(s.stopId) === 'CP22');
  
  if (!metroStation) {
    renderMetroError("Stazione Metro C non trovata nei dati.");
    return;
  }

  if (metroStation.status === 'error') {
    renderMetroError(metroStation.message || "Impossibile recuperare i dati della metro.");
    return;
  }

  const departures = metroStation.departures || [];
  
  // Remove error-card styles if previously added
  const boardEl = document.querySelector('.metro-board');
  if (boardEl) boardEl.classList.remove('metro-error-card');

  if (departures.length === 0) {
    // Empty state
    metroNextMins.textContent = "--";
    metroNextScheduled.textContent = "Orario previsto: --:--";
    metroList.innerHTML = `
      <div class="no-departures">
        <span class="no-departures-icon">⏳</span>
        <p>Nessun treno della Metro C in arrivo</p>
        <span style="font-size: 0.8rem; color: var(--text-muted);">Verifica gli orari più tardi</span>
      </div>
    `;
    return;
  }

  // Next train (Index 0)
  const nextTrain = departures[0];
  const nextIsLive = nextTrain.status === 'realtime';
  
  metroNextMins.textContent = nextTrain.minutesRemaining;
  if (nextIsLive) {
    metroNextMins.style.color = '#00ff9d';
    metroNextMins.style.textShadow = '0 0 20px rgba(0, 255, 157, 0.6)';
  } else {
    metroNextMins.style.color = '#ffaa00';
    metroNextMins.style.textShadow = '0 0 15px rgba(255, 170, 0, 0.4)';
  }
  
  const statusLabel = nextIsLive ? '<span class="pulse-dot"></span>LIVE' : 'ORARIO';
  metroNextScheduled.innerHTML = `Orario tabella: <strong>${nextTrain.time}</strong> <span class="status-badge ${nextIsLive ? 'realtime-badge' : 'scheduled-badge'}" style="margin-left: 6px;">${statusLabel}</span> ${walkBadgeHtml(nextTrain, metroStation.stopId)}`;

  // Update next train animation container if rushed or parting
  const metroAnimContainer = document.getElementById('metro-animation-container');
  if (metroAnimContainer) {
    if (nextTrain.minutesRemaining === 1) {
      metroAnimContainer.innerHTML = getRunnerSvg();
    } else if (nextTrain.minutesRemaining === 0) {
      metroAnimContainer.innerHTML = getPartingBusSvg();
    } else {
      metroAnimContainer.innerHTML = '';
    }
  }
  
  // Ensure unit text remains standard min
  const metroNextUnit = document.querySelector('.metro-next-unit');
  if (metroNextUnit) {
    metroNextUnit.textContent = 'min';
  }

  // Subsequent trains list (Index 1 onwards)
  const subsequent = departures.slice(1);
  if (subsequent.length === 0) {
    metroList.innerHTML = `
      <div style="text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem;">
        Nessuna partenza successiva programmata.
      </div>
    `;
  } else {
    metroList.innerHTML = subsequent.map(dep => {
      const isLive = dep.status === 'realtime';
      const timeColor = isLive ? '#00ff9d' : '#ffaa00';
      const badgeClass = isLive ? 'realtime-badge' : 'scheduled-badge';
      const badgeLabel = isLive ? '<span class="pulse-dot"></span>LIVE' : 'ORARIO';
      
      let animationIndicator = '';
      if (dep.minutesRemaining === 1) {
        animationIndicator = getRunnerSvg();
      } else if (dep.minutesRemaining === 0) {
        animationIndicator = getPartingBusSvg();
      }

      let delayBadge = '';
      if (dep.delayMin !== undefined && dep.delayMin !== null) {
        if (dep.delayMin > 0) {
          delayBadge = `<span class="delay-badge delay-late">+${dep.delayMin}m</span>`;
        } else if (dep.delayMin < 0) {
          delayBadge = `<span class="delay-badge delay-early">-${Math.abs(dep.delayMin)}m</span>`;
        } else {
          delayBadge = `<span class="delay-badge delay-ontime">in orario</span>`;
        }
      }

      return `
        <div class="metro-row">
          <span class="metro-row-dest">${dep.direction}</span>
          <div class="metro-row-meta">
            <span class="metro-row-time">
              Orario: <strong>${dep.time}</strong>
              <span class="status-badge ${badgeClass}" style="margin-left: 6px; font-size: 0.6rem;">${badgeLabel}</span>
              ${delayBadge}
              ${walkBadgeHtml(dep, metroStation.stopId)}
            </span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <div class="animation-container" style="transform: scale(0.85);">
                ${animationIndicator}
              </div>
              <span class="metro-row-countdown" style="color: ${timeColor};">
                ${dep.minutesRemaining} min
              </span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

/**
 * Renders an error layout inside the Metro C tab.
 */
function renderMetroError(message) {
  const metroList = document.getElementById('metro-list');
  const metroNextMins = document.getElementById('metro-next-mins');
  const metroNextScheduled = document.getElementById('metro-next-scheduled');
  
  if (metroNextMins) metroNextMins.textContent = "--";
  if (metroNextScheduled) metroNextScheduled.textContent = "Errore di connessione";
  
  const boardEl = document.querySelector('.metro-board');
  if (boardEl) boardEl.classList.add('metro-error-card');

  if (metroList) {
    metroList.innerHTML = `
      <div class="error-message">
        <span class="no-departures-icon">⚠️</span>
        <span>Impossibile caricare le partenze della metro</span>
        <span style="font-size: 0.75rem; opacity: 0.7;">${message}</span>
      </div>
    `;
  }
}

/**
 * Queries Open-Meteo hourly weather forecast for Rome.
 * Displays current weather and warns if rain is predicted in the next 3 hours.
 */
async function fetchWeather() {
  const weatherWidget = document.getElementById('weather-widget');
  if (!weatherWidget) return;

  try {
    const lat = 41.8856;
    const lon = 12.5098;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,precipitation,weathercode&timezone=Europe/Rome&forecast_days=1`;

    const response = await fetch(url);
    if (!response.ok) throw new Error("Weather service offline");

    const data = await response.json();
    if (!data.hourly || !data.hourly.time) {
      throw new Error("Invalid weather data format");
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const currentHourStr = `${year}-${month}-${day}T${String(now.getHours()).padStart(2, '0')}:00`;
    
    // Find index corresponding to current hour
    let currentIdx = data.hourly.time.findIndex(t => t.startsWith(currentHourStr));
    if (currentIdx === -1) {
      currentIdx = 0;
    }

    // WMO Weather code mapper with animated SVGs
    const getWeatherIcon = (code) => {
      if (code === 0) { // Clear
        return `<svg class="weather-svg sunny-icon" viewBox="0 0 64 64"><circle cx="32" cy="32" r="12" fill="#ffd000" /><g stroke="#ffd000" stroke-width="3" stroke-linecap="round"><line x1="32" y1="8" x2="32" y2="14" /><line x1="32" y1="50" x2="32" y2="56" /><line x1="8" y1="32" x2="14" y2="32" /><line x1="50" y1="32" x2="56" y2="32" /><line x1="15" y1="15" x2="20" y2="20" /><line x1="44" y1="44" x2="49" y2="49" /><line x1="15" y1="49" x2="20" y2="44" /><line x1="44" y1="20" x2="49" y2="15" /></g></svg>`;
      }
      if (code >= 1 && code <= 3) { // Partly cloudy
        return `<svg class="weather-svg cloudy-icon" viewBox="0 0 64 64"><circle class="sun-circle" cx="24" cy="24" r="10" fill="#ffd000" /><path class="cloud-path" d="M46 38a8 8 0 0 1-5 13H22a10 10 0 0 1-1-20 10 10 0 0 1 18-3 8 8 0 0 1 7 10z" fill="#a0a0c0" opacity="0.9" /></svg>`;
      }
      if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82)) { // Rain
        return `<svg class="weather-svg rain-icon" viewBox="0 0 64 64"><path d="M46 32a8 8 0 0 1-5 13H22a10 10 0 0 1-1-20 10 10 0 0 1 18-3 8 8 0 0 1 7 10z" fill="#607d8b" /><g stroke="#40c4ff" stroke-width="3" stroke-linecap="round" fill="none"><line class="rain-drop drop-1" x1="24" y1="46" x2="22" y2="52" /><line class="rain-drop drop-2" x1="32" y1="46" x2="30" y2="52" /><line class="rain-drop drop-3" x1="40" y1="46" x2="38" y2="52" /></g></svg>`;
      }
      if (code >= 95 && code <= 99) { // Thunderstorm
        return `<svg class="weather-svg thunder-icon" viewBox="0 0 64 64"><path d="M46 32a8 8 0 0 1-5 13H22a10 10 0 0 1-1-20 10 10 0 0 1 18-3 8 8 0 0 1 7 10z" fill="#455a64" /><polygon class="lightning" points="32,44 26,52 31,52 28,60 38,50 33,50" fill="#ffd000" /><g stroke="#40c4ff" stroke-width="3" stroke-linecap="round" fill="none"><line class="rain-drop drop-1" x1="22" y1="46" x2="20" y2="52" /><line class="rain-drop drop-2" x1="42" y1="46" x2="40" y2="52" /></g></svg>`;
      }
      // Fog, Snow, Default Cloud
      return `<svg class="weather-svg cloudy-icon" viewBox="0 0 64 64"><path class="cloud-path" d="M46 38a8 8 0 0 1-5 13H22a10 10 0 0 1-1-20 10 10 0 0 1 18-3 8 8 0 0 1 7 10z" fill="#b0bec5" /></svg>`;
    };

    const currentCode = data.hourly.weathercode[currentIdx] ?? 0;
    const currentIcon = getWeatherIcon(currentCode);
    const currentTemp = data.hourly.temperature_2m ? Math.round(data.hourly.temperature_2m[currentIdx]) : '--';

    // Check next 3 hours (currentHour, currentHour+1, currentHour+2)
    let isRainPredicted = false;
    for (let i = 0; i < 3; i++) {
      const idx = currentIdx + i;
      if (idx < data.hourly.time.length) {
        const prob = data.hourly.precipitation_probability[idx] ?? 0;
        const precip = data.hourly.precipitation[idx] ?? 0;
        if (prob >= 20 || precip > 0.1) {
          isRainPredicted = true;
          break;
        }
      }
    }

    // Build the weather widget layout
    let html = `<span>Roma: ${currentIcon} <span class="temp">${currentTemp}°C</span></span>`;
    
    if (isRainPredicted) {
      html += `<span class="rain-alert"><svg class="umbrella-svg" viewBox="0 0 64 64"><path d="M32 30v14a4 4 0 0 0 8 0" stroke="#ff4a4a" stroke-width="4" fill="none" stroke-linecap="round" /><path d="M12 30c0-11 9-20 20-20s20 9 20 20H12z" fill="#ff4a4a" /><circle cx="22" cy="6" r="2" fill="#40c4ff" /><circle cx="32" cy="4" r="2" fill="#40c4ff" /><circle cx="42" cy="6" r="2" fill="#40c4ff" /></svg> Porta l'ombrello!</span>`;
    }

    weatherWidget.innerHTML = html;
  } catch (error) {
    console.warn("Failed to update weather widget:", error);
    weatherWidget.innerHTML = `<span style="font-size: 0.75rem; opacity: 0.6;">Meteo non disponibile</span>`;
  }
}

/**
 * Dynamic SVG animations helper functions
 */
function getRunnerSvg() {
  return `
    <svg class="rushed-svg-big" viewBox="0 0 32 32" fill="none" stroke="currentColor">
      <!-- Wind streams -->
      <path class="wind wind-1" d="M 6 8 Q 3 9 0 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path class="wind wind-2" d="M 5 16 Q 2 17 -1 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path class="wind wind-3" d="M 7 24 Q 4 25 1 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      
      <!-- Runner -->
      <g class="runner-big">
        <!-- Head -->
        <circle cx="20" cy="6" r="2.5" fill="currentColor"/>
        <!-- Torso -->
        <path d="M 18 8.5 L 14 14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
        <!-- Front Arm -->
        <path class="arm-front" d="M 17 9 L 21 11 L 19 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- Back Arm -->
        <path class="arm-back" d="M 17 9 L 13 8 L 10 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
        <!-- Front Leg -->
        <path class="leg-front" d="M 14 14 L 17 19 L 21 21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- Back Leg -->
        <path class="leg-back" d="M 14 14 L 10 17 L 12 22" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
      </g>
    </svg>
  `;
}

function getPartingBusSvg() {
  return `
    <svg class="parting-svg-big" viewBox="0 0 32 32" fill="none" stroke="currentColor">
      <!-- Exhaust puff particles -->
      <g class="smoke-puffs">
        <circle class="smoke-cloud s-1" cx="6" cy="22" r="2.5" fill="currentColor" stroke="none"/>
        <circle class="smoke-cloud s-2" cx="3" cy="23" r="1.8" fill="currentColor" stroke="none"/>
        <circle class="smoke-cloud s-3" cx="5" cy="20" r="1.5" fill="currentColor" stroke="none"/>
      </g>
      
      <!-- Driving bus -->
      <g class="bus-big">
        <!-- Main body -->
        <rect x="8" y="8" width="20" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
        <!-- Front window -->
        <rect x="21" y="10" width="5" height="4" fill="currentColor" stroke="none"/>
        <!-- Back window -->
        <rect x="14" y="10" width="5" height="4" fill="currentColor" stroke="none"/>
        <!-- Wheels -->
        <circle class="wheel w-1" cx="13" cy="21" r="2.5" fill="currentColor" stroke="none"/>
        <circle class="wheel w-2" cx="23" cy="21" r="2.5" fill="currentColor" stroke="none"/>
        <!-- Wheel spokes (rotation) -->
        <line class="spoke w-1-spoke" x1="13" y1="18.5" x2="13" y2="23.5" stroke="var(--bg-base)" stroke-width="1.2"/>
        <line class="spoke w-2-spoke" x1="23" y1="18.5" x2="23" y2="23.5" stroke="var(--bg-base)" stroke-width="1.2"/>
        <!-- Underbody/Exhaust pipe -->
        <path d="M 8 21 L 10 21" stroke="currentColor" stroke-width="1.5"/>
      </g>
    </svg>
  `;
}

function toggleScheduledLens() {
  if (lastTransitData) {
    renderLensView(lastTransitData);
  }
}

function toggleScheduledBoard() {
  if (lastTransitData) {
    renderBoardView(lastTransitData);
  }
}

function toggleScheduledLine() {
  if (lastTransitData) {
    renderLineView(lastTransitData);
  }
}

/**
 * TAB 4: Renders the "Linea Live" timeline view.
 * A SINGLE horizontal rail holding the same buses as the ATAC Lens (preferred
 * lines + hub stops). The 📍 endpoint (right) = arriving now; the left edge =
 * LINE_SCALE_MIN (20) minutes out; buses further away are not drawn. Each bus
 * is the animated bus icon driving on the line; live ones drive (green),
 * scheduled ones are parked (grey). Next one emphasised.
 */
function renderLineView(stations) {
  const container = document.getElementById('line-list');
  if (!container) return;
  container.innerHTML = '';

  if (!stations || !Array.isArray(stations)) {
    container.innerHTML = `<p class="error-message">Nessun dato disponibile per la Linea Live.</p>`;
    return;
  }

  const checkbox = document.getElementById('line-show-scheduled');
  const showScheduled = checkbox ? checkbox.checked : false;

  const SCALE_MIN = LINE_SCALE_MIN; // left edge = 20 min out; right edge (📍) = arriving now

  // Same selection as the ATAC Lens: preferred lines + hub stops (+ night buses).
  const importantLines = getLensLines();
  const hubStopIds = getHubStopIds();
  const nightIncluded = showNightBuses();
  let buses = [];
  stations.forEach(station => {
    if (!station || station.status === 'error' || !station.departures) return;
    station.departures.forEach(dep => {
      const isImportant = importantLines.includes(dep.line);
      const isHub = hubStopIds.includes(String(station.stopId));
      const isNight = nightIncluded && isNightLine(dep.line); // night buses keep the line alive overnight
      if (!(isImportant || isHub || isNight)) return;
      if (!showScheduled && dep.status !== 'realtime') return;
      if (dep.minutesRemaining > SCALE_MIN) return; // outside the 20-minute window
      buses.push({
        line: dep.line,
        direction: dep.direction,
        time: dep.time,
        minutesRemaining: dep.minutesRemaining,
        status: dep.status,
        lineColor: dep.lineColor,
        lineTextColor: dep.lineTextColor,
        stationName: station.stopName
      });
    });
  });

  buses.sort((a, b) => a.minutesRemaining - b.minutesRemaining);
  buses = buses.slice(0, 20); // keep the single rail readable

  if (buses.length === 0) {
    container.innerHTML = `
      <div class="line-empty-full">
        <span class="no-departures-icon">📡</span>
        <p>Nessun bus in arrivo nei prossimi ${SCALE_MIN} minuti</p>
        <span style="font-size: 0.8rem;">${showScheduled
          ? `Linee monitorate: ${escapeHtml(importantLines.join(', '))} + fermate hub`
          : 'Attiva Programmati per vedere anche gli orari'}</span>
      </div>`;
    return;
  }

  let busesHtml = '';
  buses.forEach((dep, idx) => {
    const m = dep.minutesRemaining;
    const clamped = Math.max(0, Math.min(SCALE_MIN, m));
    // Map minutes to a 2%..98% position so markers stay on the rail.
    const leftPct = 2 + (1 - clamped / SCALE_MIN) * 96;
    const isLive = dep.status === 'realtime';
    const isNext = idx === 0;
    const place = (idx % 2 === 0) ? 'above' : 'below'; // alternate to separate bunched buses
    const lineStyle = dep.lineColor
      ? `background-color: ${dep.lineColor}; color: ${dep.lineTextColor || '#ffffff'}; border-color: transparent;`
      : '';
    const cls = `line-bus ${place} ${isLive ? 'live' : 'scheduled'}${isNext ? ' next' : ''}`;
    const safeDir = String(dep.direction || '').replace(/"/g, '&quot;');
    const safeStation = String(dep.stationName || '').replace(/"/g, '&quot;');
    const title = `${dep.line} → ${safeDir} · ${safeStation} · ${dep.time}${isLive ? ' · LIVE' : ' · orario'}`;
    // DOM order [badge, min, icon] so the bus icon is the element nearest the rail.
    busesHtml += `
      <div class="${cls}" style="left: ${leftPct}%;" title="${title}">
        <span class="line-bus-badge" style="${lineStyle}">${dep.line}</span>
        <span class="line-bus-min">${m}'</span>
        <span class="line-bus-icon">${getPartingBusSvg()}</span>
      </div>`;
  });

  container.innerHTML = `
    <div class="line-single">
      <div class="line-track">
        <span class="line-scale-label">${SCALE_MIN}'</span>
        <div class="line-rail-wrap">
          <div class="line-rail"></div>
          ${busesHtml}
        </div>
        <span class="line-endpoint" title="In arrivo ora">📍</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Settings panel (⚙️): pick your own stops/directions/lines, share config links
// ---------------------------------------------------------------------------
let editingConfig = null;     // working copy bound to the open modal
let stopSearchResults = [];   // last /api/stops results shown in the dropdown
let stopSearchTimer = null;

window.openSettings = function () {
  editingConfig = buildEditingConfig();
  renderSettingsStops();

  const linesInput = document.getElementById('settings-lines');
  if (linesInput) linesInput.value = editingConfig.lines.join(', ');
  const nightInput = document.getElementById('settings-night');
  if (nightInput) nightInput.checked = editingConfig.showNight !== false;
  const search = document.getElementById('stop-search');
  if (search) search.value = '';
  renderStopSearchResults([]);

  document.getElementById('settings-overlay').classList.add('open');
};

window.closeSettings = function () {
  document.getElementById('settings-overlay').classList.remove('open');
  editingConfig = null;
};

function buildEditingConfig() {
  if (userConfig) {
    const copy = sanitizeConfig(JSON.parse(JSON.stringify(userConfig))) || { stops: [], lines: [], showNight: true };
    return {
      stops: copy.stops.length ? copy.stops : defaultStopsForEditing(),
      lines: copy.lines.length ? copy.lines : DEFAULTS.LENS_LINES.slice(),
      showNight: copy.showNight !== false
    };
  }
  return { stops: defaultStopsForEditing(), lines: DEFAULTS.LENS_LINES.slice(), showNight: true };
}

/** Prefills the editor with the server's default stops (names from the last fetch). */
function defaultStopsForEditing() {
  if (!Array.isArray(lastTransitData)) return [];
  return lastTransitData.map(station => ({
    id: String(station.stopId),
    name: station.stopName || '',
    hub: DEFAULTS.HUB_STOPS.includes(String(station.stopId)),
    dir: '',
    walk: 0
  }));
}

function renderSettingsStops() {
  const wrap = document.getElementById('settings-stops');
  if (!wrap || !editingConfig) return;

  if (editingConfig.stops.length === 0) {
    wrap.innerHTML = `<p class="settings-empty">Nessuna fermata configurata: cercane una qui sopra per iniziare.</p>`;
    return;
  }

  wrap.innerHTML = editingConfig.stops.map((s, i) => `
    <div class="settings-stop-row">
      <div class="settings-stop-main">
        <span class="settings-stop-code">${escapeHtml(s.id)}</span>
        <span class="settings-stop-name">${escapeHtml(s.name || 'Fermata ' + s.id)}</span>
        <button class="settings-remove-btn" onclick="removeSettingsStop(${i})" title="Rimuovi fermata">✕</button>
      </div>
      <div class="settings-stop-opts">
        <label class="settings-opt" title="Mostra tutte le linee di questa fermata nell'ATAC Lens e nella Linea Live">
          <input type="checkbox" ${s.hub ? 'checked' : ''} onchange="updateSettingsStop(${i}, 'hub', this.checked)"> Hub (tutte le linee)
        </label>
        <label class="settings-opt">dir. contiene
          <input type="text" value="${escapeHtml(s.dir)}" maxlength="40" placeholder="es. Termini"
            oninput="updateSettingsStop(${i}, 'dir', this.value)">
        </label>
        <label class="settings-opt">🚶
          <input type="number" value="${s.walk || ''}" min="0" max="120" placeholder="0"
            oninput="updateSettingsStop(${i}, 'walk', this.value)"> min a piedi
        </label>
      </div>
    </div>
  `).join('');
}

window.updateSettingsStop = function (index, field, value) {
  if (!editingConfig || !editingConfig.stops[index]) return;
  if (field === 'hub') {
    editingConfig.stops[index].hub = !!value;
  } else if (field === 'dir') {
    editingConfig.stops[index].dir = String(value).slice(0, 40);
  } else if (field === 'walk') {
    const walk = parseInt(value, 10);
    editingConfig.stops[index].walk = (!isNaN(walk) && walk > 0 && walk <= 120) ? walk : 0;
  }
};

window.removeSettingsStop = function (index) {
  if (!editingConfig) return;
  editingConfig.stops.splice(index, 1);
  renderSettingsStops();
};

window.onStopSearchInput = function () {
  const input = document.getElementById('stop-search');
  if (!input) return;
  const query = input.value.trim();
  if (stopSearchTimer) clearTimeout(stopSearchTimer);
  if (query.length < 2) {
    renderStopSearchResults([]);
    return;
  }
  stopSearchTimer = setTimeout(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/stops?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      renderStopSearchResults(Array.isArray(data.stops) ? data.stops : [], query, !response.ok);
    } catch (err) {
      renderStopSearchResults([], query, true);
    }
  }, 300);
};

function renderStopSearchResults(results, query, searchUnavailable) {
  const box = document.getElementById('stop-search-results');
  if (!box) return;
  stopSearchResults = results;

  let html = results.map((s, i) => `
    <button class="stop-search-item" onclick="addSearchResult(${i})">
      <span class="stop-search-code">${escapeHtml(s.code || s.id)}</span>
      <span class="stop-search-name">${escapeHtml(s.name)}</span>
    </button>
  `).join('');

  // Manual fallback: a plausible code can always be added as typed (the regex
  // also guarantees the value is safe to inline in the onclick handler).
  if (query && /^[A-Za-z0-9_-]{3,24}$/.test(query)) {
    html += `
      <button class="stop-search-item manual" onclick="addManualStop('${query}')">
        ➕ Aggiungi il codice "${query}"${searchUnavailable ? ' (ricerca non disponibile)' : ''}
      </button>`;
  }

  box.innerHTML = html;
  box.style.display = html ? '' : 'none';
}

window.addSearchResult = function (index) {
  const s = stopSearchResults[index];
  if (!s) return;
  addStopToEditing({ id: String(s.code || s.id), name: s.name || '' });
};

window.addManualStop = function (code) {
  addStopToEditing({ id: String(code), name: '' });
};

function addStopToEditing(stop) {
  if (!editingConfig) return;
  if (editingConfig.stops.some(s => s.id === stop.id)) return;
  if (editingConfig.stops.length >= 10) {
    alert('Massimo 10 fermate per board.');
    return;
  }
  editingConfig.stops.push({ id: stop.id, name: stop.name, hub: false, dir: '', walk: 0 });
  renderSettingsStops();
  const input = document.getElementById('stop-search');
  if (input) input.value = '';
  renderStopSearchResults([]);
}

/** Folds the free-form inputs (lines, night toggle) into the working copy. */
function collectEditingConfig() {
  const linesInput = document.getElementById('settings-lines');
  const nightInput = document.getElementById('settings-night');
  return sanitizeConfig({
    ...editingConfig,
    lines: (linesInput ? linesInput.value : '').split(',').map(s => s.trim()).filter(Boolean),
    showNight: nightInput ? nightInput.checked : true
  });
}

window.saveSettings = function () {
  if (!editingConfig) return;
  persistUserConfig(collectEditingConfig());
  closeSettings();
  onConfigChanged();
};

window.resetSettings = function () {
  persistUserConfig(null);
  closeSettings();
  onConfigChanged();
};

window.copyConfigLink = function () {
  if (!editingConfig) return;
  const cfg = collectEditingConfig();
  if (!cfg) return;

  const json = JSON.stringify(cfg);
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const link = `${window.location.origin}${window.location.pathname}#cfg=${b64}`;

  const btn = document.getElementById('copy-link-btn');
  const confirmCopied = () => {
    if (!btn) return;
    btn.textContent = '✅ Link copiato!';
    setTimeout(() => { btn.textContent = '🔗 Copia link config'; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(confirmCopied).catch(() => window.prompt('Copia il link:', link));
  } else {
    window.prompt('Copia il link:', link);
  }
};

/** Re-fetches and re-renders everything after a config change. */
function onConfigChanged() {
  applyConfigSideEffects();
  lastTransitData = null;
  fetchTransitData();
  fetchAlerts();
  startRefreshTimer();
}

// ---------------------------------------------------------------------------
// ATAC service alerts (strikes, detours, closures) from /api/alerts
// ---------------------------------------------------------------------------
let alertsExpanded = false;
let lastAlerts = [];

async function fetchAlerts() {
  const banner = document.getElementById('alerts-banner');
  if (!banner) return;
  try {
    const response = await fetch(`${API_BASE}/api/alerts`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    lastAlerts = Array.isArray(data.alerts) ? data.alerts : [];
    renderAlerts();
  } catch (err) {
    console.warn('[Alerts] Aggiornamento avvisi fallito:', err);
    banner.style.display = 'none';
  }
}

/** Lines worth alerting on: preferred lines + everything in the last fetch. */
function relevantLineSet() {
  const set = new Set(getLensLines().map(line => String(line).toUpperCase()));
  if (Array.isArray(lastTransitData)) {
    lastTransitData.forEach(station => {
      ((station && station.departures) || []).forEach(dep => set.add(String(dep.line).toUpperCase()));
    });
  }
  return set;
}

function relevantStopIdSet() {
  const ids = customStopIds();
  if (ids) return new Set(ids);
  if (Array.isArray(lastTransitData)) {
    return new Set(lastTransitData.map(station => String(station && station.stopId)));
  }
  return new Set();
}

function renderAlerts() {
  const banner = document.getElementById('alerts-banner');
  if (!banner) return;

  const myLines = relevantLineSet();
  const myStops = relevantStopIdSet();

  // Keep alerts touching our lines/stops, plus citywide ones (e.g. strikes).
  const relevant = lastAlerts.filter(alert => {
    const routes = (alert.routes || []).map(r => String(r).toUpperCase());
    const citywide = routes.length === 0 && (!alert.stopIds || alert.stopIds.length === 0);
    return citywide
      || routes.some(r => myLines.has(r))
      || (alert.stopIds || []).some(s => myStops.has(String(s)));
  }).slice(0, 6);

  if (relevant.length === 0) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  const itemsHtml = relevant.map(alert => {
    const badges = (alert.routes || []).slice(0, 6)
      .map(r => `<span class="alert-route">${escapeHtml(r)}</span>`).join('');
    const description = (alert.description && alert.description !== alert.header)
      ? `<div class="alert-desc">${escapeHtml(String(alert.description).slice(0, 400))}</div>`
      : '';
    return `
      <div class="alert-item">
        <div class="alert-item-head">${badges}<span class="alert-header-text">${escapeHtml(alert.header || 'Avviso ATAC')}</span></div>
        ${description}
      </div>`;
  }).join('');

  banner.style.display = '';
  banner.innerHTML = `
    <button class="alerts-summary" onclick="toggleAlerts()">
      <span class="alerts-icon">⚠️</span>
      <span class="alerts-count">${relevant.length === 1 ? '1 avviso di servizio ATAC' : `${relevant.length} avvisi di servizio ATAC`}</span>
      <span class="alerts-caret">${alertsExpanded ? '▲' : '▼'}</span>
    </button>
    <div class="alerts-list" style="display: ${alertsExpanded ? 'block' : 'none'};">${itemsHtml}</div>
  `;
}

window.toggleAlerts = function () {
  alertsExpanded = !alertsExpanded;
  renderAlerts();
};

// Kickstart dashboard systems on page load
window.addEventListener('DOMContentLoaded', () => {
  initClock();
  applyConfigSideEffects(); // metro tab visibility + subheaders follow the config
  fetchTransitData();
  fetchWeather(); // Fetch weather on load
  fetchAlerts();
  startRefreshTimer();

  // Fetch weather every 5 minutes (300,000 ms)
  setInterval(fetchWeather, 300000);
  setInterval(fetchAlerts, CONFIG.ALERTS_REFRESH_SEC * 1000);
});
