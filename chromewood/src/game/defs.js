/* ============================================================
   defs.js - the content tables

   Abilities, enemies, the skill tree and the beacon upgrades all
   live here as plain data. The simulation reads them and never
   hard-codes a number, so balancing is an edit in one file and
   the host and its clients agree on every value by construction.
   ============================================================ */

/* ------------------------------------------------------- abilities */
/* cost is energy; cd is seconds. `kind` selects the branch in
   abilities.js that actually makes it happen. */
export const ABILITIES = {
  bolt: {
    id: 'bolt', name: 'Arc Bolt', icon: '✦', kind: 'projectile',
    cost: 0, cd: 0.30, damage: 15, speed: 26, life: 0.85, radius: 0.30,
    color: 0x7ee8ff, trail: 0x3fe0ff, primary: true,
    desc: 'Your sidearm. Costs nothing, fires forever.',
  },
  nova: {
    id: 'nova', name: 'Arcane Nova', icon: '◎', kind: 'nova',
    cost: 26, cd: 5.5, damage: 46, radius: 4.6, knock: 11,
    color: 0xb07bff,
    desc: 'A ring of force. Everything close gets hurt and thrown.',
  },
  chain: {
    id: 'chain', name: 'Chain Lightning', icon: '⌇', kind: 'chain',
    cost: 22, cd: 4.2, damage: 30, jumps: 4, range: 9, falloff: 0.82,
    color: 0x7ee8ff,
    desc: 'Arcs from target to target, losing a little each jump.',
  },
  rail: {
    id: 'rail', name: 'Rail Lance', icon: '⟶', kind: 'beam',
    cost: 30, cd: 6.0, damage: 92, range: 22, width: 0.65,
    color: 0xff4fd8,
    desc: 'A line through everything standing in it.',
  },
  blink: {
    id: 'blink', name: 'Phase Blink', icon: '⇢', kind: 'blink',
    cost: 18, cd: 7.0, distance: 8.5, damage: 28, radius: 2.6,
    color: 0x9d6ff0,
    desc: 'Step out of the world and back in somewhere better.',
  },
  barrier: {
    id: 'barrier', name: 'Aegis Field', icon: '⬡', kind: 'buff',
    cost: 28, cd: 13.0, duration: 6.0, shield: 70, slowRadius: 5.0, slow: 0.45,
    color: 0x3fe0ff,
    desc: 'Plating and a drag field. Buys you six seconds.',
  },
  overclock: {
    id: 'overclock', name: 'Overclock', icon: '⚡', kind: 'buff',
    cost: 24, cd: 15.0, duration: 7.0, haste: 0.42, power: 0.38,
    color: 0xffb03a,
    desc: 'Everything faster and harder. Your core will not enjoy it.',
  },
  turret: {
    id: 'turret', name: 'Chrome Sentry', icon: '⊞', kind: 'summon',
    cost: 34, cd: 17.0, duration: 22, hp: 90, damage: 13, fireRate: 0.42, range: 11,
    color: 0xc8d4e2,
    desc: 'Bolt a gun to the ground and let it work.',
  },
  drone: {
    id: 'drone', name: 'Scrap Drone', icon: '◈', kind: 'summon',
    cost: 30, cd: 19.0, duration: 26, hp: 55, damage: 11, fireRate: 0.55, range: 9, orbit: true,
    color: 0xffb03a,
    desc: 'It follows you. It shoots things. It asks for nothing.',
  },
  glyph: {
    id: 'glyph', name: 'Glyph Trap', icon: '⊛', kind: 'trap',
    cost: 20, cd: 8.0, damage: 70, radius: 3.2, arm: 0.6, life: 20, burn: 4,
    color: 0xff4fd8,
    desc: 'A rune that waits. Patient, and then not.',
  },
  siphon: {
    id: 'siphon', name: 'Lifesiphon', icon: '⊝', kind: 'channel',
    cost: 14, cd: 9.0, duration: 2.4, dps: 40, range: 8.5, leech: 0.55,
    color: 0x63ff9d,
    desc: 'Take what they have. You need it more.',
  },
};

export const PRIMARY_ID = 'bolt';

