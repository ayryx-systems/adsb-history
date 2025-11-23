#!/usr/bin/env node

/**
 * Generate an HTML file with an interactive map visualization of an ADSB trace
 * 
 * Usage:
 *   node scripts/visualize-trace.js <trace_file> [output.html]
 * 
 * Example:
 *   node scripts/visualize-trace.js a8a6c0_trace.txt trace.html
 *   node scripts/visualize-trace.js a8a6c0_trace.txt
 * 
 * The script reads a trace JSON file and generates an HTML file with:
 * - Interactive Leaflet map showing the flight path
 * - Altitude information displayed at each point on hover/click
 * - Color-coded path based on altitude
 * - Flight metadata (ICAO, registration, aircraft type, date)
 */

import fs from 'fs';
import path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: node scripts/visualize-trace.js <trace_file> [output.html]');
  console.error('Example: node scripts/visualize-trace.js a8a6c0_trace.txt trace.html');
  process.exit(1);
}

const traceFile = args[0];
const outputFile = args[1] || traceFile.replace(/\.(txt|json)$/, '') + '.html';

// Read and parse trace file
let traceData;
try {
  const fileContent = fs.readFileSync(traceFile, 'utf-8');
  // Handle case where log output might be appended to JSON
  const jsonMatch = fileContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No valid JSON found in trace file');
  }
  traceData = JSON.parse(jsonMatch[0]);
} catch (error) {
  console.error(`Error reading trace file: ${error.message}`);
  process.exit(1);
}

if (!traceData.trace || !Array.isArray(traceData.trace)) {
  console.error('Invalid trace file: missing trace array');
  process.exit(1);
}

// Parse trace points
const points = [];
let minAlt = Infinity;
let maxAlt = -Infinity;

for (const point of traceData.trace) {
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

// Calculate duration
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

const durationSeconds = points[points.length - 1].timestamp - points[0].timestamp;
const durationFormatted = formatDuration(durationSeconds);

// Generate HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ADSB Trace: ${traceData.icao || 'Unknown'}</title>
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
    </style>
</head>
<body>
    <div class="header">
        <h1>ADSB Trace Visualization</h1>
        <div class="header-info">
            <span><strong>ICAO:</strong> ${traceData.icao || 'N/A'}</span>
            <span><strong>Registration:</strong> ${traceData.registration || 'N/A'}</span>
            <span><strong>Aircraft:</strong> ${traceData.aircraftType || 'N/A'} ${traceData.description ? `(${traceData.description})` : ''}</span>
            <span><strong>Date:</strong> ${traceData.date || 'N/A'}</span>
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
        <p style="margin-top: 0.5rem; font-size: 0.75rem; color: #666;">Hover over the path to see altitude at each point</p>
    </div>

    <script>
        const tracePoints = ${JSON.stringify(points)};
        const minAltitude = ${minAlt};
        const maxAltitude = ${maxAlt};
        
        // Create map centered on first point
        const map = L.map('map').setView([tracePoints[0].lat, tracePoints[0].lon], 8);
        
        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(map);
        
        // Function to get color based on altitude
        function getAltitudeColor(alt, minAlt, maxAlt) {
            if (minAlt === maxAlt) return '#0066cc';
            const ratio = (alt - minAlt) / (maxAlt - minAlt);
            // Color gradient from blue (low) to red (high)
            const r = Math.round(ratio * 255);
            const b = Math.round((1 - ratio) * 255);
            return \`rgb(\${r}, 0, \${b})\`;
        }
        
        // Create altitude gradient for legend
        const gradient = document.getElementById('altitude-gradient');
        const ctx = document.createElement('canvas').getContext('2d');
        const grd = ctx.createLinearGradient(0, 0, 300, 0);
        grd.addColorStop(0, getAltitudeColor(minAltitude, minAltitude, maxAltitude));
        grd.addColorStop(1, getAltitudeColor(maxAltitude, minAltitude, maxAltitude));
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 300, 20);
        gradient.style.background = \`linear-gradient(to right, \${getAltitudeColor(minAltitude, minAltitude, maxAltitude)}, \${getAltitudeColor(maxAltitude, minAltitude, maxAltitude)})\`;
        
        // Create polyline with color-coded segments
        const latlngs = tracePoints.map(p => [p.lat, p.lon]);
        
        // Create segments for color coding
        const segments = [];
        for (let i = 0; i < tracePoints.length - 1; i++) {
            const p1 = tracePoints[i];
            const p2 = tracePoints[i + 1];
            const color = getAltitudeColor((p1.alt + p2.alt) / 2, minAltitude, maxAltitude);
            segments.push({
                latlngs: [[p1.lat, p1.lon], [p2.lat, p2.lon]],
                color: color,
                alt: (p1.alt + p2.alt) / 2,
                index: i
            });
        }
        
        // Add each segment as a separate polyline
        segments.forEach(seg => {
            const polyline = L.polyline(seg.latlngs, {
                color: seg.color,
                weight: 3,
                opacity: 0.8
            }).addTo(map);
            
            // Add hover tooltip
            polyline.on('mouseover', function(e) {
                const point = tracePoints[seg.index];
                const timeStr = formatTime(point.timestamp);
                const altStr = Math.round(point.alt).toLocaleString() + ' ft';
                const gsStr = point.gs ? Math.round(point.gs) + ' kts' : 'N/A';
                const trackStr = point.track ? Math.round(point.track) + '°' : 'N/A';
                
                polyline.bindPopup(\`
                    <strong>Point \${seg.index + 1}</strong><br>
                    Time: \${timeStr}<br>
                    Altitude: \${altStr}<br>
                    Ground Speed: \${gsStr}<br>
                    Track: \${trackStr}<br>
                    Position: \${point.lat.toFixed(6)}, \${point.lon.toFixed(6)}
                \`).openPopup();
            });
        });
        
        // Add markers at start and end
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
        
        // Fit map to bounds
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds, { padding: [50, 50] });
        
        // Helper functions
        function formatTime(timestamp) {
            // Handle relative timestamps (seconds since start of day)
            if (timestamp < 86400 * 2) {
                const hours = Math.floor(timestamp / 3600);
                const minutes = Math.floor((timestamp % 3600) / 60);
                const seconds = Math.floor(timestamp % 60);
                return \`\${String(hours).padStart(2, '0')}:\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
            }
            // Handle absolute Unix timestamps
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

// Write HTML file
try {
  const outputPath = path.isAbsolute(outputFile) 
    ? outputFile 
    : path.resolve(process.cwd(), outputFile);
  
  fs.writeFileSync(outputPath, html);
  console.log(`✓ Generated visualization: ${outputPath}`);
  console.log(`  Points: ${points.length.toLocaleString()}`);
  console.log(`  Altitude range: ${Math.round(minAlt).toLocaleString()} - ${Math.round(maxAlt).toLocaleString()} ft`);
  console.log(`\nOpen ${outputPath} in your browser to view the map.`);
} catch (error) {
  console.error(`Error writing HTML file: ${error.message}`);
  process.exit(1);
}

