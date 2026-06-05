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
  // Automatically fallback to port 5050 if loading static files on standard dev ports or via file://
  API_URL: (window.location.protocol === 'file:' || (window.location.hostname === 'localhost' && window.location.port !== '5050' && window.location.port !== '5000'))
    ? 'http://localhost:5050/api/transit'
    : '/api/transit'
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
    
    // Update all views
    renderLensView(transitData);
    renderBoardView(transitData);
    renderMetroView(transitData);
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
  
  // Toggle view containers state
  document.getElementById('lens-view').classList.toggle('active', tabName === 'lens');
  document.getElementById('board-view').classList.toggle('active', tabName === 'board');
  document.getElementById('metro-view').classList.toggle('active', tabName === 'metro');
  
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

  const checkbox = document.getElementById('lens-show-scheduled');
  const showScheduled = checkbox ? checkbox.checked : false;

  const importantLines = ['81', '85', '87', '360'];
  let aggregatedDepartures = [];

  // Loop through all retrieved stations (including default & alternate ones)
  stations.forEach(station => {
    if (!station || station.status === 'error' || !station.departures) return;

    station.departures.forEach(dep => {
      const isImportantLine = importantLines.includes(dep.line);
      // Includes both directions of the Porta S. Giovanni / Carlo Felice hub
      const isCarloFeliceHub = String(station.stopId) === '72100' || String(station.stopId) === '81993';

      if (isImportantLine || isCarloFeliceHub) {
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
  metroNextScheduled.innerHTML = `Orario tabella: <strong>${nextTrain.time}</strong> <span class="status-badge ${nextIsLive ? 'realtime-badge' : 'scheduled-badge'}" style="margin-left: 6px;">${statusLabel}</span>`;

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

// Kickstart dashboard systems on page load
window.addEventListener('DOMContentLoaded', () => {
  initClock();
  fetchTransitData();
  fetchWeather(); // Fetch weather on load
  startRefreshTimer();
  
  // Fetch weather every 5 minutes (300,000 ms)
  setInterval(fetchWeather, 300000);
});
