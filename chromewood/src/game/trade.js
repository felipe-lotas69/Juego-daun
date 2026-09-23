/* ============================================================
   trade.js - what the villages will swap with you

   Barter, not coins. A currency needs a sink or it inflates, and a
   survival game already has a perfectly good unit of value in the
   thing you had to walk somewhere to get.

   Every offer is a fixed pair: give this, get that. Four villages,
   four trades each, plus one that changes overnight so there is a
   reason to look in again. Nothing here holds state - an offer is a
   pure function of the village and the day - which is what lets the
   host and every client show the same board with nothing on the
   wire about it.
   ============================================================ */

export const VILLAGE_KINDS = {
  grange: {
    id: 'grange', name: 'Grange', trader: 'MILLER',
    color: 0x9bd05a,
    blurb: 'Grows more than it eats and is short of everything else.',
    offers: [
      { give: [['wood', 20]], get: [['bread', 3]] },
      { give: [['fiber', 30]], get: [['seed_grain', 4]] },
      { give: [['stone', 25]], get: [['stew', 2]] },
      { give: [['hide', 6]], get: [['cloth', 5]] },
    ],
    deals: [
      { give: [['grain', 8]], get: [['seed_berry', 3]] },
      { give: [['meat', 6]], get: [['bread', 4]] },
      { give: [['wood', 40]], get: [['plot', 2]] },
      { give: [['berries', 12]], get: [['stew', 3]] },
    ],
  },
  smithy: {
    id: 'smithy', name: 'Smithy', trader: 'SMITH',
    color: 0xffb03a,
    blurb: 'Takes ore off your hands and gives it back as metal.',
    offers: [
      { give: [['copper_ore', 4]], get: [['copper', 2]] },
      { give: [['iron_ore', 5]], get: [['iron', 2]] },
      { give: [['stone', 40], ['charcoal', 4]], get: [['iron', 3]] },
      { give: [['scrap', 18]], get: [['wire', 6]] },
    ],
    deals: [
      { give: [['gold_ore', 4]], get: [['gold', 2]] },
      { give: [['iron', 6]], get: [['blade_iron', 1]] },
      { give: [['copper', 8]], get: [['pick_iron', 1]] },
      { give: [['wood', 30]], get: [['charcoal', 8]] },
    ],
  },
  trapline: {
    id: 'trapline', name: 'Trapline', trader: 'TRAPPER',
    color: 0xc08a5e,
    blurb: 'Lives off the woods and will buy whatever you carry out.',
    offers: [
      { give: [['meat', 8]], get: [['cookedmeat', 6]] },
      { give: [['bone', 8]], get: [['hide', 5]] },
      { give: [['fiber', 24]], get: [['bandage', 3]] },
      { give: [['hide', 8]], get: [['torch', 4]] },
    ],
    deals: [
      { give: [['hide', 10]], get: [['spear', 1]] },
      { give: [['bone', 14]], get: [['club', 1]] },
      { give: [['cookedmeat', 6]], get: [['stew', 3]] },
      { give: [['mushroom', 10]], get: [['cookedmeat', 5]] },
    ],
  },
  apothecary: {
    id: 'apothecary', name: 'Apothecary', trader: 'HERBALIST',
    color: 0xb07bff,
    blurb: 'Deals in things that grow in the dark.',
    offers: [
      { give: [['mushroom', 10]], get: [['essence', 12]] },
      { give: [['petal', 12]], get: [['brew', 2]] },
      { give: [['essence', 24]], get: [['riftglass', 1]] },
      { give: [['berries', 14]], get: [['bandage', 4]] },
    ],
    deals: [
      { give: [['seed_spore', 4]], get: [['brew', 3]] },
      { give: [['riftglass', 2]], get: [['essence', 40]] },
      { give: [['essence', 16]], get: [['seed_spore', 6]] },
      { give: [['bone', 10]], get: [['petal', 12]] },
    ],
  },
};

export const KIND_LIST = Object.keys(VILLAGE_KINDS);

/* The four standing trades plus tonight's. `day` is the night count,
   so the board turns over while you sleep. */
export function villageOffers(village, day) {
  const def = VILLAGE_KINDS[village.kind];
  if (!def) return [];
  const deal = def.deals[(day + village.id) % def.deals.length];
  return [...def.offers, { ...deal, deal: true }];
}

export function villageDef(village) {
  return VILLAGE_KINDS[village.kind] || VILLAGE_KINDS.grange;
}
