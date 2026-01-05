/**
 * Aircraft Category Utilities
 * 
 * Shared definitions for categorizing aircraft types.
 * Used across analysis scripts and APIs to ensure consistent filtering.
 */

export const SMALL_LIGHT_TYPES = new Set([
  'C208', 'C25A', 'C25B', 'C310', 'C525', 'C550', 'C560', 'C56X',
  'C680', 'C68A', 'C700', 'C750', 'BE20', 'BE40', 'BE9L', 'PC12',
  'SF50', 'LJ31', 'LJ35', 'LJ45', 'LJ60', 'CL30', 'CL35', 'CL60',
  'E545', 'E550', 'E55P', 'FA20', 'FA50', 'FA7X', 'FA8X', 'F2TH',
  'F900', 'G280', 'GA5C', 'GA6C', 'GALX', 'GL5T', 'GL7T', 'GLEX',
  'GLF4', 'GLF5', 'GLF6', 'H25B', 'HA4T', 'HDJT', 'B350'
]);

export function isSmallLightAircraft(type) {
  if (!type) return false;
  return SMALL_LIGHT_TYPES.has(type);
}

