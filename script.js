// Initialize Leaflet map
const map = L.map('map').setView([26.8467, 80.9462], 12);

// Define different map layers
const mapLayers = {
  street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
  }),
  terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenTopoMap (CC-BY-SA)'
  }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }),
  watercolor: L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/watercolor/{z}/{x}/{y}.{ext}', {
    attribution: 'Map tiles by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: 'abcd',
    minZoom: 1,
    maxZoom: 16,
    ext: 'jpg'
  })
};

// Set default layer
let currentLayer = mapLayers.street;
currentLayer.addTo(map);

// Wait for H3 to load and check availability
window.addEventListener('load', function() {
  setTimeout(() => {
    console.log("H3 loaded?", typeof h3 !== 'undefined' && typeof h3.latLngToCell === "function");
    if (typeof h3 !== 'undefined') {
      console.log("H3 version:", h3.LIBRARY_VERSION || "unknown");
      console.log("Available H3 methods:", Object.keys(h3));
    } else {
      console.error("H3 still not loaded after timeout");
    }
  }, 1000);
});

// Global layers
let startMarker, endMarker, routeLine, startHex, endHex;
let currentResolution = 7;
let clickMarkers = [];

// Geocode address using Nominatim
async function getCoordinates(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data[0]) throw new Error(`Address not found: ${address}`);
  return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
}

// Draw H3 hex
function drawH3Hex(lat, lon, resolution, options = {}) {
  try {
    console.log('Creating H3 hex for:', lat, lon);
    
    if (typeof h3 === 'undefined') {
      console.error('H3 library not loaded - check CDN');
      return null;
    }
    
    // H3 v4 API calls
    const h3Index = h3.latLngToCell(lat, lon, resolution);
    const boundary = h3.cellToBoundary(h3Index, true);
    const latLngs = boundary.map(([lat, lon]) => [lat, lon]);
    
    console.log('H3 hex created successfully:', h3Index);
    
    const polygon = L.polygon(latLngs, {
      color: options.color || '#ff0000',
      fillOpacity: options.fillOpacity || 0.3,
      weight: options.weight || 2
    }).addTo(map).bindPopup(`H3: ${h3Index}`);
    
    return { index: h3Index, polygon };
  } catch (error) {
    console.error('H3 error details:', error.message || error);
    return null;
  }
}

// Draw full H3 grid over visible map area
let gridLayer = L.layerGroup();
function drawHexGrid(resolution = 7, showHeatmap = false) {
  try {
    if (typeof h3 === 'undefined') {
      console.error('H3 library not loaded - cannot draw grid');
      return;
    }

    // Clear existing grid
    gridLayer.clearLayers();
    
    // Get current map bounds
    const bounds = map.getBounds();
    const polygon = [
      [bounds.getSouth(), bounds.getWest()],
      [bounds.getSouth(), bounds.getEast()], 
      [bounds.getNorth(), bounds.getEast()],
      [bounds.getNorth(), bounds.getWest()],
      [bounds.getSouth(), bounds.getWest()]
    ];

    // Get all H3 cells within bounds
    const hexes = h3.polygonToCells([polygon], resolution);
    console.log(`Drawing ${hexes.length} H3 hexes at resolution ${resolution}`);

    hexes.forEach(h3Index => {
      const boundary = h3.cellToBoundary(h3Index, true);
      const latLngs = boundary.map(([lat, lon]) => [lat, lon]);

      // Generate random data for heatmap effect
      const intensity = showHeatmap ? Math.random() : 0.1;
      const color = showHeatmap ? 
        `hsl(${240 - intensity * 240}, 70%, 50%)` : // Blue to red gradient
        '#ff9800'; // Orange for regular grid

      const hexPolygon = L.polygon(latLngs, {
        color: color,
        fillColor: color,
        fillOpacity: showHeatmap ? intensity * 0.6 : 0.2,
        weight: showHeatmap ? 0.5 : 1,
        opacity: 0.8
      }).bindPopup(`H3: ${h3Index}<br>Data: ${Math.round(intensity * 100)}`);

      gridLayer.addLayer(hexPolygon);
    });

    gridLayer.addTo(map);
    console.log(`✅ Drew ${hexes.length} H3 hexes`);
  } catch (error) {
    console.error('Grid drawing error:', error);
  }
}

