// ============================================================
//  SOLANA MULTI-WALLET TRACKER — FAST BOT (60s window)
//  Zero credits. No webhook provider. Runs forever for free.
//  + SELL SIGNAL TRACKER — fires when all coordinated wallets exit
// ============================================================

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID          = process.env.CHAT_ID;
const GMGN_API_KEY     = process.env.GMGN_API_KEY;
const SHYFT_API_KEY    = process.env.SHYFT_API_KEY;

const SOL_MINT         = 'So11111111111111111111111111111111111111112';
const WINDOW_SECS      = 60;
const MAX_TOKEN_AGE    = 60;
const STRICT_AGE_CHECK = true;


// ── NOTABLE HOLDERS ─────────────────────────────────────────────────────
const NOTABLE_HOLDER_THRESHOLD = 50_000;

async function fetchTopHolders(mint) {
  const data = await gmgnGet('/v1/token/top_holders', {
    chain: 'sol', address: mint, limit: '20'
  });
  if (!data) return [];
  const holders = Array.isArray(data) ? data
    : (data.holders ?? data.top_holders ?? data.data ?? []);
  return holders;
}

async function fetchWalletValue(walletAddress) {
  const data = await gmgnGet('/v1/wallet/info', {
    chain: 'sol', address: walletAddress
  });
  if (!data) return null;
  const val = parseFloat(
    data.total_value ?? data.usd_value ?? data.portfolio_value ?? 0
  );
  return isNaN(val) ? null : val;
}

async function fetchNotableHolders(mint) {
  try {
    const holders = await fetchTopHolders(mint);
    if (!holders.length) {
      log(`[HOLDERS] No holders returned for ${mint.substring(0, 8)}`);
      return [];
    }
    log(`[HOLDERS] Checking ${holders.length} top holders for ${mint.substring(0, 8)}...`);
    const notable = [];
    for (const holder of holders) {
      const addr = holder.address ?? holder.wallet ?? holder.owner;
      if (!addr) continue;
      if (WALLET_SET.has(addr)) continue;
      await new Promise(r => setTimeout(r, 400));
      const value = await fetchWalletValue(addr);
      if (value === null) continue;
      if (value >= NOTABLE_HOLDER_THRESHOLD) {
        const pct    = holder.percent ?? holder.percentage ?? null;
        const pctStr = pct !== null ? ` (${parseFloat(pct).toFixed(1)}%)` : '';
        const valStr = value >= 1_000_000
          ? `$${(value / 1_000_000).toFixed(1)}M`
          : `$${Math.round(value / 1000)}k`;
        notable.push({ addr, valStr, pctStr });
        log(`[HOLDERS] Notable: ${addr.substring(0, 8)} — ${valStr}${pctStr}`);
      }
    }
    return notable;
  } catch(e) {
    log(`[ERR] fetchNotableHolders: ${e.message}`);
    return [];
  }
}

// ── SIGNAL FILTER ─────────────────────────────────────────────
const SAME_NAME_THRESHOLD = 10;
const DEV_ATH_THRESHOLD   = 1_000_000;

const WSS_PRIMARY  = SHYFT_API_KEY
  ? `wss://rpc.shyft.to?api_key=${SHYFT_API_KEY}`
  : 'wss://api.mainnet-beta.solana.com';
