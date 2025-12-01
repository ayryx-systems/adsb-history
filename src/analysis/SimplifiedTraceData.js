import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

class SimplifiedTraceData {
  constructor(config = {}) {
    this.cacheDir = config.cacheDir || path.resolve(process.cwd(), 'cache');
  }

  getTracePath(airport, date, icao, touchdownTimestamp = null) {
    const [year, month, day] = date.split('-');
    const traceDir = path.join(this.cacheDir, 'traces', airport, year, month, day);
    
    if (touchdownTimestamp !== null && touchdownTimestamp !== undefined) {
      return path.join(traceDir, `${icao}-${touchdownTimestamp}.json`);
    }
    return path.join(traceDir, `${icao}.json`);
  }

  async save(airport, date, icao, traceData, touchdownTimestamp = null) {
    const tracePath = this.getTracePath(airport, date, icao, touchdownTimestamp);
    const traceDir = path.dirname(tracePath);

    if (!fs.existsSync(traceDir)) {
      fs.mkdirSync(traceDir, { recursive: true, mode: 0o755 });
    }

    try {
      fs.writeFileSync(tracePath, JSON.stringify(traceData, null, 2), 'utf-8');
      logger.debug('Saved simplified trace', {
        airport,
        date,
        icao,
        touchdownTimestamp,
        path: tracePath,
        pointCount: traceData.points?.length || 0,
      });
    } catch (error) {
      logger.error('Failed to save simplified trace', {
        airport,
        date,
        icao,
        touchdownTimestamp,
        error: error.message,
      });
      throw error;
    }
  }

  async load(airport, date, icao, touchdownTimestamp = null) {
    const tracePath = this.getTracePath(airport, date, icao, touchdownTimestamp);

    if (!fs.existsSync(tracePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
      logger.debug('Loaded simplified trace', {
        airport,
        date,
        icao,
        touchdownTimestamp,
        pointCount: data.points?.length || 0,
      });
      return data;
    } catch (error) {
      logger.error('Failed to load simplified trace', {
        airport,
        date,
        icao,
        touchdownTimestamp,
        error: error.message,
      });
      return null;
    }
  }

  async exists(airport, date, icao, touchdownTimestamp = null) {
    const tracePath = this.getTracePath(airport, date, icao, touchdownTimestamp);
    return fs.existsSync(tracePath);
  }
}

export default SimplifiedTraceData;

