import FlightAnalyzer from '../FlightAnalyzer.js';

describe('FlightAnalyzer - Go-Around Detection', () => {
  let analyzer;
  const airport = {
    coordinates: { lat: 41.9786, lon: -87.9048 },
    elevation_ft: 672,
  };
  const airportElevation = 672;
  const date = '2025-01-15';

  beforeEach(() => {
    analyzer = new FlightAnalyzer({
      airportProximityRadius: 5,
      groundAltitudeThreshold: 500,
      touchdownProximity: 1,
      goAroundBoundary: 2,
      goAroundMaxAGL: 1000,
      goAroundMaxTime: 120,
      goAroundMinDistance: 5,
      goAroundMaxTimeFromThreshold: 15 * 60,
    });
  });

  function createPosition(timestamp, lat, lon, alt_baro, distance) {
    return {
      timestamp,
      lat,
      lon,
      alt_baro,
      alt_agl: alt_baro - airportElevation,
      distance,
      gs: 150,
      track: 0,
    };
  }

  function createGoAroundTrace() {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 10));
    positions.push(createPosition(baseTime + 600, 41.99, -87.92, 10000, 6));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 5000, 5.5));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 3000, 4));
    positions.push(createPosition(baseTime + 1500, 41.9786, -87.9048, 2000, 3));
    positions.push(createPosition(baseTime + 1800, 41.9786, -87.9048, 1200, 2.5));
    positions.push(createPosition(baseTime + 2100, 41.9786, -87.9048, 800, 1.8));
    positions.push(createPosition(baseTime + 2400, 41.9786, -87.9048, 600, 1.5));
    positions.push(createPosition(baseTime + 2700, 41.9786, -87.9048, 400, 1.2));
    positions.push(createPosition(baseTime + 3000, 41.9786, -87.9048, 200, 0.8));
    positions.push(createPosition(baseTime + 3300, 41.9786, -87.9048, 100, 0.6));
    positions.push(createPosition(baseTime + 3600, 41.9786, -87.9048, 1200, 1.0));
    positions.push(createPosition(baseTime + 3900, 41.9786, -87.9048, 2000, 1.5));
    positions.push(createPosition(baseTime + 4200, 41.9786, -87.9048, 3000, 2.1));
    positions.push(createPosition(baseTime + 4500, 41.9786, -87.9048, 4000, 5.0));

    return positions;
  }

  test('should detect go-around when aircraft approaches, enters 2nm under 1000ft, exits within 2 minutes, and climbs', () => {
    const positions = createGoAroundTrace();
    // For testing, pass positions as both segment and fullTrace
    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);

    expect(goAround).not.toBeNull();
    expect(goAround.entryAltitudeAGL).toBeLessThan(1000);
    expect(goAround.exitAltitudeAGL).toBeGreaterThan(goAround.entryAltitudeAGL);
    expect(goAround.maxAltitudeAGL).toBeGreaterThan(1000);
    expect(goAround.duration).toBeLessThanOrEqual(120);
    expect(goAround.duration).toBeGreaterThanOrEqual(10);
  });

  test('should not detect go-around if aircraft never passed 5nm', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.0, -87.95, 10000, 4));
    positions.push(createPosition(baseTime + 300, 41.99, -87.92, 5000, 3));
    positions.push(createPosition(baseTime + 600, 41.978, -87.905, 2000, 2));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 1200, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should not detect go-around if too much time passed between threshold and entry', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 6));
    positions.push(createPosition(baseTime + 20 * 60, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 20 * 60 + 60, 41.9786, -87.9048, 1200, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should not detect go-around if aircraft does not climb above 1000ft AGL', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 45));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 1200, 1.5));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 800, 1.0));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 900, 2.1));
    positions.push(createPosition(baseTime + 1500, 41.9786, -87.9048, 950, 3.0));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should not detect go-around if exit takes longer than 2 minutes', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 150, 41.9786, -87.9048, 1200, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should not detect go-around if entry altitude is above 1000ft AGL', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 41.9786, -87.9048, 2000, 1.5));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 3000, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should detect go-around in full flight analysis', () => {
    const positions = createGoAroundTrace();
    
    const trace = positions.map(pos => [
      pos.timestamp,
      pos.lat,
      pos.lon,
      pos.alt_baro,
      pos.gs,
      pos.track,
    ]);

    const events = analyzer.analyzeFlight('TEST01', trace, airport, date, {
      registration: 'N12345',
      aircraftType: 'B737',
      description: 'Boeing 737',
    });

    const goAroundEvent = events.find(e => e.classification === 'go_around');
    expect(goAroundEvent).not.toBeUndefined();
    expect(goAroundEvent.icao).toBe('TEST01');
    expect(goAroundEvent.goAround).toBeDefined();
    expect(goAroundEvent.goAround.entryAltitudeAGL_ft).toBeLessThan(1000);
    expect(goAroundEvent.goAround.maxAltitudeAGL_ft).toBeGreaterThan(1000);
    
    // Go-around should be independent - can coexist with arrival
    const arrivalEvent = events.find(e => e.classification === 'arrival');
    // Note: This trace might not have an arrival, but if it does, both can exist
  });

  test('should filter out pattern work (aircraft never beyond 20nm)', () => {
    const baseTime = 1705276800;
    const positions = [];

    // Pattern work: aircraft stays within 10nm, never goes beyond 20nm
    positions.push(createPosition(baseTime, 42.0, -87.95, 5000, 8));
    positions.push(createPosition(baseTime + 300, 41.99, -87.92, 3000, 6));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 2000, 4));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 1200, 2.1));

    const trace = positions.map(pos => [
      pos.timestamp,
      pos.lat,
      pos.lon,
      pos.alt_baro,
      pos.gs,
      pos.track,
    ]);

    const events = analyzer.analyzeFlight('TEST02', trace, airport, date, {
      registration: 'N12345',
      aircraftType: 'C172',
      description: 'Cessna 172',
    });

    const goAroundEvent = events.find(e => e.classification === 'go_around');
    expect(goAroundEvent).toBeUndefined(); // Should be filtered out as pattern work
  });

  test('should handle go-around with lost contact scenario', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 45));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 1200, 1.8));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 2000, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).not.toBeNull();
    expect(goAround.maxAltitudeAGL).toBeGreaterThan(1000);
  });

  test('should not detect go-around if aircraft was climbing before entry', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 45));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 5000, 10));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 6000, 5));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 1500, 41.9786, -87.9048, 1200, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should not detect go-around if aircraft did not come from at least 5nm before entry', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 41.9786, -87.9048, 2000, 3));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 1200, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).toBeNull();
  });

  test('should handle go-around with multiple altitude changes', () => {
    const baseTime = 1705276800;
    const positions = [];

    positions.push(createPosition(baseTime, 42.5, -88.0, 35000, 60));
    positions.push(createPosition(baseTime + 300, 42.0, -87.95, 20000, 45));
    positions.push(createPosition(baseTime + 600, 41.9786, -87.9048, 800, 1.5));
    positions.push(createPosition(baseTime + 900, 41.9786, -87.9048, 600, 1.0));
    positions.push(createPosition(baseTime + 1200, 41.9786, -87.9048, 500, 0.8));
    positions.push(createPosition(baseTime + 1500, 41.9786, -87.9048, 1200, 1.2));
    positions.push(createPosition(baseTime + 1800, 41.9786, -87.9048, 1500, 1.5));
    positions.push(createPosition(baseTime + 2100, 41.9786, -87.9048, 2000, 2.1));

    const goAround = analyzer.detectGoAround(positions, airportElevation, positions);
    expect(goAround).not.toBeNull();
    expect(goAround.maxAltitudeAGL).toBeGreaterThan(1000);
  });
});