const WSS_FALLBACK = 'wss://api.mainnet-beta.solana.com';
const HTTP_RPC     = SHYFT_API_KEY
  ? `https://rpc.shyft.to?api_key=${SHYFT_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// ── FIRED ALERTS ──────────────────────────────────────────────
const FIRED_FILE = '/tmp/fired_alerts.json';

function loadFiredAlerts() {
  try {
    if (fs.existsSync(FIRED_FILE)) {
      const raw = fs.readFileSync(FIRED_FILE, 'utf8');
      return new Set(JSON.parse(raw));
    }
  } catch(e) { log(`[INIT] Could not load fired alerts: ${e.message}`); }
  return new Set();
}

function saveFiredAlert(mint) {
  firedAlerts.add(mint);
  try { fs.writeFileSync(FIRED_FILE, JSON.stringify([...firedAlerts]), 'utf8'); }
  catch(e) { log(`[WARN] Could not save fired alert: ${e.message}`); }
}

// ── WALLETS ───────────────────────────────────────────────────
const WALLETS = [
  "CzbN6T1gKkKutvuPXcxNmV8FLqzjsDWebWmg9o8e2ZbU", "H8s4GoDcABkvykQSS7mUSHTSKUcxivoULUXgZDkjuoUf",
  "AmNMqM5VbPwtG14gLBdtrqZpQrhSzavLkQPufS8CQ7LB", "AMRsSeU5JpqwQWJGNLMpZzRCZSFEwYQYbMnms3dD4311",
  "2bBRwhGoL4fRZk6g8NnhBZywsF8PdLJnBRfWDCEMogD2", "6EDaVsS6enYgJ81tmhEkiKFcb4HuzPUVFZeom6PHUqN3",
  "Aqje5DsN4u2PHmQxGF9PKfpsDGwQRCBhWeLKHCFhSMXk", "HiSo5kykqDPs3EG14Fk9QY4B5RvkuEs8oJTiqPX3EDAn",
  "FxN3VZ4BosL5urG2yoeQ156JSdmavm9K5fdLxjkPmaMR", "JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT",
  "HyYNVYmnFmi87NsQqWzLJhUTPBKQUfgfhdbBa554nMFF", "GeUnv1jmtviRbR7Gu1JnXSGkUMUgFVBHuEVQVpTaUX1W",
  "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2", "8ZN71XTdVo8yRovnGLmNgW3Tgniw6A4J3JGLvPD686FP",
  "DPNPVvoGdwNBY849ryx2JZzakWuWbDTfSUYr8aNfKLwA", "Hp34goKgAhAYW6sw9iFAZofvDTr3DAhtkSKF1R9bAk2P",
  "95ZCf3jKMHeFYvPXVZW3Ek6AEPDyjebosqnc7eNioVMo", "G7NvZKjoVqBDWciSYtWWgUPB7DA1iJavdvH5jty2FAmM",
  "BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd", "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6",
  "2T5NgDDidkvhJQg8AHDi74uCFwgp25pYFMRZXBaCUNBH", "515vh1DrPuwMATt9Zoq9kP4sJL9fyojA1dHJu4DQpNRp",
  "GpTXmkdvrTajqkzX1fBmC4BUjSboF9dHgfnqPqj8WAc4", "2ezv4U5HmPpkt2xLsKnw1FyyGmjFBeW7c166p99Hw2xB",
  "EaVboaPxFCYanjoNWdkxTbPvt57nhXGu5i6m9m6ZS2kK", "FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke",
  "BAr5csYtpWoNpwhUjixX7ZPHXkUciFZzjBp9uNxZXJPh", "B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC",
  "8HcYptCBAaPFWkmupiSAmysZ6Z8jB7N1c4YhVjhX7zbg", "FFEjC9MHhpQViBPrD2iU6LmV2hEigyhLJaL7MZUZzyD4",
  "FTaSBuVj6w2S7XUa8fw19xrLy57DDr6kZDL6sxDXtvTP", "FSAmbD6jm6SZZQadSJeC1paX3oTtAiY9hTx1UYzVoXqj",
  "G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC", "Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x",
  "5aLY85pyxiuX3fd4RgM3Yc1e3MAL6b7UgaZz6MS3JUfG", "DYAn4XpAkN5mhiXkRB7dGq4Jadnx6XYgu8L5b3WGhbrt",
  "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
  "BCnqsPEtA1TkgednYEebRpkmwFRJDCjMQcKZMMtEdArc", "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",
  "5ZuV8eqkvzYFVEKbLvGBdexL2tFv7E5BCd2HZpjqbdg", "FM1YCKED2KaqB8Uat8aB1nsffR1vezr7s6FAEieXJgke",
  "AV7PjXHL5JXZ1YoYRoN9Dsstg1x2UciBupMCXcJP8gUz", "Dzp1SrZ474xwGp6ZEP6cNKo39u9zeXe1YAuTkyZyv3t4",
  "whamNNP9tHoxLg92yHvJPdYhghEoCg1qYTsh5a2oLbx", "HdKJM6Lvfp9aV9tvEMC8AD4GnsbFgMUkHLoK923Sn1ET",
  "5FqUo9aBjsp7QeeyN6Vi2ZmF2fjS4H5EU7wnAQwPy17z", "7hHmfYYR7L8LsCKk5akjtvVu1BbJRgHGJ2n6s7gbeKG4",
  "CjtqWn4toBbJ1feRZBDhz3TwBjbZm5RpES8rvKWTuNtk", "FAX4qRQdiSj2iWDYvkJ21VieVCXGREtwMhEyAHSJ1aqp",
  "9VXuNqqqzniYYW3fRDeaCtUUtqWsEeWWn5umh3aF9h17", "DAEdBmTPEKM6xkwfzC3d411QUe6coKpkND6UURa4CvHC",
  "iPUp3qkm39ycMGbywWFMUyvaDhiiPGXeWXaDtmHNe6C", "CfkaAru9ArJ2tAStYHvbAyRBJL3EhDzsWYV2KYg9shxB",
  "EeLjBXRELqrcWAXbnj8T4jQPS9Qh7UGWiKxovsJ36pZY", "H5Wh4EDvWQT4mShH746V5VDqxHQkaQZyPWfuhy1PRVBg",
  "GH9yk8vgFvHnAD8JZqXxr3hBN1Lr1mJ9NPzrP5mVqiJe", "7hkd2kdx4bMyuUDgktZvykDh69r8YkkrX4kf1sW2C8T6",
  "8ghYW6ftL5kUemfsoA9X37rz3ZnvyMSZRAx1kt1CxpoS", "GKaJNFDp2W5uCYfNKnTPN63tFXKgXgaDSfnTVfksBeq1",
  "DaKpjVJFxq3y4iZcEu12wzpXGCNBkQE587VNACUj15rT", "C4ARzqpvZ4gR3ta89H5Yz7UyPTpRm22BL5U91e5dHTSf",
  "BSFxyBwsHQsDXULygBpsTu6iUmfHUbCr6j4geZSN6YJG", "9Zu8AigeXgFAajBTni2VWw6Wmz7XxDqHmY5nQwdCWAyY",
  "9dkeTBYaHJzxVgVZqympcHmPeQvHtQv1sArZiZuwmhgp", "AQdBYZNy3BZ1vouGUjA1w9Ay7aq7kH5UQSuh4LQWKotY",
  "HTM87R4mgjDdiF6Yfn8duK9vbDmZxiPCTRbGvm7eCAJY", "8i5U2uNBEuTc4zskYP14zbebDg2RSwrrG8REhEnJb97K",
  "7E9jfxCczubz4FXkkVKzUMHXGwzJxyppC4m7y3ew8ATg", "8v6ztxZwhPBNmA6aGrBzzrt6UBf2fZZfsWqZ9Lt47Kpv",
  "6nU2L7MQVUWjtdKHVpuZA9aind73nd3rXC4YFo8KQCy4", "5zCkbcD74hFPeBHwYdwJLJAoLVgHX45AFeR7RzC8vFiD",
  "8HeDT75s5g4CtCimH5B5nySqCiQhtWii8UnZhxBtFo38", "A8Z1ejQGk45EJibBPJviWnM3UvwKSuYun53nSCkWKM52",
  "D9gQ6RhKEpnobPBUdWY5bPQt2p3zGk3iVz6ChpUi2ArA", "BZC7VEj5Y9Ege3cTRGBZW2zW7pjw3hpiSkcAoYKysvue",
  "FgifQEkRkSSXZjf2cJ4c55BhVts2yrNKzmzBLLyicg8b", "EFaQQTGywnD4CjQQvTugUiyVT4LV9G6MsWqiub8X6unN",
  "HUgpmqL6r4Z4iEZiVuNZ6J6QnAsSZpsL8giVyVtz3QhT", "FaBGrHWjcJ8vKnbgUtsdpZjvF7YAAajtQTWmmEHiKtQr",
  "HYWo71Wk9PNDe5sBaRKazPnVyGnQDiwgXCFKvgAQ1ENp", "bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa",
  // Added wallets
  "7moqFjvm2MwAiMtCZoqYoTAPzRBxxMRT2ddyHThQuWjr", // Smart 15
  "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s", // CHILLHOUSE Dev
  "AvcWA3ngM55sSpjh1FZthmqA7V6BHo4f555a8w3Wv3ij", // Honeypot Dev
  "J7nJ35d8EGU3fHCVCUun56C1MKakdoEQ38CFLHAhWDwP", // Together Dev
  "6ujZxnphRxTqveaQtLAQHFoWz16xhLWZbTijcgZN4fRp", // BadBunny Dev
  "nazikTJezTC3W2fxXE3wzs495PYzXMiq5o7co6YYACA",  // YZY Dev
  "BtMBMPkoNbnLF9Xn552guQq528KKXcsNBNNBre3oaQtr", // Letterbomb(horse)
  "EYfdt8cNFyyTEJKp18dcoVbgUHDnM1SK3bT2uKj9XXHc", // Penguin Dev
  "EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq", // Smart 8
];
const WALLET_SET = new Set(WALLETS);

// ── STATE ─────────────────────────────────────────────────────
let firedAlerts    = loadFiredAlerts();
let activeAlerts   = {};
let devWalletCache = {};
let creationCache  = {};
let skipCache      = {};
let subIdToWallet  = {};
let ws             = null;
let wsReady        = false;
let reconnectDelay = 5000;
let usingFallback  = false;
let pendingSigs    = new Set();

// ── SELL WATCHLIST ────────────────────────────────────────────
// sellWatchlist[tokenMint] = {
//   wallets: Set<walletAddress>,   — wallets that need to sell
//   symbol: string,                — for the alert message
//   signalTime: number,            — unix ts when buy signal fired
//   exited: Set<walletAddress>,    — wallets confirmed fully sold
// }
let sellWatchlist = {};

// ── UNIFIED TOKEN INFO CACHE ──────────────────────────────────
let tokenInfoCache    = {};
let tokenInfoInflight = {};

async function getCachedTokenInfo(mint) {
  if (mint in tokenInfoCache) return tokenInfoCache[mint];
  if (tokenInfoInflight[mint]) return tokenInfoInflight[mint];
  tokenInfoInflight[mint] = fetchTokenInfo(mint).then(info => {
    tokenInfoCache[mint] = info;
    delete tokenInfoInflight[mint];
    setTimeout(() => delete tokenInfoCache[mint], 600000);
    return info;
  });
  return tokenInfoInflight[mint];
}

log(`[INIT] Loaded ${firedAlerts.size} previously fired contracts`);

// Cleanup stale windows every 60s
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const mint of Object.keys(activeAlerts)) {
    if (now - activeAlerts[mint].firstSeenAt > WINDOW_SECS) delete activeAlerts[mint];
  }
}, 60000);

// Cleanup stale sell watchlist entries after 6 hours
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const mint of Object.keys(sellWatchlist)) {
    if (now - sellWatchlist[mint].signalTime > 6 * 3600) {
      log(`[SELL] Watchlist entry for ${mint.substring(0, 8)} expired (6h) — removing`);
      delete sellWatchlist[mint];
    }
  }
}, 5 * 60 * 1000);

// ── HELPERS ───────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Toronto', hour12: true,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  console.log(`[${t}] ${msg}`);
}

function isActiveHours() {
  const now     = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const val     = eastern.getHours() * 60 + eastern.getMinutes();
  return val >= 660 && val < 1080; // 11am–6pm ET
}

// ── HTTP HELPERS ──────────────────────────────────────────────
function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve) => {
    const options = { hostname, path, method: 'GET', headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log(`[HTTP] ${hostname} returned ${res.statusCode} for ${path.substring(0, 60)}`);
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { log(`[HTTP] JSON parse failed for ${hostname}${path.substring(0, 40)}`); resolve(null); }
      });
    });
    req.on('error', (e) => { log(`[HTTP] Error ${hostname}: ${e.message}`); resolve(null); });
    req.setTimeout(15000, () => { req.destroy(); log(`[HTTP] Timeout ${hostname}`); resolve(null); });
    req.end();
  });
}

function httpsPost(url, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// ── SOLANA RPC: getTransaction ────────────────────────────────
async function getTransaction(signature) {
  const result = await httpsPost(HTTP_RPC, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
    ]
  });
  return result?.result ?? null;
}

// ── MINT EXTRACTION ───────────────────────────────────────────
function extractMint(tx) {
  const meta     = tx?.meta;
  const msg      = tx?.transaction?.message;
  if (!meta || !msg) return null;

  const postBals = meta.postTokenBalances ?? [];
  const preBals  = meta.preTokenBalances  ?? [];
  const preOwned = new Set(preBals.map(b => b.mint));

  let mint = postBals.find(b => b.mint && b.mint !== SOL_MINT && !preOwned.has(b.mint))?.mint;
  if (!mint) mint = postBals.find(b => b.mint && b.mint !== SOL_MINT)?.mint;
  return mint ?? null;
}

// ── SELL DETECTION ────────────────────────────────────────────
// Returns the mint address if this tx is a full sell of a watched
// token by the given wallet, otherwise null.
function extractFullSell(tx, trackedWallet) {
  const meta = tx?.meta;
  if (!meta) return null;

  const preBals  = meta.preTokenBalances  ?? [];
  const postBals = meta.postTokenBalances ?? [];

  // Account keys — may be array of strings or array of objects depending on encoding
  const rawKeys     = tx?.transaction?.message?.accountKeys ?? [];
  const accountKeys = rawKeys.map(k => (typeof k === 'string' ? k : (k?.pubkey ?? '')));

  // Helper: resolve owner — use .owner field first, fall back to accountKeys[accountIndex]
  function resolveOwner(balEntry) {
    if (balEntry.owner) return balEntry.owner;
    const idx = balEntry.accountIndex;
    if (idx !== undefined && accountKeys[idx]) return accountKeys[idx];
    return null;
  }

  for (const pre of preBals) {
    if (!pre.mint || pre.mint === SOL_MINT) continue;
    if (!sellWatchlist[pre.mint]) continue;

    const ownerOfPre = resolveOwner(pre);
    if (!ownerOfPre || ownerOfPre !== trackedWallet) continue;

    // Pre-balance must be > 0 (they held something)
    const preAmt = parseFloat(pre.uiTokenAmount?.uiAmountString ?? pre.uiTokenAmount?.amount ?? '0');
    if (preAmt <= 0) continue;

    // Post-balance must be 0 — if entry missing entirely, balance is 0 (token account closed)
    const post    = postBals.find(p => p.mint === pre.mint && resolveOwner(p) === trackedWallet);
    const postAmt = post ? parseFloat(post.uiTokenAmount?.uiAmountString ?? post.uiTokenAmount?.amount ?? '0') : 0;

    if (postAmt === 0) {
      log(`[SELL] Full exit detected: wallet ${trackedWallet.substring(0, 8)} sold all of ${pre.mint.substring(0, 8)}`);
      return pre.mint;
    }
  }

  return null;
}

// ── SELL SIGNAL ───────────────────────────────────────────────
function sendSellSignal(tokenMint, entry) {
  const elapsed = Math.floor(Date.now() / 1000) - entry.signalTime;
  const mins    = Math.floor(elapsed / 60);
  const secs    = elapsed % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const walletCount = entry.wallets.size;

  const signalTime = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });

  sendTelegram(
    `🚨 <b>SELL Signal — All Wallets Exited</b>\n\n` +
    `Token: #${entry.symbol}\n` +
    `Contract: <code>${tokenMint}</code>\n` +
    `Wallets Exited: ${walletCount}/${walletCount}\n` +
    `Time Since Buy Signal: ${elapsedStr}\n` +
    `Signal Time: ${signalTime}\n\n` +
    `<a href="https://gmgn.ai/sol/token/${tokenMint}">GMGN</a>`
  );

  log(`[SELL] 🚨 Sell signal fired for #${entry.symbol} (${tokenMint.substring(0, 8)}) | ${walletCount} wallets exited in ${elapsedStr}`);
}