/* ---------------------------------------------------------- enemies */
export const ENEMIES = {
  husk: {
    id: 'husk', name: 'Husk', cost: 6, tier: 1,
    hp: 46, speed: 2.9, damage: 11, range: 1.15, attackCd: 1.1, radius: 0.40,
    xp: 12, mass: 1.0, color: 0x5f5078, accent: 0xff4fd8, height: 1.15,
    ai: 'melee',
  },
  spark: {
    id: 'spark', name: 'Spark', cost: 5, tier: 1,
    hp: 24, speed: 5.2, damage: 7, range: 0.95, attackCd: 0.72, radius: 0.30,
    xp: 9, mass: 0.6, color: 0x43718e, accent: 0x7ee8ff, height: 0.85,
    ai: 'melee',
  },
  caster: {
    id: 'caster', name: 'Wisp Caster', cost: 12, tier: 2,
    hp: 40, speed: 2.4, damage: 14, range: 10.5, attackCd: 2.0, radius: 0.36,
    xp: 20, mass: 0.8, color: 0x70478a, accent: 0xb07bff, height: 1.25,
    ai: 'ranged', projectileSpeed: 13, keepAway: 7.0,
  },
  bomber: {
    id: 'bomber', name: 'Burster', cost: 10, tier: 2,
    hp: 34, speed: 4.1, damage: 42, range: 1.6, attackCd: 99, radius: 0.42,
    xp: 18, mass: 0.9, color: 0x8e5b42, accent: 0xffb03a, height: 1.0,
    ai: 'bomber', fuse: 0.75, blastRadius: 3.2,
  },
  stalker: {
    id: 'stalker', name: 'Stalker', cost: 16, tier: 3,
    hp: 70, speed: 4.6, damage: 19, range: 1.3, attackCd: 1.4, radius: 0.38,
    xp: 30, mass: 1.0, color: 0x36566f, accent: 0x63ff9d, height: 1.25,
    ai: 'dasher', dashCd: 3.4, dashSpeed: 15, dashTime: 0.28,
  },
  warden: {
    id: 'warden', name: 'Warden', cost: 26, tier: 3,
    hp: 190, speed: 2.1, damage: 24, range: 1.5, attackCd: 1.7, radius: 0.60,
    xp: 55, mass: 2.2, color: 0x5d5d74, accent: 0x3fe0ff, height: 1.6,
    ai: 'melee', armor: 0.28, auraRadius: 7, auraArmor: 0.22,
  },
  colossus: {
    id: 'colossus', name: 'Colossus', cost: 90, tier: 4, boss: true,
    hp: 1500, speed: 2.0, damage: 40, range: 2.6, attackCd: 2.2, radius: 1.15,
    xp: 400, mass: 6, color: 0x4b4160, accent: 0xff4fd8, height: 2.8,
    ai: 'boss_slam', slamCd: 6.5, slamRadius: 6.0, slamDamage: 55, summon: 'husk',
  },
  riftheart: {
    id: 'riftheart', name: 'Rift Heart', cost: 90, tier: 4, boss: true,
    hp: 1250, speed: 2.6, damage: 26, range: 12, attackCd: 1.5, radius: 1.0,
    xp: 420, mass: 5, color: 0x5e2270, accent: 0xff4fd8, height: 2.4,
    ai: 'boss_caster', projectileSpeed: 12, volley: 5, summon: 'spark',
  },
};

/* Elites get a flat multiplier and a visible aura. */
export const ELITE = { hp: 2.6, damage: 1.5, xp: 2.8, speed: 1.12, scale: 1.25 };

/* ------------------------------------------------------- skill tree */
/* Three branches. `req` is the node that must already be taken, and
   `cost` is skill points. Effects are applied as additive or
   multiplicative modifiers by name in sim.js. */
export const SKILL_BRANCHES = [
  { id: 'arcane', name: 'ARCANE', color: '#b07bff', blurb: 'Raw power, paid for in energy.' },
  { id: 'chrome', name: 'CHROME', color: '#3fe0ff', blurb: 'Machines, plating and uptime.' },
  { id: 'wild',   name: 'WILD',   color: '#63ff9d', blurb: 'Speed, salvage and staying alive.' },
];

