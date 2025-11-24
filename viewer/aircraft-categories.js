export const aircraftCategories = {
  small: {
    name: 'Small/Light',
    description: 'Light aircraft and small jets',
    types: [
      'C208', 'C25A', 'C25B', 'C310', 'C525', 'C550', 'C560', 'C56X', 'C680', 'C68A', 'C700', 'C750',
      'BE20', 'BE40', 'BE9L', 'PC12', 'SF50',
      'LJ31', 'LJ35', 'LJ45', 'LJ60',
      'CL30', 'CL35', 'CL60',
      'E545', 'E550', 'E55P',
      'FA20', 'FA50', 'FA7X', 'FA8X',
      'F2TH', 'F900',
      'G280', 'GA5C', 'GA6C', 'GALX', 'GL5T', 'GL7T', 'GLEX', 'GLF4', 'GLF5', 'GLF6',
      'H25B', 'HA4T', 'HDJT',
      'B350'
    ]
  },
  regional: {
    name: 'Regional',
    description: 'Regional jets',
    types: [
      'CRJ2', 'CRJ7', 'CRJ9',
      'E135', 'E145', 'E170', 'E190', 'E35L', 'E45X', 'E75L', 'E75S',
      'BCS1', 'BCS3'
    ]
  },
  narrowbody: {
    name: 'Narrow-body',
    description: 'Single-aisle commercial jets (A320 family, B737 family, B757, etc.)',
    types: [
      'A20N', 'A21N', 'A319', 'A320', 'A321',
      'B712', 'B734', 'B737', 'B738', 'B739', 'B38M', 'B39M',
      'B752', 'B753'
    ]
  },
  widebody: {
    name: 'Wide-body',
    description: 'Twin-aisle commercial jets (A330, A350, B777, B787, B747, etc.)',
    types: [
      'A306', 'A332', 'A333', 'A339', 'A343', 'A346', 'A359', 'A35K',
      'B762', 'B763', 'B772', 'B77L', 'B77W',
      'B788', 'B789', 'B78X',
      'B744', 'B748',
      'MD11'
    ]
  },
  other: {
    name: 'Other',
    description: 'Other aircraft types',
    types: [
      'AN12', 'C27J', 'UNKNOWN'
    ]
  }
};

export function getAircraftCategory(type) {
  if (!type) return 'other';
  
  for (const [category, data] of Object.entries(aircraftCategories)) {
    if (data.types.includes(type)) {
      return category;
    }
  }
  
  return 'other';
}

export function getCategoryName(category) {
  return aircraftCategories[category]?.name || 'Unknown';
}

export function getAllAircraftTypes() {
  const allTypes = [];
  for (const category of Object.values(aircraftCategories)) {
    allTypes.push(...category.types);
  }
  return allTypes;
}