// ── HANDLE SELL TX ────────────────────────────────────────────
async function handlePotentialSell(trackedWallet, tx) {
  const soldMint = extractFullSell(tx, trackedWallet);
  if (!soldMint) return;

  const entry = sellWatchlist[soldMint];
  if (!entry) return;

  // Only care about wallets we're watching for this token
  if (!entry.wallets.has(trackedWallet)) return;

  // Mark this wallet as exited
  entry.exited.add(trackedWallet);
  const remaining = entry.wallets.size - entry.exited.size;

  log(`[SELL] ${trackedWallet.substring(0, 8)} exited #${entry.symbol} | ${entry.exited.size}/${entry.wallets.size} exited | ${remaining} remaining`);

  // All wallets have fully sold
  if (entry.exited.size >= entry.wallets.size) {
    sendSellSignal(soldMint, entry);
    delete sellWatchlist[soldMint];
  }
}

// ── GMGN ──────────────────────────────────────────────────────
async function gmgnGet(path, params = {}) {
  params.timestamp = Math.floor(Date.now() / 1000).toString();
  params.client_id = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const query   = new URLSearchParams(params).toString();
  const headers = {
    'X-APIKEY':   GMGN_API_KEY,
    'Accept':     'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };
  const parsed = await httpsGet('openapi.gmgn.ai', `${path}?${query}`, headers);
  if (parsed?.code === 0 && parsed?.data) return parsed.data;
  log(`[GMGN] Error ${path}: ${JSON.stringify(parsed)?.substring(0, 100)}`);
  return null;
}

async function fetchTokenInfo(mint) {
  return await gmgnGet('/v1/token/info', { chain: 'sol', address: mint });
}

async function fetchFreshWallets(mint) {
  const data = await gmgnGet('/v1/token/security', { chain: 'sol', address: mint });
  if (!data) return null;
  log(`[GMGN] Security keys: ${Object.keys(data).join(', ')}`);
  return data.fresh_holder_count ?? data.fresh_wallet_count ?? data.fresh_holders ?? data.freshHolder ?? null;
}

// ── DEXSCREENER FETCH HELPER ────────────────────────────────────────────
async function dexFetch(url) {
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await new Promise((resolve) => {
      const req = https.get(url, { headers: reqHeaders }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const rr = https.get(res.headers.location, { headers: reqHeaders }, (res2) => {
            let d = '';
            res2.on('data', c => d += c);
            res2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          });
          rr.on('error', () => resolve(null));
          rr.setTimeout(15000, () => { rr.destroy(); resolve(null); });
          return;
        }
        if (res.statusCode === 429) {
          log(`[Dex] 429 rate limited on attempt ${attempt + 1}`);
          res.resume(); resolve('RATE_LIMITED'); return;
        }
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', (e) => { log(`[Dex] Error: ${e.message}`); resolve(null); });
      req.setTimeout(15000, () => { req.destroy(); log(`[Dex] Timeout`); resolve(null); });
    });
    if (result === 'RATE_LIMITED') {
      const backoff = (attempt + 1) * 5000; // 5s, 10s, 15s
      log(`[Dex] Backing off ${backoff/1000}s...`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    if (result) return result;
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ── SAME-NAME COUNT ────────────────────────────────────────────────────────────
// PRIMARY: direct mint lookup (more reliable, less rate limited than search).
// FALLBACK: symbol search if mint lookup returns no pairs for this chain.
// Returns a number always (0+) — null only if both paths completely fail.
async function fetchSameNameCount(mint, symbol) {
  const nowSecs = Math.floor(Date.now() / 1000);
  const cutoff  = 5 * 3600;

  function countMatches(pairs, sym, excludeMint) {
    return pairs.filter(pair => {
      if ((pair.chainId ?? pair.chain_id) !== 'solana') return false;
      if (pair.baseToken?.symbol?.toUpperCase() !== sym.toUpperCase()) return false;
      if (pair.baseToken?.address === excludeMint) return false;
      const createdAt = pair.pairCreatedAt ?? pair.pair_created_at;
      if (!createdAt) return false;
      const ageSecs = nowSecs - Math.floor(createdAt / 1000);
      return ageSecs >= 0 && ageSecs <= cutoff;
    }).length;
  }

  // ── PATH 1: direct mint lookup (primary) ────────────────────────────
  // Pre-delay to give DexScreener breathing room after GMGN calls
  await new Promise(r => setTimeout(r, 4000));
  log(`[Dex] Fetching pairs for mint ${mint.substring(0, 8)}...`);
  const r1 = await dexFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (r1) {
    const pairs = r1.pairs ?? r1.data ?? [];
    // Resolve symbol from pairs if we don't have it
    const resolvedSymbol = (symbol && symbol !== 'UNKNOWN')
      ? symbol
      : (pairs.find(p => p.chainId === 'solana')?.baseToken?.symbol ?? null);

    if (resolvedSymbol) {
      const count = countMatches(pairs, resolvedSymbol, mint);
      log(`[Dex] Mint lookup: ${resolvedSymbol} — ${count} same-name tokens in last 5h`);
      return count;
    }
    // Pairs exist but no symbol resolved — token too new for DexScreener
    log(`[Dex] Mint lookup returned pairs but no symbol for ${mint.substring(0, 8)} — returning 0`);
    return 0;
  }

  // ── PATH 2: symbol search fallback ───────────────────────────────────
  if (symbol && symbol !== 'UNKNOWN') {
    log(`[Dex] Mint lookup failed — trying symbol search for ${symbol}...`);
    await new Promise(r => setTimeout(r, 3000));
    const r2 = await dexFetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
    if (r2) {
      const pairs = r2.pairs ?? r2.data ?? [];
      const count = countMatches(pairs, symbol, mint);
      log(`[Dex] Symbol search: ${symbol} — ${count} same-name tokens in last 5h`);
      return count;
    }
  }

  log(`[Dex] Both paths failed for ${mint.substring(0, 8)} — returning null`);
  return null;
}


async function getTokenAge(mint) {
  const now = Math.floor(Date.now() / 1000);
  if (skipCache[mint]) return -1;
  if (creationCache[mint]) {
    const age = now - creationCache[mint];
    if (age > MAX_TOKEN_AGE) { skipCache[mint] = true; return -1; }
    return age;
  }
  const info = await getCachedTokenInfo(mint);
  if (!info) return null;
  const createdAt = info.creation_timestamp;
  if (!createdAt) return null;
  creationCache[mint] = createdAt;
  const age = now - createdAt;
  if (age > MAX_TOKEN_AGE) { skipCache[mint] = true; return -1; }
  return age;
}

// ── TELEGRAM ──────────────────────────────────────────────────
function sendTelegram(message) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
  const req  = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const p = JSON.parse(d);
        if (!p.ok) log(`[TG Error] ${p.description}`);
        else log(`[TG] Signal delivered`);
      } catch { log(`[TG Error] Parse failed`); }
    });
  });
  req.on('error', e => log(`[TG ERR] ${e.message}`));
  req.write(body);
  req.end();
}

