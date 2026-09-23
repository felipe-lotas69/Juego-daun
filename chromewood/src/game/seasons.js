/* ============================================================
   seasons.js - the year

   Four seasons, three nights each, turning on the night counter.
   Like the trade boards, a season is a pure function of a number
   the simulation already has, so nothing about it goes on the wire
   and a client works it out for itself.

   A season that only changes the colour of the grass is a filter.
   This one decides how fast a crop grows, what is out in the woods,
   what the sky does, and how long the day is - so autumn is the
   time to plant and winter is the time you are glad you did.
   ============================================================ */

export const SEASON_NIGHTS = 3;      /* nights in one season */

export const SEASONS = [
  {
    id: 'spring', name: 'Spring',
    /* What the greens get tinted toward, and how far. */
    tint: 0x8fe05a, tintAmount: 0.30,
    snow: 0,
    crop: 1.30,                       /* growth rate multiplier */
    dayScale: 1.05,
    warmth: 0.2,
    weather: { rain: 0.30, fog: 0.14, snowstorm: 0.02, ashfall: 0.06 },
    animals: { critter: 1.4, deer: 1.2, boar: 1.0, ram: 0.8, wolf: 0.7, lumen: 1.0, hare: 1.5, fowl: 1.3, fox: 0.9 },
    blurb: 'Everything is growing. Plant now.',
  },
  {
    id: 'summer', name: 'Summer',
    tint: 0x63c24a, tintAmount: 0.22,
    snow: 0,
    crop: 1.05,
    dayScale: 1.20,
    warmth: 0.6,
    weather: { rain: 0.12, fog: 0.06, snowstorm: 0, ashfall: 0.12 },
    animals: { critter: 1.2, deer: 1.1, boar: 1.3, ram: 1.0, wolf: 0.8, lumen: 1.3, hare: 1.2, fowl: 1.4, fox: 1.0 },
    blurb: 'Long days. The rift is restless in the heat.',
  },
  {
    id: 'autumn', name: 'Autumn',
    tint: 0xdc9130, tintAmount: 0.56,
    snow: 0,
    crop: 0.85,
    dayScale: 0.92,
    warmth: 0,
    weather: { rain: 0.26, fog: 0.22, snowstorm: 0.04, ashfall: 0.08 },
    animals: { critter: 0.9, deer: 1.4, boar: 1.4, ram: 1.2, wolf: 1.1, lumen: 0.8, hare: 1.0, fowl: 0.9, fox: 1.3 },
    blurb: 'The herds are fat and the nights are drawing in.',
  },
  {
    id: 'winter', name: 'Winter',
    tint: 0x9fb4b8, tintAmount: 0.46,
    snow: 0.8,
    crop: 0.35,
    dayScale: 0.78,
    warmth: -0.9,                     /* the cold bites harder */
    weather: { rain: 0.04, fog: 0.18, snowstorm: 0.34, ashfall: 0.06 },
    animals: { critter: 0.5, deer: 0.6, boar: 0.6, ram: 1.3, wolf: 1.6, lumen: 0.6, hare: 0.7, fowl: 0.3, fox: 1.4 },
    blurb: 'Nothing grows. Keep a fire and keep eating.',
  },
];

export function seasonFor(night) {
  return SEASONS[Math.floor(night / SEASON_NIGHTS) % SEASONS.length];
}

/* How far through the current season, 0 to 1 - used to cross-fade
   the colour so the world turns rather than snapping. */
export function seasonProgress(night, dayTime, cycleLength) {
  const within = night % SEASON_NIGHTS;
  const inDay = cycleLength > 0 ? (dayTime % cycleLength) / cycleLength : 0;
  return (within + inDay) / SEASON_NIGHTS;
}

export function nextSeason(night) {
  return SEASONS[(Math.floor(night / SEASON_NIGHTS) + 1) % SEASONS.length];
}

/* Weather is rolled against the season's own table rather than one
   global set of odds: a snowstorm in high summer is a bug, and a
   winter without one is a missed opportunity. */
export function rollSeasonWeather(rng, night, WEATHER) {
  const s = seasonFor(night);
  const r = rng();
  let acc = 0;
  for (const [id, p] of Object.entries(s.weather)) {
    if (id === 'ashfall' && night < 3) continue;
    acc += p;
    if (r < acc) return WEATHER[id] || WEATHER.clear;
  }
  return WEATHER.clear;
}

/* Multiplier on a species' spawn odds. Wolves in winter, fawns in
   spring: the woods should not hold the same population all year. */
export function seasonAnimalWeight(night, type) {
  const s = seasonFor(night);
  const w = s.animals[type];
  return w === undefined ? 1 : w;
}
