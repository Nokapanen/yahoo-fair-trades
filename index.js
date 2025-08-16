// ---- keep the server alive & show real errors ----
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

const express = require("express");
const session = require("express-session");
const path = require("path");
require("dotenv").config();

const YF = require("yahoo-fantasy");
const YahooFantasy = YF?.default || YF;
const yf = new YahooFantasy(process.env.YAHOO_CLIENT_ID, process.env.YAHOO_CLIENT_SECRET);

const {
  PORT = 3000,
  YAHOO_CLIENT_ID,
  YAHOO_CLIENT_SECRET,
  SESSION_SECRET,
  CALLBACK_URL,
  LEAGUE_KEY,
  LEAGUE_ID,
  LEAGUE_NAME,
  LOSS_TOLERANCE = "-0.35",
  GAIN_MIN = "0.25",
  IMBALANCE_MAX = "1.0",
} = process.env;

if (!YAHOO_CLIENT_ID || !YAHOO_CLIENT_SECRET || !SESSION_SECRET || !CALLBACK_URL) {
  console.error("❌ Missing required .env: YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, SESSION_SECRET, CALLBACK_URL");
  process.exit(1);
}

const {
  buildCategoryListFromSettings,
  computePerGame,
  valuePlayers,
  computeStartersByPos,
  tradeImpactForTeam,
  verdict,
} = require("./fairness.js");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: "lax", secure: false }
}));

// ---- static UI ----
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- Yahoo OAuth (manual) ---------------- */
function yahooAuthorizeURL() {
  const q = new URLSearchParams({
    client_id: YAHOO_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: "code",
    prompt: "login"
  });
  return `https://api.login.yahoo.com/oauth2/request_auth?${q}`;
}