// ── SIGNAL FILTER ─────────────────────────────────────────────
function shouldFireSignal(tokenMint, symbol, sameNameCount, devWallet, devAthMc) {
  const devIsTracked   = devWallet && devWallet !== 'unknown' && WALLET_SET.has(devWallet);
  const devAthPasses   = devWallet && devWallet !== 'unknown' && devAthMc !== null && devAthMc >= DEV_ATH_THRESHOLD;
  const sameNamePasses = sameNameCount !== null && sameNameCount >= SAME_NAME_THRESHOLD;
  const devPasses      = devAthPasses || devIsTracked;

  // Must have BOTH: same-name count >= 10 AND a strong dev (ATH >= $1M or dev is tracked wallet)
  if (sameNamePasses && devPasses) {
    const devReason = devAthPasses
      ? `dev ATH $${devAthMc.toLocaleString()} >= $${DEV_ATH_THRESHOLD.toLocaleString()}`
      : `dev ${devWallet.substring(0, 8)} is a tracked wallet`;
    log(`[FILTER] ✅ PASS — same-name ${sameNameCount} >= ${SAME_NAME_THRESHOLD} AND ${devReason}`);
    return true;
  }

  // Log why it was suppressed
  const snStr  = sameNameCount !== null ? sameNameCount : '?';
  const athStr = devAthMc !== null ? `$${devAthMc.toLocaleString()}` : 'N/A';
  const devStr = devWallet && devWallet !== 'unknown' ? devWallet.substring(0, 8) : 'unknown';

  if (!sameNamePasses && !devPasses) {
    log(`[FILTER] ❌ SUPPRESSED #${symbol} — same-name: ${snStr} (need >=${SAME_NAME_THRESHOLD}), dev ATH: ${athStr}, dev: ${devStr} (not tracked)`);
  } else if (!sameNamePasses) {
    log(`[FILTER] ❌ SUPPRESSED #${symbol} — same-name: ${snStr} (need >=${SAME_NAME_THRESHOLD}), dev would pass`);
  } else {
    log(`[FILTER] ❌ SUPPRESSED #${symbol} — same-name ${snStr} passes but dev ATH: ${athStr}, dev: ${devStr} (not tracked)`);
  }
  return false;
}

