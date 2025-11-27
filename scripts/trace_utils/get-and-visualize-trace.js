#!/usr/bin/env node

/**
 * Get raw ADSB trace data for a specific aircraft and generate an HTML visualization
 * 
 * Usage:
 *   node scripts/trace_utils/get-and-visualize-trace.js --icao <ICAO_CODE> --date <YYYY-MM-DD> [--airport <AIRPORT>] [--thin N]
 * 
 * Example:
 *   node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06
 *   node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06 --airport KORD
 *   node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06 --thin 5
 * 
 * The script will:
 * 1. If --airport is provided: Download extracted traces for that airport (faster, smaller)
 * 2. Otherwise: Download the full raw tar file from S3 (slower, but works for any aircraft)
 * 3. Extract the tar file (if not already extracted)
 * 4. Find and read the trace file for the specified ICAO code
 * 5. Save the trace data to cache/traces/trace_<icao>_<date>.txt
 * 6. Generate an HTML visualization to cache/traces/trace_<icao>_<date>.html
 * 
 * Files are cached in ./temp/ to avoid re-downloading.
 * Output files are saved to cache/traces/ (excluded from git).
 */

import TraceReader from '../../src/processing/TraceReader.js';
import logger from '../../src/utils/logger.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadAirportConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports.filter(a => a.enabled);
}

const args = process.argv.slice(2);
let icao = null;
let date = null;
let airport = null;
let thinFactor = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--icao' && args[i + 1]) {
    icao = args[i + 1].toLowerCase();
    i++;
  } else if (args[i] === '--date' && args[i + 1]) {
    date = args[i + 1];
    i++;
  } else if (args[i] === '--airport' && args[i + 1]) {
    airport = args[i + 1].toUpperCase();
    i++;
  } else if (args[i] === '--thin' && args[i + 1]) {
    thinFactor = parseInt(args[i + 1], 10);
    if (isNaN(thinFactor) || thinFactor < 1) {
      console.error('Error: --thin must be a positive integer');
      process.exit(1);
    }
    i++;
  }
}

if (!icao || !date) {
  console.error('Usage: node scripts/trace_utils/get-and-visualize-trace.js --icao <ICAO_CODE> --date <YYYY-MM-DD> [--airport <AIRPORT>] [--thin N]');
  console.error('Example: node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06');
  console.error('         node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06 --airport KORD');
  console.error('         node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06 --thin 5');
  process.exit(1);
}

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
if (!dateRegex.test(date)) {
  console.error('Error: Date must be in YYYY-MM-DD format');
  process.exit(1);
}