async function yahooExchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: CALLBACK_URL,
    code
  });
  const basic = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.login.yahoo.com/oauth2/get_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Token exchange failed", r.status, data);
    throw new Error(`Token error ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

app.get("/login", (_req, res) => res.redirect(yahooAuthorizeURL()));

app.get("/auth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) throw new Error("Missing ?code");
    const token = await yahooExchangeCodeForToken(code);
    req.session.token = token.access_token;
    yf.setUserToken(token.access_token);

    // try to resolve league on login
    await resolveLeagueKey(req);

    res.redirect("/");
  } catch (e) {
    console.error("[OAUTH_CALLBACK_ERROR]", e);
    res.status(500).send(`OAuth error: ${e.message || e}`);
  }
});

function requireAuth(req, res, next) {
  if (!req.session?.token) return res.status(401).json({ error: "not_authenticated" });
  yf.setUserToken(req.session.token);
  next();
}

/* --------------- League resolution helpers --------------- */
async function resolveLeagueKey(req) {
  if (req.session.leagueKey) return req.session.leagueKey;

  if (LEAGUE_KEY) {
    req.session.leagueKey = LEAGUE_KEY;
    return LEAGUE_KEY;
  }

  const { games } = await yf.user.games();                  // list games user plays
  const nhlGames = (games || []).filter((g) => g.code === "nhl");

  for (const g of nhlGames) {
    // ✅ correct yahoo-fantasy API: get leagues in a specific game
    const { leagues } = await yf.user.game_leagues(g.game_key);
    const match = (leagues || []).find((l) => {
      const idMatch = LEAGUE_ID && String(l.league_id) === String(LEAGUE_ID);
      const nameMatch = LEAGUE_NAME && String(l.name).trim().toLowerCase() === String(LEAGUE_NAME).trim().toLowerCase();
      return idMatch || nameMatch;
    });
    if (match) {
      req.session.leagueKey = match.league_key;
      return match.league_key;
    }
  }
  return null; // no match yet
}

/* --------------------- Helper endpoints --------------------- */
app.get("/whoami", requireAuth, async (_req, res) => {
  const { games } = await yf.user.games();
  const nhl = (games || []).find((g) => g.code === "nhl");
  if (!nhl) return res.json({ error: "No NHL game found on this account" });
  const { leagues } = await yf.user.game_leagues(nhl.game_key);
  res.json({ leagues: leagues.map((l) => ({ name: l.name, league_key: l.league_key, league_id: l.league_id })) });
});

app.get("/api/config", (_req, res) => {
  res.json({
    lossTolerance: Number(process.env.LOSS_TOLERANCE ?? -0.35),
    gainMin: Number(process.env.GAIN_MIN ?? 0.25),
    imbalanceMax: Number(process.env.IMBALANCE_MAX ?? 1.0),
  });
});

/* ----------------------- Core API ----------------------- */
app.get("/api/league", requireAuth, async (req, res) => {
  const leagueKey = req.session.leagueKey || await resolveLeagueKey(req);
  if (!leagueKey) {
    return res.status(400).json({
      error: "LEAGUE_KEY not set. Provide LEAGUE_ID (preferred) or LEAGUE_NAME in .env, or set LEAGUE_KEY directly. You can also hit /whoami to list leagues."
    });
  }
  const [settings, teams] = await Promise.all([
    yf.league.settings(leagueKey),
    yf.league.teams(leagueKey),
  ]);
  res.json({ leagueKey, settings, teams: teams.teams });
});

app.get("/api/roster/:teamKey", requireAuth, async (req, res) => {
  const roster = await yf.team.roster(req.params.teamKey);
  res.json(roster);
});

app.get("/api/freeagents", requireAuth, async (req, res) => {
  const leagueKey = req.session.leagueKey || await resolveLeagueKey(req);
  if (!leagueKey) return res.status(400).json({ error: "LEAGUE_KEY not set." });
  const fa = await yf.league.players(leagueKey, ["FA"]);
  res.json({ count: fa.count, players: fa.players });
});

app.post("/api/evaluate", requireAuth, async (req, res) => {
  const { teamAKey, teamBKey, sendA = [], sendB = [] } = req.body || {};
  const leagueKey = req.session.leagueKey || await resolveLeagueKey(req);
  if (!leagueKey) return res.status(400).json({ error: "LEAGUE_KEY not set." });

  const [settings, , fa] = await Promise.all([
    yf.league.settings(leagueKey),
    yf.league.teams(leagueKey),
    yf.league.players(leagueKey, ["FA"]),
  ]);

  const startersByPos = computeStartersByPos(settings);
  const cats = buildCategoryListFromSettings(settings);

  const rosterA = await yf.team.roster(teamAKey);
  const rosterB = await yf.team.roster(teamBKey);

  const normalize = (yPlayers) =>
    (yPlayers || []).map((p) => {
      const info = p.player[0];
      const posBlock = p.player[1]?.eligible_positions || [];
      const pos = posBlock.map((x) => x.position);
      const isGoalie = pos.includes("G");
      const statsArr = p.player[1]?.player_points?.stats || p.player[1]?.player_stats?.stats || [];
      const gp = Number(p.player[1]?.player_stats?.coverage_value || 0) || 0;
      const stats = {};
      for (const s of statsArr) stats[s.stat.stat_id] = Number(s.value) || 0;
      return {
        player_key: p.player_key || info.player_id,
        name: info.name?.full || info.name?.first || "Unknown",
        pos, isGoalie, stats, gp,
      };
    });

  const A = normalize(rosterA.roster);
  const B = normalize(rosterB.roster);
  const FA = normalize(fa.players || []);

  const pool = computePerGame([...A, ...B, ...FA]);
  valuePlayers(pool, cats);

  const mapByKey = Object.fromEntries(pool.map((p) => [p.player_key, p]));
  const withValues = (arr) => arr.map((p) => mapByKey[p.player_key] || p);

  const Aall = withValues(A);
  const Ball = withValues(B);
  const FAall = withValues(FA);

  const pickStarters = (players) => {
    const sorted = [...players].sort((a, b) => (b.value || 0) - (a.value || 0));
    const starters = [], bench = [];
    const need = Object.assign({}, startersByPos);
    for (const p of sorted) {
      let benched = true;
      for (const [pos, count] of Object.entries(need)) {
        const eligible = pos === "Util" ? !p.isGoalie : pos === "G" ? p.isGoalie : p.pos?.includes(pos);
        if (count > 0 && eligible) { starters.push(p); need[pos] = count - 1; benched = false; break; }
      }
      if (benched) bench.push(p);
    }
    return { starters, bench };
  };

  const { starters: Astarters, bench: Abench } = pickStarters(Aall);
  const { starters: Bstarters, bench: Bbench } = pickStarters(Ball);

  const byKey = (list) => Object.fromEntries(list.map((p) => [p.player_key, p]));
  const Amap = byKey(Aall), Bmap = byKey(Ball);

  const outgoingA = sendA.map((k) => Amap[k]).filter(Boolean);
  const outgoingB = sendB.map((k) => Bmap[k]).filter(Boolean);

  const removeOutgoing = (arr, outgoing) =>
    arr.filter((p) => !outgoing.some((o) => o.player_key === p.player_key));

  const tiA = tradeImpactForTeam({
    starters: removeOutgoing(Astarters, outgoingA),
    bench: removeOutgoing(Abench, outgoingA),
    incoming: outgoingB,
    freeAgents: FAall,
    startersByPos,
  });

  const tiB = tradeImpactForTeam({
    starters: removeOutgoing(Bstarters, outgoingB),
    bench: removeOutgoing(Bbench, outgoingB),
    incoming: outgoingA,
    freeAgents: FAall,
    startersByPos,
  });

  const v = verdict(Number(tiA), Number(tiB), {
    lossTol: Number(LOSS_TOLERANCE),
    gainMin: Number(GAIN_MIN),
    imbalanceMax: Number(IMBALANCE_MAX),
  });

  res.json({
    leagueKey, teamAKey, teamBKey, sendA, sendB,
    tiA: Number(Number(tiA).toFixed(3)),
    tiB: Number(Number(tiB).toFixed(3)),
    verdict: v,
  });
});

// logout + health
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});
app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => {
  const base = CALLBACK_URL.replace(/\/auth\/callback$/, "");
  console.log(`✅ Server on :${PORT}`);
  console.log(`→ Local:  http://localhost:${PORT}/login`);
  console.log(`→ Public: ${base}/login`);
});