// ── SIGNAL ────────────────────────────────────────────────────
async function buildAndSendSignal(tokenMint, walletCount, elapsed, tokenInfo, coordinatedWallets) {
  try {
    const now = Math.floor(Date.now() / 1000);
    let symbol = 'UNKNOWN', mintTimeStr = 'N/A', ageStr = 'N/A';
    let liquidityStr = 'N/A', marketCapStr = 'N/A';
    let devWallet = null, devAthMc = null, devAth = 'N/A', devAthSymbol = '';
    let freshWalletsFromInfo = null;

    if (tokenInfo) {
      symbol = tokenInfo.symbol ?? 'UNKNOWN';
      const createdAt = tokenInfo.creation_timestamp;
      if (createdAt) {
        mintTimeStr = new Date(createdAt * 1000).toLocaleTimeString('en-US', {
          timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
        });
        const s = now - createdAt;
        ageStr = s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
      }
      const liq = parseFloat(tokenInfo.liquidity);
      if (!isNaN(liq)) liquidityStr = `$${liq.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      let mc = parseFloat(tokenInfo.market_cap ?? tokenInfo.usd_market_cap);
      if (isNaN(mc) || mc === 0) {
        const price  = parseFloat(tokenInfo.price);
        const supply = parseFloat(tokenInfo.circulating_supply ?? tokenInfo.total_supply);
        if (!isNaN(price) && !isNaN(supply) && price > 0 && supply > 0) mc = price * supply;
      }
      if (!isNaN(mc) && mc > 0) marketCapStr = `$${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

      const creatorAddr = tokenInfo.dev?.creator_address;
      if (creatorAddr) devWallet = creatorAddr;

      const athInfo = tokenInfo.dev?.ath_token_info;
      if (athInfo?.ath_mc) {
        const parsed = parseFloat(athInfo.ath_mc);
        if (!isNaN(parsed)) {
          devAthMc     = parsed;
          devAthSymbol = athInfo.symbol ? ` #${athInfo.symbol}` : '';
          devAth       = parsed >= 1_000_000
            ? `$${(parsed / 1_000_000).toFixed(1)}M${devAthSymbol}`
            : `$${parsed.toLocaleString('en-US', { maximumFractionDigits: 0 })}${devAthSymbol}`;
        }
      }

      const fwStat = tokenInfo.wallet_tags_stat?.fresh_wallets;
      if (fwStat !== undefined && fwStat !== null) freshWalletsFromInfo = fwStat;
    }

    // Run sequentially to avoid simultaneous GMGN + DexScreener calls causing 429s
    const freshWalletsFromSecurity = freshWalletsFromInfo === null
      ? await fetchFreshWallets(tokenMint)
      : null;
    const freshWallets  = freshWalletsFromInfo ?? freshWalletsFromSecurity;
    const sameNameCount = await fetchSameNameCount(tokenMint, symbol);

    if (!shouldFireSignal(tokenMint, symbol, sameNameCount, devWallet, devAthMc)) {
      // Signal suppressed — do NOT register sell watchlist
      return;
    }

    // ── REGISTER SELL WATCHLIST ─────────────────────────────────────────────
    // Only reached if shouldFireSignal returned true — safe to register.
    if (coordinatedWallets && coordinatedWallets.size > 0) {
      sellWatchlist[tokenMint] = {
        wallets:    new Set(coordinatedWallets),
        exited:     new Set(),
        symbol:     symbol !== 'UNKNOWN' ? symbol : tokenMint.substring(0, 8),
        signalTime: Math.floor(Date.now() / 1000),
      };
      log(`[SELL] Watching ${coordinatedWallets.size} wallets for exits on #${sellWatchlist[tokenMint].symbol} (${tokenMint.substring(0, 8)})`);
    }

    // ── NOTABLE HOLDERS ─────────────────────────────────────────────────────
    const notableHolders = await fetchNotableHolders(tokenMint);
    let notableLine = '';
    if (notableHolders.length > 0) {
      const lines = notableHolders.map(h =>
        `  • <code>${h.addr}</code> — ${h.valStr}${h.pctStr}`
      );
      notableLine = `\n\n💰 <b>Notable Holders (>$50k wallet)</b>\n` + lines.join('\n');
    }

    const signalTime = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });

    const devWalletLine = devWallet ? `<code>${devWallet}</code>` : 'N/A';

    sendTelegram(
      `⚡ <b>3-Wallet Fast Signal (60s)</b>\n\n` +
      `Token: #${symbol}\n` +
      `Contract: <code>${tokenMint}</code>\n` +
      `Mint Time: ${mintTimeStr}\n` +
      `Token Age: ${ageStr}\n` +
      `Liquidity: ${liquidityStr}\n` +
      `Market Cap: ${marketCapStr}\n` +
      `Same-Name Count (5h): ${sameNameCount !== null ? sameNameCount : '?'}\n` +
      `Fresh Wallets: ${freshWallets !== null ? freshWallets : 'N/A'}\n` +
      `Wallets Coordinated: ${walletCount} within ${elapsed}s\n\n` +
      `Dev Wallet: ${devWalletLine}\n` +
      `Dev ATH: ${devAth}` +
      notableLine +
      `\n\nSignal Time: ${signalTime}\n\n` +
      `<a href="https://gmgn.ai/sol/token/${tokenMint}">GMGN</a>`
    );
    log(`[ALERT] Signal sent for #${symbol} (${tokenMint.substring(0, 8)}) | Dev ATH: ${devAth} | Notable: ${notableHolders.length}`);
  } catch(e) { log(`[ERR] buildAndSendSignal: ${e.message}`); }
}