const icaoRegex = /^[0-9a-f]{6}$/i;
if (!icaoRegex.test(icao)) {
  console.error('Error: ICAO code must be 6 hexadecimal characters');
  process.exit(1);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

async function getAndVisualizeTrace() {
  try {
    logger.info('Getting and visualizing aircraft trace', { icao, date, airport });

    const traceReader = new TraceReader();

    let extractDir;
    if (airport) {
      // Use extracted traces for the specified airport (faster, smaller)
      logger.info('Step 1: Downloading extracted traces for airport', { airport, date });
      extractDir = await traceReader.downloadExtractedTraces(airport, date);
      
      if (!extractDir) {
        logger.warn('Extracted traces not found, falling back to full raw tar', { airport, date });
        logger.info('Step 1: Downloading/checking full raw tar file', { date });
        const tarPath = await traceReader.downloadTarFromS3(date);
        logger.info('Step 2: Extracting/checking extracted tar', { date });
        extractDir = await traceReader.extractTar(tarPath);
      } else {
        logger.info('Using extracted traces', { airport, date, extractDir });
      }
    } else {
      // Try all enabled airports' extracted traces first
      const enabledAirports = loadAirportConfig();
      logger.info('Step 1: Searching extracted traces for all enabled airports', { 
        date, 
        airports: enabledAirports.map(a => a.icao).join(', ') 
      });
      
      extractDir = null;
      let foundAirport = null;
      
      for (const airportConfig of enabledAirports) {
        const testExtractDir = await traceReader.downloadExtractedTraces(airportConfig.icao, date);
        if (testExtractDir) {
          // Check if the trace file exists for this ICAO
          const hexSubdir = icao.slice(-2);
          const tracesDir = path.join(testExtractDir, 'traces');
          const subdirPath = path.join(tracesDir, hexSubdir);
          const traceFilePath = path.join(subdirPath, `trace_full_${icao}.json`);
          
          if (fs.existsSync(traceFilePath)) {
            extractDir = testExtractDir;
            foundAirport = airportConfig.icao;
            logger.info('Found trace in extracted traces', { 
              airport: foundAirport, 
              date, 
              extractDir 
            });
            break;
          }
        }
      }
      
      if (!extractDir) {
        // Fall back to full raw tar only if not found in any extracted traces
        logger.info('Step 2: Trace not found in extracted traces, downloading full raw tar', { date });
        const tarPath = await traceReader.downloadTarFromS3(date);
        logger.info('Step 3: Extracting/checking extracted tar', { date });
        extractDir = await traceReader.extractTar(tarPath);
      }
    }

    const hexSubdir = icao.slice(-2);
    const tracesDir = path.join(extractDir, 'traces');
    const subdirPath = path.join(tracesDir, hexSubdir);
    const traceFilePath = path.join(subdirPath, `trace_full_${icao}.json`);

    if (!fs.existsSync(traceFilePath)) {
      logger.error('Trace file not found', {
        icao,
        date,
        expectedPath: traceFilePath,
      });
      console.error(`Error: No trace data found for ICAO ${icao} on ${date}`);
      console.error(`Expected file: ${traceFilePath}`);
      process.exit(1);
    }

    logger.info('Step 3: Reading trace file', { icao, date, traceFilePath, extractDir });
    const traceData = await traceReader.readTraceFile(traceFilePath);

    if (!traceData) {
      logger.error('Failed to read trace file', { icao, date, traceFilePath });
      console.error(`Error: Failed to read trace file for ICAO ${icao}`);
      process.exit(1);
    }

    const output = {
      icao: traceData.icao,
      date,
      registration: traceData.registration,
      aircraftType: traceData.aircraftType,
      description: traceData.description,
      trace: traceData.trace,
      traceCount: traceData.trace ? traceData.trace.length : 0,
    };

    const cacheTracesDir = path.join(__dirname, '..', '..', 'cache', 'traces');
    if (!fs.existsSync(cacheTracesDir)) {
      fs.mkdirSync(cacheTracesDir, { recursive: true });
    }

    const traceFileName = `trace_${icao}_${date}.txt`;
    const traceFilePath_output = path.join(cacheTracesDir, traceFileName);
    fs.writeFileSync(traceFilePath_output, JSON.stringify(output, null, 2));
    logger.info('Trace data written to file', { 
      icao, 
      date, 
      outputPath: traceFilePath_output,
      traceCount: output.traceCount,
    });
    console.log(`✓ Trace data written to: ${traceFilePath_output}`);
    console.log(`  Found ${output.traceCount} position reports for ICAO ${icao} on ${date}`);

    if (!output.trace || !Array.isArray(output.trace)) {
      console.error('Invalid trace data: missing trace array');
      process.exit(1);
    }

    const points = [];
    let minAlt = Infinity;
    let maxAlt = -Infinity;

    for (const point of output.trace) {
      if (!Array.isArray(point) || point.length < 4) continue;
      
      const timestamp = point[0];
      const lat = point[1];
      const lon = point[2];
      const alt = point[3];
      const gs = point[4] || null;
      const track = point[5] || null;
      
      if (lat === null || lon === null || alt === null) continue;
      
      if (typeof alt === 'number') {
        minAlt = Math.min(minAlt, alt);
        maxAlt = Math.max(maxAlt, alt);
      }
      
      points.push({
        lat,
        lon,
        alt: typeof alt === 'number' ? alt : 0,
        timestamp,
        gs,
        track,
      });
    }

    if (points.length === 0) {
      console.error('No valid points found in trace');
      process.exit(1);
    }

    let displayPoints = points;
    if (thinFactor > 1) {
      displayPoints = points.filter((_, index) => index % thinFactor === 0);
      console.log(`  Thinning: showing ${displayPoints.length.toLocaleString()} of ${points.length.toLocaleString()} points (every ${thinFactor}th point)`);
    }

    const durationSeconds = points[points.length - 1].timestamp - points[0].timestamp;
    const durationFormatted = formatDuration(durationSeconds);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ADSB Trace: ${output.icao || 'Unknown'}</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            background: #1a1a1a;
            color: white;
            padding: 1rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header h1 {
            font-size: 1.25rem;
            margin-bottom: 0.5rem;
        }
        .header-info {
            display: flex;
            gap: 2rem;
            flex-wrap: wrap;
            font-size: 0.875rem;
            opacity: 0.9;
        }
        .header-info span {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .header-info strong {
            font-weight: 600;
        }
        #map {
            flex: 1;
            width: 100%;
        }
        .info-panel {
            position: absolute;
            top: 80px;
            right: 10px;
            background: white;
            padding: 1rem;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            z-index: 1000;
            max-width: 300px;
            font-size: 0.875rem;
        }
        .info-panel h3 {
            margin-bottom: 0.5rem;
            font-size: 1rem;
        }
        .info-panel p {
            margin: 0.25rem 0;
        }
        .altitude-legend {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-top: 0.5rem;
        }
        .altitude-gradient {
            height: 20px;
            flex: 1;
            border-radius: 4px;
            border: 1px solid #ccc;
        }
        .legend-labels {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            color: #666;
            margin-top: 0.25rem;
        }
        .arrow-marker {
            cursor: pointer;
        }
        .arrow-marker svg {
            filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>ADSB Trace Visualization</h1>
        <div class="header-info">
            <span><strong>ICAO:</strong> ${output.icao || 'N/A'}</span>
            <span><strong>Registration:</strong> ${output.registration || 'N/A'}</span>
            <span><strong>Aircraft:</strong> ${output.aircraftType || 'N/A'} ${output.description ? `(${output.description})` : ''}</span>
            <span><strong>Date:</strong> ${output.date || 'N/A'}</span>
            <span><strong>Points:</strong> ${points.length.toLocaleString()}</span>
        </div>
    </div>
    <div id="map"></div>
    <div class="info-panel">
        <h3>Flight Information</h3>
        <p><strong>Altitude Range:</strong> ${Math.round(minAlt).toLocaleString()} - ${Math.round(maxAlt).toLocaleString()} ft</p>
        <p><strong>Duration:</strong> ${durationFormatted}</p>
        <div class="altitude-legend">
            <span style="font-size: 0.75rem;">Low</span>
            <div class="altitude-gradient" id="altitude-gradient"></div>
            <span style="font-size: 0.75rem;">High</span>
        </div>
        <div class="legend-labels">
            <span>${Math.round(minAlt).toLocaleString()} ft</span>
            <span>${Math.round(maxAlt).toLocaleString()} ft</span>
        </div>
        <p style="margin-top: 0.5rem; font-size: 0.75rem; color: #666;">Hover over arrows to see altitude and track info. Arrows point in direction of travel. Only visible markers are rendered for performance.</p>
    </div>

    <script>
        const tracePoints = ${JSON.stringify(displayPoints)};
        const minAltitude = ${minAlt};
        const maxAltitude = ${maxAlt};
        
        const map = L.map('map').setView([tracePoints[0].lat, tracePoints[0].lon], 8);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(map);
        
        function getAltitudeColor(alt, minAlt, maxAlt) {
            if (minAlt === maxAlt) return '#0066cc';
            const ratio = (alt - minAlt) / (maxAlt - minAlt);
            const r = Math.round(ratio * 255);
            const b = Math.round((1 - ratio) * 255);
            return \`rgb(\${r}, 0, \${b})\`;
        }
        
        const gradient = document.getElementById('altitude-gradient');
        const ctx = document.createElement('canvas').getContext('2d');
        const grd = ctx.createLinearGradient(0, 0, 300, 0);
        grd.addColorStop(0, getAltitudeColor(minAltitude, minAltitude, maxAltitude));
        grd.addColorStop(1, getAltitudeColor(maxAltitude, minAltitude, maxAltitude));
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 300, 20);
        gradient.style.background = \`linear-gradient(to right, \${getAltitudeColor(minAltitude, minAltitude, maxAltitude)}, \${getAltitudeColor(maxAltitude, minAltitude, maxAltitude)})\`;
        
        function createArrowIcon(color, track) {
            const rotation = track !== null && track !== undefined ? track : 0;
            
            const svg = \`
                <svg width="16" height="16" viewBox="0 0 16 16">
                    <g transform="rotate(\${rotation} 8 8)">
                        <path d="M 8 2 L 12 10 L 10 10 L 10 14 L 6 14 L 6 10 L 4 10 Z" 
                              fill="\${color}" 
                              stroke="white" 
                              stroke-width="1.5" 
                              stroke-linejoin="round"/>
                    </g>
                </svg>
            \`;
            
            return L.divIcon({
                className: 'arrow-marker',
                html: svg,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            });
        }
        
        const markerLayer = L.layerGroup();
        map.addLayer(markerLayer);
        
        const latlngs = tracePoints.map(p => [p.lat, p.lon]);
        let visibleMarkers = new Map();
        
        const markerData = tracePoints.map((point, index) => {
            const color = getAltitudeColor(point.alt, minAltitude, maxAltitude);
            const track = point.track !== null && point.track !== undefined ? point.track : 0;
            const timeStr = formatTime(point.timestamp);
            const altStr = Math.round(point.alt).toLocaleString() + ' ft';
            const gsStr = point.gs ? Math.round(point.gs) + ' kts' : 'N/A';
            const trackStr = point.track ? Math.round(point.track) + '°' : 'N/A';
            
            return {
                lat: point.lat,
                lon: point.lon,
                color: color,
                track: track,
                index: index,
                popup: \`
                    <strong>Point \${index + 1}</strong><br>
                    Time: \${timeStr}<br>
                    Altitude: \${altStr}<br>
                    Ground Speed: \${gsStr}<br>
                    Track: \${trackStr}<br>
                    Position: \${point.lat.toFixed(6)}, \${point.lon.toFixed(6)}
                \`
            };
        });
        
        function updateVisibleMarkers() {
            const bounds = map.getBounds();
            const zoom = map.getZoom();
            
            const skipFactor = zoom < 10 ? 10 : zoom < 12 ? 5 : zoom < 14 ? 2 : 1;
            
            const newVisible = new Map();
            
            markerData.forEach((data, index) => {
                if (index % skipFactor !== 0) return;
                
                if (bounds.contains([data.lat, data.lon])) {
                    const key = \`\${data.lat},\${data.lon},\${index}\`;
                    newVisible.set(key, data);
                    
                    if (!visibleMarkers.has(key)) {
                        const marker = L.marker([data.lat, data.lon], {
                            icon: createArrowIcon(data.color, data.track)
                        });
                        marker.bindPopup(data.popup);
                        marker.on('mouseover', function() {
                            marker.openPopup();
                        });
                        markerLayer.addLayer(marker);
                        visibleMarkers.set(key, marker);
                    }
                }
            });
            
            visibleMarkers.forEach((marker, key) => {
                if (!newVisible.has(key)) {
                    markerLayer.removeLayer(marker);
                    visibleMarkers.delete(key);
                }
            });
        }
        
        map.on('moveend', updateVisibleMarkers);
        map.on('zoomend', updateVisibleMarkers);
        
        updateVisibleMarkers();
        
        const startMarker = L.marker([tracePoints[0].lat, tracePoints[0].lon], {
            icon: L.divIcon({
                className: 'start-marker',
                html: '<div style="background: #00ff00; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 2px #00ff00;"></div>',
                iconSize: [12, 12]
            })
        }).addTo(map);
        startMarker.bindPopup(\`<strong>Start</strong><br>Altitude: \${Math.round(tracePoints[0].alt).toLocaleString()} ft\`);
        
        const endMarker = L.marker([tracePoints[tracePoints.length - 1].lat, tracePoints[tracePoints.length - 1].lon], {
            icon: L.divIcon({
                className: 'end-marker',
                html: '<div style="background: #ff0000; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 2px #ff0000;"></div>',
                iconSize: [12, 12]
            })
        }).addTo(map);
        endMarker.bindPopup(\`<strong>End</strong><br>Altitude: \${Math.round(tracePoints[tracePoints.length - 1].alt).toLocaleString()} ft\`);
        
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds, { padding: [50, 50] });
        
        function formatTime(timestamp) {
            if (timestamp < 86400 * 2) {
                const hours = Math.floor(timestamp / 3600);
                const minutes = Math.floor((timestamp % 3600) / 60);
                const seconds = Math.floor(timestamp % 60);
                return \`\${String(hours).padStart(2, '0')}:\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
            }
            const date = new Date(timestamp * 1000);
            return date.toLocaleTimeString();
        }
        
        function formatDuration(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            if (hours > 0) {
                return \`\${hours}h \${minutes}m \${secs}s\`;
            } else if (minutes > 0) {
                return \`\${minutes}m \${secs}s\`;
            } else {
                return \`\${secs}s\`;
            }
        }
    </script>
</body>
</html>`;

    const htmlFileName = `trace_${icao}_${date}.html`;
    const htmlFilePath = path.join(cacheTracesDir, htmlFileName);
    fs.writeFileSync(htmlFilePath, html);
    
    console.log(`✓ Generated visualization: ${htmlFilePath}`);
    console.log(`  Points: ${displayPoints.length.toLocaleString()}${thinFactor > 1 ? ` (thinned from ${points.length.toLocaleString()})` : ''}`);
    console.log(`  Altitude range: ${Math.round(minAlt).toLocaleString()} - ${Math.round(maxAlt).toLocaleString()} ft`);
    if (points.length > 5000 && thinFactor === 1) {
      console.log(`\n  Tip: Use --thin 2 or --thin 5 for better performance with large traces`);
    }
    console.log(`\nOpen ${htmlFilePath} in your browser to view the map.`);

    logger.info('Successfully retrieved and visualized aircraft trace', {
      icao,
      date,
      traceCount: output.traceCount,
      traceFile: traceFileName,
      htmlFile: htmlFileName,
    });

  } catch (error) {
    logger.error('Failed to get and visualize aircraft trace', {
      icao,
      date,
      error: error.message,
      stack: error.stack,
    });
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

getAndVisualizeTrace();