// Main routing logic
async function getRoute() {
  const startAddr = document.getElementById('start').value;
  const endAddr = document.getElementById('end').value;

  try {
    const [sLat, sLon] = await getCoordinates(startAddr);
    const [eLat, eLon] = await getCoordinates(endAddr);

    // Remove old layers
    [startMarker, endMarker, routeLine, startHex?.polygon, endHex?.polygon]
      .forEach(layer => layer && map.removeLayer(layer));

    // Add new markers
    startMarker = L.marker([sLat, sLon]).addTo(map).bindPopup("Pickup").openPopup();
    endMarker = L.marker([eLat, eLon]).addTo(map).bindPopup("Drop").openPopup();

    // Fit map
    map.fitBounds([[sLat, sLon], [eLat, eLon]], { padding: [50, 50] });

    // Route from OSRM
    const osrmURL = `https://router.project-osrm.org/route/v1/driving/${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson`;
    const res = await fetch(osrmURL);
    const routeData = await res.json();
    const routeGeo = routeData.routes[0].geometry;

    routeLine = L.geoJSON(routeGeo, {
      style: { color: '#1db954', weight: 5 }
    }).addTo(map);

    // Draw H3 zones
    const resH3 = 7;
    startHex = drawH3Hex(sLat, sLon, resH3, { color: '#ff0000', fillOpacity: 0.3 });
    endHex   = drawH3Hex(eLat, eLon, resH3, { color: '#0000ff', fillOpacity: 0.3 });

  } catch (err) {
    alert(err.message);
    console.error(err);
  }
}

// Update resolution from dropdown
function updateResolution() {
  currentResolution = parseInt(document.getElementById('resSelect').value);
  console.log('Resolution changed to:', currentResolution);
}

// Clear all layers
function clearAll() {
  // Clear markers and routes
  [startMarker, endMarker, routeLine, startHex?.polygon, endHex?.polygon]
    .forEach(layer => layer && map.removeLayer(layer));
  
  // Clear click markers
  clickMarkers.forEach(marker => map.removeLayer(marker));
  clickMarkers = [];
  
  // Clear grid
  gridLayer.clearLayers();
  
  // Clear input fields
  document.getElementById('start').value = '';
  document.getElementById('end').value = '';
  
  console.log('All layers cleared');
}

// Add click-to-place markers
map.on('click', function(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  
  // Create interactive marker
  const clickMarker = L.marker([lat, lng], {
    draggable: true
  }).addTo(map);
  
  // Create H3 hex at clicked location
  const hex = drawH3Hex(lat, lng, currentResolution, { 
    color: '#9c27b0', 
    fillOpacity: 0.4,
    weight: 2
  });
  
  clickMarker.bindPopup(`
    <b>Custom Location</b><br>
    Lat: ${lat.toFixed(6)}<br>
    Lng: ${lng.toFixed(6)}<br>
    H3: ${hex?.index || 'N/A'}<br>
    <button onclick="removeMarker(${clickMarkers.length})">Remove</button>
  `);
  
  // Handle marker drag
  clickMarker.on('dragend', function(event) {
    const newPos = event.target.getLatLng();
    console.log('Marker moved to:', newPos.lat, newPos.lng);
    
    // Update H3 hex position
    if (hex?.polygon) {
      map.removeLayer(hex.polygon);
      const newHex = drawH3Hex(newPos.lat, newPos.lng, currentResolution, { 
        color: '#9c27b0', 
        fillOpacity: 0.4,
        weight: 2
      });
      
      clickMarker.getPopup().setContent(`
        <b>Custom Location</b><br>
        Lat: ${newPos.lat.toFixed(6)}<br>
        Lng: ${newPos.lng.toFixed(6)}<br>
        H3: ${newHex?.index || 'N/A'}<br>
        <button onclick="removeMarker(${clickMarkers.length})">Remove</button>
      `);
    }
  });
  
  clickMarkers.push({ marker: clickMarker, hex: hex?.polygon });
});

// Remove specific marker
function removeMarker(index) {
  if (clickMarkers[index]) {
    map.removeLayer(clickMarkers[index].marker);
    if (clickMarkers[index].hex) {
      map.removeLayer(clickMarkers[index].hex);
    }
    clickMarkers.splice(index, 1);
  }
}

// Add map controls info
map.on('zoomend', function() {
  console.log('Current zoom level:', map.getZoom());
});

// Add keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    clearAll();
  } else if (e.key === 'g') {
    drawHexGrid(currentResolution, false);
  } else if (e.key === 'h') {
    drawHexGrid(currentResolution, true);
  }
});

// Change map view
function changeMapView() {
  const selectedView = document.getElementById('viewSelect').value;
  
  // Remove current layer
  map.removeLayer(currentLayer);
  
  // Add new layer
  currentLayer = mapLayers[selectedView];
  currentLayer.addTo(map);
  
  console.log('Map view changed to:', selectedView);
}

console.log('🎮 Interactive features loaded:');
console.log('• Click map to place draggable markers with H3 hexes');
console.log('• Use resolution dropdown to change hex size');
console.log('• Use view dropdown to switch map styles');
console.log('• Keyboard shortcuts: ESC (clear all), G (grid), H (heatmap)');
console.log('• Drag markers to update their H3 zones');