export const SKILLS = {
  /* --- arcane ----------------------------------------------------- */
  arc_power1:  { branch: 'arcane', tier: 0, name: 'Focused Core', cost: 1, mods: { power: 0.12 }, desc: '+12% damage.' },
  arc_nova:    { branch: 'arcane', tier: 1, name: 'Arcane Nova', cost: 1, req: 'arc_power1', unlock: 'nova', desc: 'Unlocks Arcane Nova.' },
  arc_energy:  { branch: 'arcane', tier: 1, name: 'Deep Well', cost: 1, req: 'arc_power1', mods: { maxEnergy: 35, energyRegen: 3 }, desc: '+35 max energy, faster regen.' },
  arc_chain:   { branch: 'arcane', tier: 2, name: 'Chain Lightning', cost: 1, req: 'arc_nova', unlock: 'chain', desc: 'Unlocks Chain Lightning.' },
  arc_crit:    { branch: 'arcane', tier: 2, name: 'Resonance', cost: 1, req: 'arc_energy', mods: { crit: 0.12, critMult: 0.35 }, desc: '+12% crit, +0.35x crit damage.' },
  arc_blink:   { branch: 'arcane', tier: 3, name: 'Phase Blink', cost: 2, req: 'arc_chain', unlock: 'blink', desc: 'Unlocks Phase Blink.' },
  arc_rail:    { branch: 'arcane', tier: 3, name: 'Rail Lance', cost: 2, req: 'arc_crit', unlock: 'rail', desc: 'Unlocks Rail Lance.' },
  arc_power2:  { branch: 'arcane', tier: 4, name: 'Overchannel', cost: 2, req: 'arc_blink', mods: { power: 0.30, cdr: 0.12 }, desc: '+30% damage, -12% cooldowns.' },
  arc_glyph:   { branch: 'arcane', tier: 4, name: 'Glyph Trap', cost: 2, req: 'arc_rail', unlock: 'glyph', desc: 'Unlocks Glyph Trap.' },

  /* --- chrome ----------------------------------------------------- */
  chr_plate1:  { branch: 'chrome', tier: 0, name: 'Plating', cost: 1, mods: { maxHp: 30, armor: 0.06 }, desc: '+30 max HP, +6% armour.' },
  chr_shield:  { branch: 'chrome', tier: 1, name: 'Field Emitter', cost: 1, req: 'chr_plate1', mods: { shieldMax: 45, shieldRegen: 5 }, desc: '+45 shield, faster recharge.' },
  chr_turret:  { branch: 'chrome', tier: 1, name: 'Chrome Sentry', cost: 1, req: 'chr_plate1', unlock: 'turret', desc: 'Unlocks Chrome Sentry.' },
  chr_barrier: { branch: 'chrome', tier: 2, name: 'Aegis Field', cost: 1, req: 'chr_shield', unlock: 'barrier', desc: 'Unlocks Aegis Field.' },
  chr_drone:   { branch: 'chrome', tier: 2, name: 'Scrap Drone', cost: 1, req: 'chr_turret', unlock: 'drone', desc: 'Unlocks Scrap Drone.' },
  chr_over:    { branch: 'chrome', tier: 3, name: 'Overclock', cost: 2, req: 'chr_drone', unlock: 'overclock', desc: 'Unlocks Overclock.' },
  chr_armor2:  { branch: 'chrome', tier: 3, name: 'Hardpoints', cost: 2, req: 'chr_barrier', mods: { armor: 0.16, maxHp: 45 }, desc: '+16% armour, +45 max HP.' },
  chr_uptime:  { branch: 'chrome', tier: 4, name: 'Cycle Tuning', cost: 2, req: 'chr_over', mods: { cdr: 0.20, summonPower: 0.35 }, desc: '-20% cooldowns, stronger constructs.' },
  chr_thorn:   { branch: 'chrome', tier: 4, name: 'Reactive Skin', cost: 2, req: 'chr_armor2', mods: { thorns: 22 }, desc: 'Melee attackers take 22 back.' },

  /* --- wild ------------------------------------------------------- */
  wld_speed1:  { branch: 'wild', tier: 0, name: 'Light Step', cost: 1, mods: { speed: 0.10 }, desc: '+10% move speed.' },
  wld_dash:    { branch: 'wild', tier: 1, name: 'Second Wind', cost: 1, req: 'wld_speed1', mods: { dashCharges: 1, dashCdr: 0.18 }, desc: '+1 dash charge, faster recovery.' },
  wld_harvest: { branch: 'wild', tier: 1, name: 'Scavenger', cost: 1, req: 'wld_speed1', mods: { harvest: 0.55, magnet: 2.4 }, desc: '+55% salvage, wider pickup.' },
  wld_siphon:  { branch: 'wild', tier: 2, name: 'Lifesiphon', cost: 1, req: 'wld_dash', unlock: 'siphon', desc: 'Unlocks Lifesiphon.' },
  wld_charge:  { branch: 'wild', tier: 2, name: 'Slow Burn', cost: 1, req: 'wld_harvest', mods: { chargeDrain: -0.45, chargeMax: 40 }, desc: 'Your core drains far slower.' },
  wld_leech:   { branch: 'wild', tier: 3, name: 'Predation', cost: 2, req: 'wld_siphon', mods: { leech: 0.07 }, desc: 'Heal for 7% of damage dealt.' },
  wld_revive:  { branch: 'wild', tier: 3, name: 'Field Medic', cost: 2, req: 'wld_charge', mods: { reviveSpeed: 0.6, reviveHeal: 0.35 }, desc: 'Revive allies faster and healthier.' },
  wld_speed2:  { branch: 'wild', tier: 4, name: 'Bloodrush', cost: 2, req: 'wld_leech', mods: { speed: 0.16, killHaste: 0.35 }, desc: 'Faster, and much faster after a kill.' },
  wld_tough:   { branch: 'wild', tier: 4, name: 'Deep Roots', cost: 2, req: 'wld_revive', mods: { maxHp: 60, regen: 2.2 }, desc: '+60 max HP and steady regeneration.' },
};

