# Rome Public Transit Dashboard (Transitland Edition)

A self-hosted, lightweight, and robust public transit arrivals dashboard designed for a wall-mounted tablet or screen in an apartment in Rome. It displays real-time departures for 4 specific transit stops (bus/tram/metro) using the **Transitland v2 REST API**, bypassing CORS restrictions with a local Node.js proxy.

## Key Features
- **High-Contrast Dark Theme**: Beautiful glassmorphic design optimized for legibility from across a room.
- **Auto-Refresh**: Live clock and a 45-second ticking refresh cycle with a visual progress countdown bar.
- **Trustworthiness Indicators**: Neon green glowing badges for genuine real-time GPS coordinates, and amber/gray badges for schedule estimates.
- **Transit Branding**: Dynamically matches official Rome/ATAC line colors (e.g., green for Tram 8, red for Tram 3) using hex colors fetched directly from the API.
- **Resilient Architecture**: Fails gracefully. If Rome's transit feed lags or a stop fails, only that stop card enters an error state; the server remains online and the rest of the board continues to function.
- **Smart Mapping & Caching**: Supports both worldwide Onestop IDs (e.g. `s-sr2yk502s5-plebiscito`) and local 5-digit ATAC stop codes (e.g. `70030`). Local codes are automatically resolved to Onestop IDs on the first request and cached in-memory.

---

## Folder Structure

```
├── .env.example            # Environment variables template
├── .env                    # Active environment variables (gitignored)
├── package.json            # Node.js dependencies & scripts
├── server.js               # Node.js Express proxy server
└── public/                 # Static frontend files served by Express
    ├── index.html          # Dashboard HTML structure
    ├── style.css           # Premium glassmorphic stylesheets
    └── app.js              # Client side fetch & countdown loop
```

---

## Setup & Configuration

### 1. Prerequisites
- **Node.js** (v18+ recommended)
- **NPM** (Node Package Manager)
- **Transitland API Key**: Obtain a free developer key from [Transit.land](https://www.transit.land/).

### 2. Configuration
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill in your settings:
```ini
PORT=5000
TRANSITLAND_APIKEY=your-transitland-api-key-here
TRANSITLAND_FEED=f-sr-atac~romatpl~trenitalia

# Configured Stop IDs (exactly 4)
# You can use:
# 1. 5-digit local ATAC codes: 70030, 72013, etc.
# 2. Complete Transitland Onestop IDs: s-sr2yk502s5-plebiscito
STOP_ID_1=70030
STOP_ID_2=72013
STOP_ID_3=70135
STOP_ID_4=71836
```

### 3. Installation
Install the project dependencies in your project directory:
```bash
npm install
```

---

## Running the Application

### Running Locally (Development)
To run the server locally with auto-reload:
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:5000` to view the dashboard.

To run standard production start:
```bash
npm start
```

---

## Production Deployment on a Linux VPS (using PM2)

To run the application continuously in the background on your VPS, it is recommended to use **PM2** (Process Manager 2).

### 1. Install PM2 Globally
If PM2 is not already installed on your server, install it via NPM:
```bash
sudo npm install -g pm2
```

### 2. Start the Application
Start the proxy server as a background service:
```bash
pm2 start server.js --name "rome-transit-dashboard"
```

### 3. Manage and Monitor the Process
- **View Dashboard Status**:
  ```bash
  pm2 status
  ```
- **View Live Application Logs**:
  ```bash
  pm2 logs rome-transit-dashboard
  ```
- **Restart the Dashboard**:
  ```bash
  pm2 restart rome-transit-dashboard
  ```
- **Stop the Dashboard**:
  ```bash
  pm2 stop rome-transit-dashboard
  ```

### 4. Enable Startup Persistence (Optional)
To ensure the dashboard automatically restarts if the VPS reboots:
1. Generate the system configuration startup script:
   ```bash
   pm2 startup
   ```
2. Copy/paste the command outputted by the terminal (usually running a systemd command).
3. Save the currently running process list:
   ```bash
   pm2 save
   ```

---

## Accessing the Dashboard from a Wall Tablet
Once the server is running on `http://YOUR_VPS_IP:5000`:
- **Direct Access**: You can point your tablet's browser directly to `http://YOUR_VPS_IP:5000`.
- **Reverse Proxy (Nginx)**: If you want to use a domain name with SSL (HTTPS), configure an Nginx site file to reverse-proxy port `5000`:
  ```nginx
  server {
      listen 80;
      server_name transit.my-apartment.com;

      location / {
          proxy_pass http://127.0.0.1:5000;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection 'upgrade';
          proxy_set_header Host $host;
          proxy_cache_bypass $http_upgrade;
      }
  }
  ```