// ── COORDINATION LOGIC ────────────────────────────────────────
async function handleWalletBuy(trackedWallet, tokenMint) {
  if (firedAlerts.has(tokenMint)) {
    log(`[SKIP] ${tokenMint.substring(0, 8)} already signalled`);
    return;
  }

  if (!devWalletCache[tokenMint]) {
    const devInfo = await getCachedTokenInfo(tokenMint);
    devWalletCache[tokenMint] = devInfo?.dev?.creator_address ?? 'unknown';
    setTimeout(() => delete devWalletCache[tokenMint], 600000);
  }
  if (devWalletCache[tokenMint] && devWalletCache[tokenMint] !== 'unknown' &&
      trackedWallet === devWalletCache[tokenMint]) {
    log(`[SKIP] ${trackedWallet.substring(0, 8)} is the dev — not counting`);
    return;
  }

  const age = await getTokenAge(tokenMint);
  if (age === -1) { log(`[SKIP] ${tokenMint.substring(0, 8)} too old`); return; }
  if (age === null) {
    if (STRICT_AGE_CHECK) { log(`[SKIP] ${tokenMint.substring(0, 8)} age unknown — strict mode rejects`); return; }
    log(`[WARN] Age unknown for ${tokenMint.substring(0, 8)} — allowing`);
  } else {
    log(`[AGE] ${tokenMint.substring(0, 8)} is ${age < 60 ? age+'s' : Math.floor(age/60)+'m '+age%60+'s'} old`);
  }

  const now = Math.floor(Date.now() / 1000);

  if (!activeAlerts[tokenMint]) {
    activeAlerts[tokenMint] = { wallets: new Set(), firstSeenAt: now };
  }

  const entry = activeAlerts[tokenMint];

  if (now - entry.firstSeenAt > WINDOW_SECS) {
    log(`[RESET] ${tokenMint.substring(0, 8)} window expired — resetting`);
    activeAlerts[tokenMint] = { wallets: new Set(), firstSeenAt: now };
  }

  entry.wallets.add(trackedWallet);
  const count = entry.wallets.size;
  log(`[COUNT] ${count}/3 for ${tokenMint.substring(0, 8)} within ${now - entry.firstSeenAt}s`);

  if (count >= 3) {
    const elapsed = now - entry.firstSeenAt;
    const coordinatedWallets = new Set(entry.wallets);
    saveFiredAlert(tokenMint);
    delete activeAlerts[tokenMint];
    const tokenInfo = await getCachedTokenInfo(tokenMint);
    await buildAndSendSignal(tokenMint, count, elapsed, tokenInfo, coordinatedWallets);
  }
}

