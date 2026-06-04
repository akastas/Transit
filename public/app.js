/**
 * app.js - Frontend client logic for Rome Transit Dashboard (ATAC Lens & Tabs)
 * 
 * Functions:
 * 1. Digital clock & date update (Rome/Italy timezone formatting)
 * 2. Asynchronous transit data retrieval from backend (/api/transit)
 * 3. 45-second count-down timer with animated visual progress bar
 * 4. Tab routing switcher ('lens' vs 'board' views)
 * 5. ATAC Lens commute filter (Lines 81, 85, 87, 360 & all lines at Carlo Felice)
 * 6. Interactive opposite direction toggle for Card 2 in Board view
 */

// Dashboard State Configurations
const CONFIG = {
  REFRESH_INTERVAL_SEC: 45,
  API_URL: '/api/transit'
};

// Global State
let countdownTime = CONFIG.REFRESH_INTERVAL_SEC;
let refreshTimerId = null;
let countdownTimerId = null;

// Tab Selection & Toggle States
let activeTab = 'lens';      // Selected tab view: 'lens' (default) or 'board'
let card1ShowAlt = false;    // Toggles between index 1 (72100) and index 4 (81993) for Card 2
let lastTransitData = null;  // Holds client-side cache of last API fetch

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
    const response = await fetch(CONFIG.API_URL);
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    
    const transitData = await response.json();
    lastTransitData = transitData; // Store cache for instantaneous direction toggles
    
    // Update both views
    renderLensView(transitData);
    renderBoardView(transitData);
    
    // Update "last updated" timestamp
    const now = new Date();
    dom.lastUpdated.textContent = now.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch (error) {
    console.error('Failed to retrieve transit data:', error);
    renderGeneralError(error.message);
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
  
  // Toggle view containers state
  document.getElementById('lens-view').classList.toggle('active', tabName === 'lens');
  document.getElementById('board-view').classList.toggle('active', tabName === 'board');
  
  console.log(`[Tabs] Displaying view: ${tabName}`);
};

/**
 * TAB 1: Renders the ATAC Lens View
 * Aggregates all departures, filters for important lines (81, 85, 87, 360) 
 * or station 72100/81993, and sorts them by minutes remaining.
 */
