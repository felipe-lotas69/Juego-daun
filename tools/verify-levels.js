/* Level verifier:
   1. door-gated reachability (closed doors block, buttons must be reached first)
   2. squish detector - geometry that occupies the 44px of standing space
      above a walkable surface
   Envelope measured from the real physics in js/entities.js.            */
const fs = require('fs'), vm = require('vm');
const sb = { window: {} }; vm.createContext(sb);
vm.runInContext(fs.readFileSync('js/levels.js', 'utf8'), sb);
vm.runInContext(fs.readFileSync('js/versusmaps.js', 'utf8'), sb);
const which = process.argv[2] === 'versus' ? 'VERSUS_MAPS' : 'LEVELS';
const LEVELS = sb.window[which];

/* Measured by sweeping input sequences a player can actually perform:
   run up, release to unwind the lean, jump, steer in the air. Unwinding
   the lean also bleeds speed, so height and distance trade hard. */
const FRONTIER = [[0,126],[10,126],[20,126],[30,121],[40,121],[50,119],[60,115],[70,109],[80,108],[90,103],[100,100],[110,95],[120,92],[130,88],[140,85],[150,81],[160,78],[170,75],[180,71],[190,68],[200,66],[210,63],[220,60],[230,56],[240,52],[250,48],[260,43],[270,36],[280,30],[290,23],[300,14],[310,5],[320,0]];
const MARGIN = 0.80, MAX_GAP = 300, PH = 44, PW = 24;

function maxRise(g) {
  if (g > MAX_GAP) return -1e9;
  for (let i = 1; i < FRONTIER.length; i++)
    if (g <= FRONTIER[i][0]) {
      const [g0,r0] = FRONTIER[i-1], [g1,r1] = FRONTIER[i];
      return (r0 + (r1-r0)*(g-g0)/(g1-g0)) * MARGIN;
    }
  return -1e9;
}
const gap = (a,b) => a.x2 < b.x1 ? b.x1-a.x2 : (b.x2 < a.x1 ? a.x1-b.x2 : 0);
const overlap = (a,b) => !(a.x+a.w <= b.x || b.x+b.w <= a.x || a.y+a.h <= b.y || b.y+b.h <= a.y);

function build(L) {
  const S = [];
  const add = (x,w,y,tag,door) => S.push({ x1:x, x2:x+w, y, tag, door: door||null });
  (L.platforms||[]).forEach((p,i)=>add(p.x,p.w,p.y,p.type==='bounce'?'bounce'+i:'plat'+i));
  (L.glass||[]).forEach((g,i)=>add(g.x,g.w,g.y,'glass'+i));
  (L.crates||[]).forEach((c,i)=>add(c.x,c.w||34,c.y,'crate'+i));
  (L.elevators||[]).forEach((e,i)=>{
    add(e.x,e.w,e.y,'lift'+i+'A'); add(e.bx!=null?e.bx:e.x,e.w,e.by!=null?e.by:e.y,'lift'+i+'B');
  });
  (L.doors||[]).forEach((d,i)=>add(d.x,d.w,d.y,'doortop'+i,d.id));
  return S;
}

function blocks(a, b, doorRects) {
  const loX = Math.min(a.x2, b.x2), hiX = Math.max(a.x1, b.x1);
  const x0 = Math.min(a.x1,b.x1), x1 = Math.max(a.x2,b.x2);
  const yTop = Math.min(a.y,b.y) - PH - 40, yBot = Math.max(a.y,b.y);
  for (const d of doorRects) {
    if (d.x + d.w > x0 && d.x < x1 && d.y + d.h > yTop && d.y < yBot) {
      // only counts if it actually sits between the two spans
      if (d.x + d.w >= Math.min(loX,hiX) - 30 && d.x <= Math.max(loX,hiX) + 30) return true;
    }
  }
  return false;
}

