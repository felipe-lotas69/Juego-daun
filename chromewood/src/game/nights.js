/* ============================================================
   nights.js - what is coming, and what the sky is doing

   Every night is drawn from a deck rather than being the same wave
   with bigger numbers. The type is announced at dusk, so a night is
   a decision - fight it, hide from it, or use it - made before it
   starts rather than discovered halfway through.

   Weather runs on its own clock and cuts across all of it: rain
   puts out fires and carries sound, fog blinds everyone equally,
   ashfall means the rift is already awake.
   ============================================================ */

export const NIGHTS = {
  swarm: {
    id: 'swarm', name: 'SWARM', color: '#ff8a5a',
    blurb: 'Many, and none of them large.',
    weights: { spark: 5, husk: 4, bomber: 1 },
    budget: 1.25, interval: 0.7, seekBeacon: 0.7,
  },
  hunt: {
    id: 'hunt', name: 'THE HUNT', color: '#63ff9d',
    blurb: 'Few. Fast. They know where you have been working.',
    weights: { stalker: 6, spark: 2 }, elite: 0.25,
    budget: 0.8, interval: 1.6, trackResonance: 1, seekBeacon: 0.1,
  },
  siege: {
    id: 'siege', name: 'SIEGE', color: '#ffb03a',
    blurb: 'Heavy things, and they are coming for what you built.',
    weights: { warden: 5, husk: 4, bomber: 2 },
    budget: 1.0, interval: 1.4, structureFocus: 2.5, seekBeacon: 1,
  },
  bloom: {
    id: 'bloom', name: 'BLOOM', color: '#ff4fd8',
    blurb: 'The ground itself is turning. Something is seeding it.',
    weights: { husk: 3, caster: 4, spark: 3 },
    budget: 0.9, interval: 1.2, spreadCorruption: true, boss: 'bloomheart',
  },
  blackout: {
    id: 'blackout', name: 'BLACKOUT', color: '#8b5cf0',
    blurb: 'Nothing electrical will hold. Fire still burns.',
    weights: { husk: 4, stalker: 3, caster: 2 },
    budget: 1.0, interval: 1.1, killsPower: true, darkness: 0.55,
  },
  harvest: {
    id: 'harvest', name: 'HARVEST', color: '#ffd24a',
    blurb: 'They are carrying cores tonight. Something big is escorting them.',
    weights: { husk: 4, spark: 3, warden: 2 }, elite: 0.35,
    budget: 1.15, interval: 1.0, coreDrop: 0.55, boss: 'colossus',
  },
  storm: {
    id: 'storm', name: 'RIFT STORM', color: '#7ee8ff',
    blurb: 'Lightning that is not weather. Do not stand in the open.',
    weights: { spark: 5, caster: 4, stalker: 2 },
    budget: 1.05, interval: 1.0, strikes: true,
  },
  quiet: {
    id: 'quiet', name: 'QUIET', color: '#9fd8ff',
    blurb: 'Nothing is coming. Use it.',
    weights: { husk: 1 },
    budget: 0.12, interval: 3.4, gift: true,
  },
};

/* The order nights arrive in. The first two are fixed so a run
   always teaches the same first lesson, then the deck is shuffled
   with a rule: never the same type twice, and quiet at most once
   every four. */
export function buildNightDeck(rng, count = 40) {
  const out = ['swarm', 'swarm'];
  const pool = ['swarm', 'hunt', 'siege', 'bloom', 'blackout', 'harvest', 'storm'];
  let sinceQuiet = 0;
  while (out.length < count) {
    let pick;
    if (sinceQuiet >= 4 && rng() < 0.22) { pick = 'quiet'; sinceQuiet = 0; }
    else {
      let guard = 0;
      do { pick = pool[Math.floor(rng() * pool.length)]; } while (pick === out[out.length - 1] && guard++ < 8);
      sinceQuiet++;
    }
    out.push(pick);
  }
  return out;
}

export const WEATHER = {
  clear: { id: 'clear', name: 'Clear', fog: 1, wet: 0, resonance: 1, vis: 1 },
  rain: {
    id: 'rain', name: 'Rain', fog: 0.72, wet: 1, resonance: 1.35, vis: 0.85,
    blurb: 'Fires gutter. Sound travels.',
  },
  fog: {
    id: 'fog', name: 'Fog', fog: 0.40, wet: 0.3, resonance: 0.8, vis: 0.5,
    blurb: 'You cannot see them. They cannot see you either.',
  },
  ashfall: {
    id: 'ashfall', name: 'Ashfall', fog: 0.62, wet: 0, resonance: 1.6, vis: 0.8,
    hostile: true, blurb: 'The rift is already awake.',
  },
  snowstorm: {
    id: 'snowstorm', name: 'Snowstorm', fog: 0.45, wet: 0.5, resonance: 0.9, vis: 0.6,
    cold: 2.2, blurb: 'Warmth is the only thing that matters out here.',
  },
};

export function rollWeather(rng, night) {
  const r = rng();
  if (night >= 3 && r < 0.10) return WEATHER.ashfall;
  if (r < 0.20) return WEATHER.rain;
  if (r < 0.30) return WEATHER.fog;
  if (r < 0.36) return WEATHER.snowstorm;
  return WEATHER.clear;
}

/* Contracts: small, rotating jobs posted at the beacon. They give
   a reason to go somewhere specific instead of grinding the nearest
   tree, and they are how cores enter the economy early. */
export const CONTRACTS = [
  { id: 'timber', name: 'Timber Haul', need: { kind: 'item', item: 'wood', n: 60 },
    reward: [['scrap', 14], ['iron_ore', 6]], desc: 'Sixty wood to the beacon store.' },
  { id: 'ore', name: 'Ore Run', need: { kind: 'item', item: 'iron_ore', n: 18 },
    reward: [['charcoal', 8], ['essence', 12]], desc: 'Eighteen iron ore. The crags have it.' },
  { id: 'cull', name: 'Cull', need: { kind: 'kill', n: 18 },
    reward: [['essence', 20], ['wire', 6]], desc: 'Eighteen of them, however you like.' },
  { id: 'elite', name: 'Named Quarry', need: { kind: 'killElite', n: 2 },
    reward: [['core', 1], ['gold_ore', 6]], desc: 'Two elites. They are the ones with the glow.' },
  { id: 'hunt', name: 'Provisioning', need: { kind: 'item', item: 'cookedmeat', n: 10 },
    reward: [['hide', 10], ['fiber', 20]], desc: 'Ten cooked meals for the store.' },
  { id: 'clear', name: 'Quiet Ground', need: { kind: 'noDamageNight' },
    reward: [['core', 1], ['essence', 30]], desc: 'Get through one night without being hit.' },
  { id: 'build', name: 'Hold Fast', need: { kind: 'build', n: 12 },
    reward: [['stone', 40], ['iron_ore', 10]], desc: 'Put down twelve pieces of structure.' },
  { id: 'deep', name: 'Deep Vein', need: { kind: 'item', item: 'gold_ore', n: 10 },
    reward: [['riftglass', 2], ['essence', 40]], desc: 'Ten gold ore. It only grows high up.' },
];