/* ------------------------------------------------- beacon upgrades */
/* Paid for with shared resources; every player benefits. */
export const BEACON_UPGRADES = {
  walls:   { name: 'Bulwark',      icon: '#', max: 4, cost: (l) => ({ scrap: 25 + l * 18 }),                   desc: (l) => `Beacon +${(l + 1) * 350} max integrity.` },
  turrets: { name: 'Ward Turrets', icon: '+', max: 3, cost: (l) => ({ scrap: 40 + l * 30, essence: 10 + l * 8 }), desc: (l) => (l ? `${l + 1} automated turrets defend the plaza.` : 'An automated turret defends the plaza.') },
  lamps:   { name: 'Floodlights',  icon: '*', max: 3, cost: (l) => ({ scrap: 20 + l * 15 }),                   desc: (l) => `Lit radius +${(l + 1) * 5}m. Enemies keep out of the light.` },
  forge:   { name: 'Core Forge',   icon: '^', max: 3, cost: (l) => ({ essence: 30 + l * 22 }),                 desc: (l) => `Everyone deals +${(l + 1) * 8}% damage.` },
  clinic:  { name: 'Repair Bay',   icon: '~', max: 3, cost: (l) => ({ scrap: 30 + l * 20, essence: 12 + l * 10 }), desc: (l) => `Beacon heals +${(l + 1) * 6} HP/s and recharges cores faster.` },
  relay:   { name: 'Rift Damper',  icon: 'o', max: 2, cost: (l) => ({ essence: 45 + l * 35, cores: 1 + l }),    desc: (l) => `Night waves ${(l + 1) * 12}% smaller.` },
};

/* --------------------------------------------------------- statuses */
export const STATUS = {
  burn:  { dps: 9, duration: 3.2, color: 0xffb03a },
  slow:  { factor: 0.45, duration: 2.0, color: 0x3fe0ff },
  shock: { factor: 0.25, duration: 1.2, color: 0x7ee8ff },
  weak:  { factor: 0.7, duration: 4.0, color: 0xb07bff },
};

/* Shrine boons: picked at random when you touch one. */
export const BOONS = [
  { id: 'might',  name: 'Might',   duration: 60, mods: { power: 0.35 }, color: 0xff4fd8, desc: '+35% damage for a minute.' },
  { id: 'haste',  name: 'Haste',   duration: 60, mods: { speed: 0.25, cdr: 0.20 }, color: 0x63ff9d, desc: 'Faster feet and cooldowns.' },
  { id: 'ward',   name: 'Ward',    duration: 60, mods: { armor: 0.3, shieldRegen: 8 }, color: 0x3fe0ff, desc: 'Tougher and quicker to recover.' },
  { id: 'wealth', name: 'Wealth',  duration: 90, mods: { harvest: 1.0, magnet: 4 }, color: 0xffb03a, desc: 'Double salvage while it lasts.' },
];