let fails = 0;
LEVELS.forEach((L, li) => {
  const S = build(L);
  const under = (px, py) => {
    let best=-1, bd=1e9;
    S.forEach((s,i)=>{ if(px>=s.x1-20&&px<=s.x2+20&&s.y>=py-5){const d=s.y-py; if(d<bd){bd=d;best=i;}} });
    return best;
  };
  const SP = L.spawn || L.spawns[0];
  const start = under(SP.x, SP.y - 10);
  const goalIdx = under(L.goal.x + 48, L.goal.y + 58);

  const liftPair = new Map();
  S.forEach((s,i)=>{ const m=/^lift(\d+)([AB])$/.exec(s.tag); if(m){ if(!liftPair.has(m[1]))liftPair.set(m[1],[]); liftPair.get(m[1]).push(i);} });

  let openDoors = new Set();
  let seen, pass = 0, log = [];
  for (;;) {
    const doorRects = (L.doors||[]).filter(d=>!openDoors.has(d.id));
    const adj = S.map(()=>[]);
    for (let i=0;i<S.length;i++) for (let j=0;j<S.length;j++) {
      if (i===j) continue;
      const a=S[i], b=S[j], g=gap(a,b), rise=a.y-b.y;
      let ok = rise>=0 ? (a.tag.startsWith('bounce') ? (rise<=150&&g<=200) : rise<=maxRise(g))
                       : g <= Math.min(460, 260 + (-rise)*0.3);
      if (ok && blocks(a,b,doorRects)) ok = false;
      if (ok) adj[i].push(j);
    }
    liftPair.forEach(([a,b])=>{ if(b!=null){adj[a].push(b);adj[b].push(a);} });

    seen = new Set([start]); const q=[start];
    while(q.length){ const n=q.pop(); for(const m of adj[n]) if(!seen.has(m)){seen.add(m);q.push(m);} }

    // which buttons can we now touch?
    let progressed = false;
    (L.buttons||[]).forEach(b=>{
      if (openDoors.has(b.target)) return;
      const u = under(b.x + (b.w||22)/2, b.y + (b.h||22) - 2);
      if (u >= 0 && seen.has(u)) { openDoors.add(b.target); progressed = true; log.push(`  opened ${b.target} from ${S[u].tag}`); }
    });
    if (!progressed || pass++ > 6) break;
  }

  const ok = seen.has(goalIdx);
  if (!ok) fails++;
  console.log(`L${li+1} ${L.name.padEnd(17)} goal=${S[goalIdx]?S[goalIdx].tag:'??'} REACHABLE=${ok}  doorsOpened=[${[...openDoors]}]`);
  log.forEach(l=>console.log(l));
  (L.doors||[]).forEach(d=>{ if(!openDoors.has(d.id)) console.log(`  ! door ${d.id} never opens - its button is unreachable`); });

  // orphan content
  S.forEach((s,i)=>{ if(!seen.has(i) && !/^plat(0|1)$/.test(s.tag) && s.y>0)
    console.log(`  . unreachable surface ${s.tag} @${s.x1},${s.y}`); });
  (L.checkpoints||[]).forEach((c,ci)=>{ const u=under(c.x,c.y-2); if(u<0||!seen.has(u)) console.log(`  ! checkpoint${ci} @${c.x},${c.y} unreachable`); });

  // squish: solid geometry sitting in the standing space over a walkable surface
  const rects = [];
  (L.platforms||[]).forEach((p,i)=>rects.push({...p, tag:'plat'+i}));
  (L.doors||[]).forEach((d,i)=>rects.push({...d, tag:'door'+i}));
  (L.elevators||[]).forEach((e,i)=>{            // swept box over the lift's whole travel
    if (e.crusher) return;                      // a piston is supposed to be in the way
    const x=Math.min(e.x, e.bx!=null?e.bx:e.x), y=Math.min(e.y, e.by!=null?e.by:e.y);
    const w=Math.abs((e.bx!=null?e.bx:e.x)-e.x)+e.w, h=Math.abs((e.by!=null?e.by:e.y)-e.y)+e.h;
    rects.push({x,y,w,h,tag:'lift'+i+'(swept)'});
  });
  S.forEach(s => {
    if (!seen.has(S.indexOf(s))) return;
    const ownLift = /^lift(\d+)[AB]$/.exec(s.tag);
    const stand = { x: s.x1, y: s.y - PH, w: s.x2 - s.x1, h: PH };
    rects.forEach(r => {
      if (r.tag === s.tag) return;
      if (ownLift && r.tag === 'lift' + ownLift[1] + '(swept)') return;   // a lift is not its own hazard
      if (!overlap(stand, r)) return;
      const covX = Math.min(stand.x+stand.w, r.x+r.w) - Math.max(stand.x, r.x);
      const free = (s.x2 - s.x1) - covX;
      if (free < PW + 8) console.log(`  !! squish: ${r.tag} covers standing space over ${s.tag} (only ${Math.round(free)}px clear)`);
    });
  });
});
console.log(fails ? `\n${fails} LEVEL(S) UNCOMPLETABLE` : '\nall levels completable');
if (fails) process.exit(1);