function renderLensView(stations) {
  dom.lensList = document.getElementById('lens-list');
  if (!dom.lensList) return;
  dom.lensList.innerHTML = '';

  if (!stations || !Array.isArray(stations) || stations.length < 4) {
    dom.lensList.innerHTML = `<p class="error-message">Nessun dato disponibile per il Radar.</p>`;
    return;
  }

  const importantLines = ['81', '85', '87', '360'];
  let aggregatedDepartures = [];

  // Loop through all retrieved stations (including default & alternate ones)
  stations.forEach(station => {
    if (!station || station.status === 'error' || !station.departures) return;

    station.departures.forEach(dep => {
      const isImportantLine = importantLines.includes(dep.line);
      // Includes both directions of the Porta S. Giovanni / Carlo Felice hub
      const isCarloFeliceHub = station.stopId === '72100' || station.stopId === '81993';

      if (isImportantLine || isCarloFeliceHub) {
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
    dom.lensList.innerHTML = `
      <div class="no-departures">
        <span class="no-departures-icon">📡</span>
        <p>Nessun bus importante rilevato nei paraggi</p>
        <span style="font-size: 0.8rem;">Vengono monitorate le linee 81, 85, 87, 360 e il nodo Carlo Felice</span>
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
    const badgeLabel = isLive ? 'LIVE' : 'ORARIO';
    
    const lineStyle = dep.lineColor 
      ? `background-color: ${dep.lineColor}; color: ${dep.lineTextColor || '#ffffff'}`
      : '';

    row.innerHTML = `
      <div class="line-identifier" style="${lineStyle}">
        ${dep.line}
      </div>
      <div class="route-details">
        <span class="route-direction">${dep.direction}</span>
        <span class="route-station">
          Arrivo a <strong>${dep.stationName}</strong>
          <span class="status-badge ${badgeClass}" style="margin-left: 6px;">${badgeLabel}</span>
        </span>
      </div>
      <div class="arrival-countdown">
        <div style="text-align: right; display: flex; flex-direction: column; justify-content: center;">
          <span style="font-size: 0.8rem; color: var(--text-muted); font-family: var(--font-mono);">Tabella: ${dep.time}</span>
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
 * TAB 2: Renders the 4-card Station Board View.
 */
function renderBoardView(stations) {
  dom.grid = document.getElementById('dashboard-grid');
  if (!dom.grid) return;
  dom.grid.innerHTML = ''; 

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

    const card = document.createElement('div');
    card.className = 'stop-card';
    card.id = `card-${displayIndex}`;

    // Handle individual stop errors
    if (station.status === 'error') {
      card.classList.add('error-card');
      
      const toggleBtnHtml = cardConfig.isTogglable
        ? `<button class="toggle-direction-btn" onclick="toggleCard1Direction(event)">
             <span class="btn-icon">🔄</span> Dir. Opposta
           </button>`
        : '';

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
      dom.grid.appendChild(card);
      return;
    }

    // Build header actions with optional invert button
    const departuresCount = station.departures ? station.departures.length : 0;
    const badgeText = departuresCount === 1 ? '1 arrivo' : `${departuresCount} arrivi`;
    
    const toggleBtnHtml = cardConfig.isTogglable
      ? `<button class="toggle-direction-btn" onclick="toggleCard1Direction(event)">
           <span class="btn-icon">🔄</span> Dir. Opposta
         </button>`
      : '';

    let departuresHtml = '';
    
    if (departuresCount === 0) {
      // Empty state inside card if no departures are scheduled
      departuresHtml = `
        <div class="no-departures">
          <span class="no-departures-icon">⏳</span>
          <p>Nessun bus o tram in arrivo</p>
          <span style="font-size: 0.8rem;">Verifica gli orari più tardi</span>
        </div>
      `;
    } else {
      // Loop and build departure rows
      departuresHtml = `
        <div class="departures-list">
          ${station.departures.map(dep => {
            const isLive = dep.status === 'realtime';
            
            // Neon green styling for live GPS data, muted amber/gray for timetable estimate
            const timeClass = isLive ? 'realtime-depart' : 'scheduled-depart';
            const badgeClass = isLive ? 'realtime-badge' : 'scheduled-badge';
            const badgeLabel = isLive ? 'LIVE' : 'ORARIO';
            
            // Custom line styling if provided by API, otherwise default grey
            const lineStyle = dep.lineColor 
              ? `background-color: ${dep.lineColor}; color: ${dep.lineTextColor || '#ffffff'}`
              : '';

            return `
              <div class="departure-row">
                <div class="line-identifier" style="${lineStyle}">
                  ${dep.line}
                </div>
                <div class="route-details">
                  <span class="route-direction">${dep.direction}</span>
                  <span class="route-time-scheduled">
                    Orario: <strong>${dep.time}</strong>
                    <span class="status-badge ${badgeClass}">${badgeLabel}</span>
                  </span>
                </div>
                <div class="arrival-countdown">
                  <span class="arrival-minutes ${timeClass}">
                    ${dep.minutesRemaining}
                  </span>
                  <span class="arrival-unit">min</span>
                </div>
              </div>
            `;
          }).join('')}
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

    dom.grid.appendChild(card);
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
  
  // Ticking function run every second
  countdownTimerId = setInterval(() => {
    countdownTime--;
    
    if (countdownTime <= 0) {
      countdownTime = CONFIG.REFRESH_INTERVAL_SEC;
      fetchTransitData();
    }
    
    // Update countdown text
    dom.countdownText.textContent = `Prossimo aggiornamento in ${countdownTime}s`;
    
    // Calculate percentage width for shrinking bar
    const percentage = (countdownTime / CONFIG.REFRESH_INTERVAL_SEC) * 100;
    dom.countdownBar.style.width = `${percentage}%`;
  }, 1000);
}

// Kickstart dashboard systems on page load
window.addEventListener('DOMContentLoaded', () => {
  initClock();
  fetchTransitData();
  startRefreshTimer();
});
