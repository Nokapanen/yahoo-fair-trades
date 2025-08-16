// fairness.js — player valuation & trade impact (CommonJS)

function buildCategoryListFromSettings(settings) {
  const cats = [];
  const stats = settings?.stat_categories?.stats || settings?.stat_categories?.stat || [];
  for (const s of stats) {
    const stat = s.stat || s;
    const id = Number(stat.stat_id);
    if (!Number.isFinite(id)) continue;
    const name = (stat.name || "").toLowerCase();
    if (name.includes("games played")) continue;
    cats.push({ id, name: stat.name, position_type: stat.position_type || null });
  }
  return cats;
}

function computePerGame(players) {
  return (players || []).map((p) => {
    const gp = Number(p.gp || p.games_played || 0) || 0;
    const out = { ...p, per: {} };
    if (!gp) return out;
    for (const [k, v] of Object.entries(p.stats || {})) {
      const num = Number(v) || 0;
      out.per[k] = num / gp;
    }
    return out;
  });
}

function valuePlayers(pool, cats) {
  const sums = {}, sums2 = {}, counts = {};
  for (const c of cats) { sums[c.id] = 0; sums2[c.id] = 0; counts[c.id] = 0; }
  for (const p of pool) {
    for (const c of cats) {
      const v = Number(p.per?.[c.id]) || 0;
      sums[c.id] += v;
      sums2[c.id] += v * v;
      counts[c.id] += 1;
    }
  }
  const mean = {}, stdev = {};
  for (const c of cats) {
    const n = counts[c.id] || 1;
    const m = sums[c.id] / n;
    const variance = Math.max((sums2[c.id] / n) - m * m, 0);
    mean[c.id] = m;
    stdev[c.id] = Math.sqrt(variance) || 1e-9;
  }
  for (const p of pool) {
    let val = 0;
    for (const c of cats) {
      const v = Number(p.per?.[c.id]) || 0;
      val += (v - mean[c.id]) / stdev[c.id];
    }
    p.value = Number(val.toFixed(4));
  }
  return pool;
}

function computeStartersByPos(settings) {
  const pos = settings?.roster_positions?.roster_position || settings?.roster_positions || [];
  const out = { C: 0, LW: 0, RW: 0, D: 0, Util: 0, G: 0 };
  for (const rp of pos) {
    const p = rp?.roster_position || rp;
    const label = p.position || p?.name || "";
    const count = Number(p.count || p?.count || 0) || 0;
    if (!count) continue;
    if (out[label] !== undefined) out[label] += count;
    else if (label === "F" || label === "UTIL" || label === "BN") out.Util += count;
  }
  return out;
}

function tradeImpactForTeam({ starters, bench, incoming, freeAgents, startersByPos }) {
  const after = [...starters, ...bench];
  const withIncoming = [...after, ...(incoming || [])];

  const sorted = [...withIncoming].sort((a, b) => (b.value || 0) - (a.value || 0));
  const need = { ...startersByPos };
  const chosen = [];
  const leftovers = [];

  for (const p of sorted) {
    let placed = false;
    for (const [pos, count] of Object.entries(need)) {
      const eligible =
        pos === "Util" ? !p.isGoalie : pos === "G" ? p.isGoalie : (p.pos || []).includes(pos);
      if (eligible && count > 0) {
        chosen.push(p);
        need[pos] = count - 1;
        placed = true;
        break;
      }
    }
    if (!placed) leftovers.push(p);
  }

  if (Object.values(need).some((n) => n > 0)) {
    const faSorted = [...(freeAgents || [])].sort((a, b) => (b.value || 0) - (a.value || 0));
    for (const p of faSorted) {
      for (const [pos, count] of Object.entries(need)) {
        const eligible =
          pos === "Util" ? !p.isGoalie : pos === "G" ? p.isGoalie : (p.pos || []).includes(pos);
        if (eligible && count > 0) {
          chosen.push(p);
          need[pos] = count - 1;
          break;
        }
      }
      if (!Object.values(need).some((n) => n > 0)) break;
    }
  }

  const strength = chosen.reduce((acc, p) => acc + (Number(p.value) || 0), 0);
  const baseline = (starters || []).reduce((acc, p) => acc + (Number(p.value) || 0), 0);
  return strength - baseline;
}

function verdict(tiA, tiB, { lossTol = -0.35, gainMin = 0.25, imbalanceMax = 1.0 } = {}) {
  const imbalance = Math.abs(tiA - tiB);
  const bothAboveLossTol = tiA >= lossTol && tiB >= lossTol;
  const oneAboveGain = tiA >= gainMin || tiB >= gainMin;
  const okImbalance = imbalance <= imbalanceMax;

  if (bothAboveLossTol && oneAboveGain && okImbalance) return { status: "APPROVE", color: "green" };
  return { status: "REVIEW", color: "yellow" };
}

module.exports = {
  buildCategoryListFromSettings,
  computePerGame,
  valuePlayers,
  computeStartersByPos,
  tradeImpactForTeam,
  verdict,
};