// ── PROCESS LOG NOTIFICATION ──────────────────────────────────
async function processLogNotification(params) {
  const value = params?.result?.value;
  const subId = params?.subscription;

  if (!value) {
    log(`[DEBUG] No value in notification — raw: ${JSON.stringify(params)?.substring(0, 120)}`);
    return;
  }

  if (value.err !== null && value.err !== undefined) return;

  const signature     = value.signature;
  const trackedWallet = subIdToWallet[subId];

  if (!trackedWallet) return;

  // Sell tracking runs 24/7 — check active sell watches regardless of hour
  const hasSellWatches = Object.keys(sellWatchlist).length > 0;

  // If outside active hours AND no sell watches, nothing to do
  if (!isActiveHours() && !hasSellWatches) return;

  log(`[LOG HIT] wallet ${trackedWallet.substring(0, 8)} | sig ${signature.substring(0, 12)}...`);

  if (pendingSigs.has(signature)) {
    log(`[DEBOUNCE] ${signature.substring(0, 12)} already being processed`);
    return;
  }
  pendingSigs.add(signature);
  setTimeout(() => pendingSigs.delete(signature), 30000);

  let tx = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    tx = await getTransaction(signature);
    if (tx) break;
    log(`[RPC] getTransaction attempt ${attempt + 1} failed, retrying...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!tx) {
    log(`[SKIP] Could not fetch tx ${signature.substring(0, 12)}`);
    return;
  }

  // ── CHECK FOR SELL FIRST — runs 24/7 ──────────────────────────
  if (hasSellWatches) {
    await handlePotentialSell(trackedWallet, tx);
  }

  // ── BUY DETECTION — active hours only ─────────────────────────
  if (!isActiveHours()) return;

  const mint = extractMint(tx);
  if (!mint) {
    log(`[SKIP] No token mint in tx for ${trackedWallet.substring(0, 8)}`);
    return;
  }

  log(`[MINT] ${trackedWallet.substring(0, 8)} bought ${mint.substring(0, 8)}`);
  await handleWalletBuy(trackedWallet, mint);
}

// ── WEBSOCKET ─────────────────────────────────────────────────
let reqIdToWallet = {};

function connect(useUrl) {
  const url = useUrl ?? (usingFallback ? WSS_FALLBACK : WSS_PRIMARY);
  log(`[WS] Connecting to ${usingFallback ? 'FALLBACK' : 'PRIMARY'} endpoint...`);

  ws = new WebSocket(url, { handshakeTimeout: 30000 });
  subIdToWallet = {};
  reqIdToWallet = {};
  wsReady = false;

  ws.on('open', () => {
    log(`[WS] Connected — subscribing to ${WALLETS.length} wallets...`);
    wsReady = true;
    reconnectDelay = 5000;

    WALLETS.forEach((wallet, i) => {
      const reqId = i + 1;
      reqIdToWallet[reqId] = wallet;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: reqId,
        method: 'logsSubscribe',
        params: [
          { mentions: [wallet] },
          { commitment: 'confirmed' }
        ]
      }));
    });

    log(`[WS] All ${WALLETS.length} subscription requests sent`);

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    if (msg.id !== undefined && msg.result !== undefined && typeof msg.result === 'number' && !msg.method) {
      const wallet = reqIdToWallet[msg.id];
      if (wallet) {
        subIdToWallet[msg.result] = wallet;
        const confirmed = Object.keys(subIdToWallet).length;
        if (confirmed % 10 === 0) log(`[WS] ${confirmed}/${WALLETS.length} subscriptions confirmed`);
        if (confirmed === WALLETS.length) log(`[WS] ✅ All ${WALLETS.length} subscriptions active`);
      }
      return;
    }

    if (msg.method === 'logsNotification') {
      const subId  = msg.params?.subscription;
      const wallet = subIdToWallet[subId];
      log(`[WS] logsNotification subId=${subId} mapped=${wallet ? wallet.substring(0,8) : 'UNKNOWN'}`);
      processLogNotification(msg.params).catch(e => log(`[ERR] processLogNotification: ${e.message}`));
    }
  });

  ws.on('error', (e) => {
    log(`[WS] Error: ${e.message}`);
  });

  ws.on('close', (code, reason) => {
    wsReady = false;
    log(`[WS] Disconnected (code: ${code}). Reconnecting in ${reconnectDelay / 1000}s...`);

    if (reconnectDelay >= 30000 && !usingFallback && WSS_PRIMARY !== WSS_FALLBACK) {
      log(`[WS] Switching to fallback endpoint`);
      usingFallback = true;
      reconnectDelay = 5000;
    }

    setTimeout(() => connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });
}

// ── HEALTH CHECK SERVER ───────────────────────────────────────
const server = http.createServer((req, res) => {
  const subCount = Object.keys(subIdToWallet).length;
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(
    `SOLANA FAST TRACKER (60s) — LIVE\n` +
    `WS: ${wsReady ? 'connected' : 'reconnecting'}\n` +
    `Subscriptions: ${subCount}/${WALLETS.length}\n` +
    `Fired alerts: ${firedAlerts.size}\n` +
    `Active windows: ${Object.keys(activeAlerts).length}\n` +
    `Sell watchlist: ${Object.keys(sellWatchlist).length} token(s)\n`
  );
});

server.listen(process.env.PORT || 3000, () => {
  log(`[HTTP] Health server on port ${process.env.PORT || 3000}`);
});

// ── START ─────────────────────────────────────────────────────
log(`[START] Launching FAST tracker | ${WALLETS.length} wallets | 60s window | 60s max age | Active 11am-6pm ET`);
log(`[START] WSS primary: ${WSS_PRIMARY.replace(/api_key=[^&]+/, 'api_key=***')}`);

// ── OUTBOUND IP LOGGER ────────────────────────────────────────
https.get('https://api.ipify.org?format=json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const ip = JSON.parse(d).ip;
      log(`[IP] Outbound IP: ${ip} — add this to GMGN trusted IPs if GMGN calls are failing`);
    } catch { log(`[IP] Could not parse outbound IP response`); }
  });
}).on('error', (e) => log(`[IP] IP check failed: ${e.message}`));

connect();

// ── SELF-PING (keeps Render free tier from sleeping) ──────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;
setInterval(() => {
  if (!RENDER_URL) return;
  try {
    const mod = RENDER_URL.startsWith('https') ? https : http;
    const req = mod.get(RENDER_URL + '/', (res) => {
      log(`[PING] Self-ping OK (${res.statusCode})`);
    });
    req.on('error', (e) => log(`[PING] Self-ping failed: ${e.message}`));
    req.setTimeout(10000, () => req.destroy());
  } catch(e) {
    log(`[PING] Self-ping error: ${e.message}`);
  }
}, 10 * 60 * 1000);
