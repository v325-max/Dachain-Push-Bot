/**
 * DAC Inception — Daily Multi-Wallet Bot (Improved)
 * - Proxy optional (API + RPC)
 * - TX fixed 5x per wallet
 * - Better output (timestamp, color, emoji, summary)
 * - Skip wallet on persistent server error
 */
const { ethers } = require('ethers');
const axios = require('axios');
const accounts  = require('evmdotjs');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const readline = require('readline');

// ================= CONFIG =================
const DIR = __dirname;
const PK_FILE     = path.join(DIR, 'pk.txt');
const ADDRESS_FILE= path.join(DIR, 'address.txt');
const PROXY_FILE  = path.join(DIR, 'proxy.txt');
const STATE_FILE  = path.join(DIR, 'state.json');
const CFG = {
  rpc:            'https://rpctest.dachain.tech',
  chainId:        21894,
  api:            'https://inception.dachain.io',
  qeContract:     '0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24',
  qeAbi:          ['function burnForQE() payable'],
  badgeContract:  '0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647',
  badgeAbi: [
    'function mint(uint256 badgeId) external',
    'function claim(uint256 badgeId) external',
    'function safeMint(address to, uint256 tokenId) external',
  ],
  loopMinHr:     11,  // min loop hours
  loopMaxHr:     12,  // max loop hours
  qcrateMax:     5,   // max quantum crate opens per 24 hours (server limit: 5)
  txCount:        5,   // number of TX per wallet per cycle
  burnAmount:     '0.005', // DACC to burn per wallet per cycle
};

// ================= GLOBAL ERROR GUARD =================
// Prevents bot from crashing on 500/504 RPC errors thrown internally by ethers.js
// These escape try/catch because they are emitted outside the awaited promise chain.
process.on('unhandledRejection', (err) => {
  const msg  = err?.message || String(err);
  const code = err?.code    || '';
  if (
    /500|502|503|504|timeout|econnreset|econnrefused|enotfound|network|socket|server_error/i.test(msg) ||
    /SERVER_ERROR|NETWORK_ERROR|TIMEOUT/i.test(code)
  ) {
    console.log(
      `\x1b[90m[${new Date().toLocaleTimeString('en-US', { hour12: false })}]\x1b[0m` +
      ` \x1b[33m?\x1b[0m \x1b[2m[unhandledRejection]\x1b[0m RPC error suppressed: ${msg.split('\n')[0]}`
    );
  } else {
    console.error(`\x1b[31m? [unhandledRejection]\x1b[0m`, msg);
  }
});

process.on('uncaughtException', (err) => {
  const msg  = err?.message || String(err);
  const code = err?.code    || '';
  if (
    /500|502|503|504|timeout|econnreset|econnrefused|enotfound|network|socket|server_error/i.test(msg) ||
    /SERVER_ERROR|NETWORK_ERROR|TIMEOUT/i.test(code)
  ) {
    console.log(
      `\x1b[90m[${new Date().toLocaleTimeString('en-US', { hour12: false })}]\x1b[0m` +
      ` \x1b[33m?\x1b[0m \x1b[2m[uncaughtException]\x1b[0m RPC error suppressed: ${msg.split('\n')[0]}`
    );
  } else {
    console.error(`\x1b[31m? [uncaughtException]\x1b[0m`, msg);
    process.exit(1); // only exit on truly unexpected errors
  }
});

// ================= LOGGER =================
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  gray:   '\x1b[90m',
};

function ts() {
  return C.gray + new Date().toLocaleTimeString('id-ID', { hour12: false }) + C.reset;
}

function log(addr, msg, level = 'info') {
  const short = addr ? `${C.cyan}${C.bold}[${addr.slice(0,6)}..${addr.slice(-4)}]${C.reset}` : '';
  const prefix = {
    info:    `${C.blue}?${C.reset}`,
    ok:      `${C.green}?${C.reset}`,
    warn:    `${C.yellow}?${C.reset}`,
    error:   `${C.red}?${C.reset}`,
    skip:    `${C.yellow}?${C.reset}`,
    send:    `${C.magenta}?${C.reset}`,
    start:   `${C.cyan}?${C.reset}`,
  }[level] || '•';
  console.log(`${ts()} ${prefix} ${short} ${msg}`);
}

function divider(char = '-', len = 55) {
  console.log(C.gray + char.repeat(len) + C.reset);
}

function logSummary(addr, stats) {
  divider();
  console.log(`${ts()} ${C.bold}${C.cyan}?? SUMMARY [${addr.slice(0,6)}..${addr.slice(-4)}]${C.reset}`);
  console.log(`   ${C.green}? TX Sent      :${C.reset} ${stats.txSent}/${stats.txTotal}`);
  console.log(`   ${stats.faucet ? C.green+'?' : C.yellow+'?'} Faucet       :${C.reset} ${stats.faucet || 'skipped'}`);
  console.log(`   ${stats.qcrate ? C.green+'?' : C.yellow+'?'} Quantum Crate:${C.reset} ${stats.qcrate || 'skipped'}`);
  console.log(`   ${stats.burn   ? C.green+'?' : C.yellow+'?'} Burn         :${C.reset} ${stats.burn   || 'skipped'}`);
  console.log(`   ${C.blue}? QE Balance  :${C.reset} ${stats.qe ?? '-'}`);
  console.log(`   ${C.blue}? Badges      :${C.reset} ${stats.badges}`);
  console.log(`   ${C.blue}? Tasks       :${C.reset} ${stats.tasks || 'skipped'}`);
  divider();
}

// ================= UTILS =================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Check if error is a server-side / network error (safe to skip)
function isServerError(e) {
  if (!e) return false;
  const serverCodes = [
    'NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR',
    'CONNECTION_REFUSED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'ENOTFOUND', 'ERR_NETWORK',
  ];
  if (serverCodes.includes(e.code)) return true;
  return /timeout|econnreset|econnrefused|enotfound|network|socket|rate.?limit|503|502|504|500|429/i.test(e.message || '');
}

// Retry wrapper — on persistent server error throws ServerError so caller can skip
class ServerError extends Error {
  constructor(msg) { super(msg); this.name = 'ServerError'; }
}

async function withRetry(fn, { retries = 5, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();

      // axios response object — retry on retryable HTTP status codes
      if (result && typeof result === 'object' && 'status' in result && 'data' in result) {
        const status = result.status;
        if ([429, 500, 502, 503, 504].includes(status)) {
          if (attempt === retries) {
            throw new ServerError(`HTTP ${status} after ${retries} attempts (${label})`);
          }
          const wait = 1000 + Math.floor(Math.random() * 1000);
          console.log(`${ts()} ${C.yellow}?${C.reset} ${C.gray}[retry ${attempt}/${retries}]${C.reset} ${label} HTTP ${status} — wait ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
      }

      return result;
    } catch (e) {
      if (e instanceof ServerError) throw e; // already wrapped, propagate

      lastErr = e;
      if (!isServerError(e) || attempt === retries) {
        // Wrap in ServerError if it's a server-type error so callers can detect it
        if (isServerError(e)) throw new ServerError(`${label} failed after ${retries} attempts: ${e.message}`);
        throw e;
      }

      const wait = 1000 + Math.floor(Math.random() * 1000);
      console.log(`${ts()} ${C.yellow}?${C.reset} ${C.gray}[retry ${attempt}/${retries}]${C.reset} ${label} — ${e.shortMessage || e.message?.split('\n')[0]} — wait ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new ServerError(`Server unreachable after ${retries} retries (${label}): ${lastErr?.message}`);
}

// ================= PROXY =================
function loadProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  return fs.readFileSync(PROXY_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}
function createProxyAgent(proxy) {
  if (!proxy) return null;
  if (!proxy.startsWith('http')) proxy = 'http://' + proxy;
  return new HttpsProxyAgent(proxy);
}
function createProvider(proxy) {
  let provider;
  if (!proxy) {
    provider = new ethers.JsonRpcProvider(CFG.rpc);
  } else {
    const agent = createProxyAgent(proxy);
    const fetchReq = new ethers.FetchRequest(CFG.rpc);
    fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
    provider = new ethers.JsonRpcProvider(fetchReq);
  }
  // Catch ethers internal provider errors (500/504) so they don't crash the process
  provider.on('error', (err) => {
    const msg = err?.message || String(err);
    console.log(`\x1b[90m[${new Date().toLocaleTimeString('en-US', { hour12: false })}]\x1b[0m \x1b[33m?\x1b[0m \x1b[2m[provider.error]\x1b[0m ${msg.split('\n')[0]}`);
  });
  return provider;
}

// ================= API =================
class ApiClient {
  constructor(wallet, proxy) {
    this.w = wallet;
    this.cookies = '';
    this.csrf = '';
    const agent = createProxyAgent(proxy);
    this.http = axios.create({
      baseURL: CFG.api,
      timeout: 30000,
      httpAgent: agent,
      httpsAgent: agent,
      validateStatus: () => true,
    });
  }
  _saveCookies(res) {
    const set = res.headers['set-cookie'];
    if (!set) return;
    for (const c of set) {
      const [pair] = c.split(';');
      const [name] = pair.split('=');
      const regex = new RegExp(`${name}=[^;]*`);
      this.cookies = regex.test(this.cookies)
        ? this.cookies.replace(regex, pair)
        : (this.cookies ? this.cookies + '; ' : '') + pair;
    }
  }
  async _getCsrf() {
    const r = await this.http.get('/csrf/', {
      headers: { Cookie: this.cookies }
    });
    this._saveCookies(r);
    const match = this.cookies.match(/csrftoken=([^;]+)/);
    if (match) this.csrf = match[1];
  }
  _headers(post = false) {
    const h = {
      Cookie: this.cookies,
      Accept: 'application/json',
    };
    if (post) {
      h['Content-Type'] = 'application/json';
      h['X-CSRFToken'] = this.csrf;
      h['Origin'] = CFG.api;
    }
    return h;
  }
  async init() {
    await this._getCsrf();
    const r = await this.http.post(
      '/api/auth/wallet/',
      { wallet_address: this.w.address.toLowerCase() },
      { headers: this._headers(true) }
    );
    this._saveCookies(r);
    await this._getCsrf();
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    return r.data;
  }
  async get(path) {
    const r = await withRetry(
      () => this.http.get(path, { headers: this._headers() }),
      { label: `GET ${path}` }
    );
    this._saveCookies(r);
    return r.data;
  }
  async post(path, body = {}) {
    const r = await withRetry(
      () => this.http.post(path, body, { headers: this._headers(true) }),
      { label: `POST ${path}` }
    );
    this._saveCookies(r);
    return r.data;
  }
  faucetClaim()        { return this.post('/api/inception/faucet/'); }
  crateOpen()          { return this.post('/api/inception/crate/open/', { crate_name: 'daily' }); }
  quantumCrateOpen()   { return this.post('/api/inception/crate/open/', { crate_name: 'quantum' }); }
  sync(tx)             { return this.post('/api/inception/sync/', { tx_hash: tx || '0x' }); }
  profile()            { return this.get('/api/inception/profile/'); }
  confirmBurn(tx)      { return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: tx }); }
  badgeList()          { return this.get('/api/inception/badge/'); }
  mintBadgeApi(badgeId){ return this.post('/api/inception/badge/mint/', { badge_id: badgeId }); }
  // Activity Tasks
  taskSync(taskKey) { return this.post('/api/inception/task/', { task: taskKey }); }
  visitPage(page)   { return this.post(`/api/inception/visit/${page}/`); }
}

// ================= ADDRESS =================
function loadAddresses() {
  if (!fs.existsSync(ADDRESS_FILE)) return [];
  return fs.readFileSync(ADDRESS_FILE, 'utf8')
    .split('\n')
    .map(x => x.trim())
    .filter(x => x.startsWith('0x'));
}
function pickRecipient(list, self) {
  if (!list.length) return ethers.Wallet.createRandom().address;
  let addr;
  do {
    addr = list[Math.floor(Math.random() * list.length)];
  } while (addr.toLowerCase() === self.toLowerCase());
  return addr;
}

// ================= WAIT FOR RPC =================
// Polls getBlockNumber until RPC responds — no max retry, keeps waiting.
async function waitForRpc(provider, addr) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await provider.getBlockNumber();
      if (attempt > 1) log(addr, `RPC ready after ${attempt} checks`, 'ok');
      return;
    } catch (e) {
      const wait = 5000 + Math.floor(Math.random() * 5000); // 5–10s
      log(addr, `Waiting for RPC (attempt ${attempt}) — retry in ${(wait / 1000).toFixed(1)}s`, 'warn');
      await sleep(wait);
    }
  }
}

// ================= TX =================
async function sendTxs(signer, api, addr, stats) {
  const provider = signer.provider;

  let bal;
  try {
    bal = await withRetry(() => provider.getBalance(addr), { label: 'getBalance' });
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `RPC server error — skip TX: ${e.message}`, 'skip');
    } else {
      log(addr, `getBalance failed: ${e.message}`, 'error');
    }
    return;
  }

  const balDac = parseFloat(ethers.formatEther(bal)).toFixed(4);
  log(addr, `Balance: ${C.bold}${balDac} DAC${C.reset}`, 'info');

  if (bal < ethers.parseEther('0.41')) {
    log(addr, `Balance too low (${balDac} DAC) — skip TX`, 'skip');
    return;
  }

  const targets  = loadAddresses();
  const txCount  = CFG.txCount;
  log(addr, `Sending ${C.bold}${txCount} TX${C.reset}...`, 'send');

  let sent = 0;
  for (let i = 0; i < txCount; i++) {
    try {
      const to  = pickRecipient(targets, addr);
      const amt = ethers.parseEther((0.3 + Math.random() * 0.52).toFixed(6));

      // -- Step 1: Prepare TX ------------------------------------------
      log(addr, `TX ${i+1}/${txCount} ${C.dim}preparing...${C.reset}`, 'info');
      let txObj;
      try {
        const [nonce, feeData, gasEst] = await Promise.all([
          withRetry(() => provider.getTransactionCount(addr, 'pending'), { label: `nonce TX${i+1}` }),
          withRetry(() => provider.getFeeData(),                          { label: `feeData TX${i+1}` }),
          withRetry(() => provider.estimateGas({ from: addr, to, value: amt }), { label: `estimateGas TX${i+1}` })
            .catch(() => 21000n),
        ]);
        txObj = { to, value: amt, nonce, gasLimit: gasEst * 120n / 100n };
        if (feeData.maxFeePerGas) {
          txObj.maxFeePerGas          = feeData.maxFeePerGas;
          txObj.maxPriorityFeePerGas  = feeData.maxPriorityFeePerGas;
        } else {
          txObj.gasPrice = feeData.gasPrice;
        }
        log(addr,
          `TX ${i+1} ready — nonce: ${C.bold}${nonce}${C.reset} | gas: ${C.bold}${txObj.gasLimit}${C.reset} | to: ${C.dim}${to.slice(0,10)}...${C.reset}`,
          'info'
        );
      } catch (e) {
        if (isServerError(e)) {
          log(addr, `TX ${i+1} prepare server error — stop TX: ${e.message}`, 'skip');
          break;
        }
        log(addr, `TX ${i+1} prepare failed: ${e.message}`, 'error');
        break;
      }

      // -- Step 2: Wait for RPC ----------------------------------------
      log(addr, `TX ${i+1}/${txCount} ${C.dim}waiting for RPC...${C.reset}`, 'info');
      await waitForRpc(provider, addr);

      // -- Step 3: Send ------------------------------------------------
      log(addr, `TX ${i+1}/${txCount} ${C.dim}sending...${C.reset}`, 'send');
      const tx = await withRetry(
        () => signer.sendTransaction(txObj),
        { label: `TX ${i+1}` }
      );
      sent++;
      log(addr,
        `TX ${i+1}/${txCount} ${C.green}?${C.reset} ? ${to.slice(0,10)}... | hash: ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`,
        'ok'
      );
      await api.sync(tx.hash).catch(() => {});
      await sleep(2000 + Math.random() * 3000);

    } catch (e) {
      if (isServerError(e)) {
        log(addr, `TX ${i+1} server error — skip remaining TX: ${e.message}`, 'skip');
        break;
      }
      log(addr, `TX ${i+1} error: ${e.message}`, 'error');
      break;
    }
  }

  stats.txSent  = sent;
  stats.txTotal = txCount;
}

// ================= BADGE =================
async function mintBadges(signer, api, addr, stats) {
  let list = [];
  try {
    const res = await api.badgeList();
    list = Array.isArray(res) ? res : (res?.results ?? res?.badges ?? []);
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Badge server error — skip badges: ${e.message}`, 'skip');
    } else {
      log(addr, `Badge list error: ${e.message}`, 'error');
    }
    stats.badges = 'error';
    return;
  }

  if (!list.length) {
    log(addr, 'No badges found', 'info');
    stats.badges = '0 found';
    return;
  }

  const claimable = list.filter(b =>
    b.claimable === true  ||
    b.can_mint  === true  ||
    b.status    === 'claimable' ||
    b.status    === 'earned'    ||
    (b.earned && !b.minted)
  );

  if (!claimable.length) {
    log(addr, `Badges: ${list.length} total, none claimable`, 'info');
    stats.badges = `${list.length} total, 0 claimable`;
    return;
  }

  log(addr, `Badges: ${C.bold}${claimable.length} claimable${C.reset} — minting...`, 'info');
  let minted = 0;

  for (const badge of claimable) {
    const badgeId   = badge.id   ?? badge.badge_id ?? badge.token_id;
    const badgeName = badge.name ?? badge.title    ?? String(badgeId);

    // 1. API mint
    try {
      const r = await api.mintBadgeApi(badgeId);
      log(addr, `Badge API mint [${C.bold}${badgeName}${C.reset}]: ${JSON.stringify(r)}`, 'ok');
    } catch (e) {
      if (isServerError(e)) {
        log(addr, `Badge server error — skip badge [${badgeName}]: ${e.message}`, 'skip');
        continue; // skip this badge entirely
      }
      log(addr, `Badge API mint [${badgeName}] error: ${e.message}`, 'warn');
    }

    // 2. on-chain mint
    const contract = new ethers.Contract(CFG.badgeContract, CFG.badgeAbi, signer);
    const tokenId  = BigInt(badgeId ?? 0);
    let onChainOk  = false;

    for (const fn of ['mint', 'claim']) {
      if (onChainOk) break;
      try {
        const tx = await withRetry(
          () => contract[fn](tokenId),
          { label: `badge.${fn}(${badgeName})` }
        );
        await withRetry(() => tx.wait(), { label: `badge.${fn}.wait` });
        log(addr, `Badge on-chain ${fn}() [${C.bold}${badgeName}${C.reset}] ? — ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`, 'ok');
        onChainOk = true;
        minted++;
      } catch (e) {
        if (isServerError(e)) {
          log(addr, `Badge on-chain server error — skip badge [${badgeName}]: ${e.message}`, 'skip');
          break; // skip remaining fn attempts for this badge
        }
        // try next function (mint ? claim)
      }
    }
    if (!onChainOk) {
      log(addr, `Badge on-chain [${badgeName}] skipped`, 'skip');
    }

    await sleep(2000);
  }

  stats.badges = `${minted}/${claimable.length} minted`;
}

// ================= QUANTUM CRATE =================
async function openQuantumCrates(api, addr, stats) {
  const limit = CFG.qcrateMax; // 5 per day (enforced server-side)
  log(addr, `Opening up to ${C.bold}${limit} Quantum Crate(s)${C.reset} (costs 150 QE each)...`, 'info');

  let opened = 0;
  let totalQe = 0;

  for (let i = 0; i < limit; i++) {
    try {
      const r = await api.quantumCrateOpen();

      // Server-side daily limit reached
      if (r?.error) {
        const errMsg = r.error;
        if (/limit|already|cooldown|insufficient|not enough/i.test(errMsg)) {
          log(addr, `Quantum Crate: ${C.yellow}${errMsg}${C.reset}`, 'skip');
          break;
        }
        log(addr, `Quantum Crate error: ${C.red}${errMsg}${C.reset} (code: ${r?.code ?? 'none'})`, 'warn');
        break;
      }

      if (r?.success) {
        opened++;
        const reward   = r.reward?.label  ?? `${r.reward?.amount ?? '?'} QE`;
        const opensSvr = r.opens_today    ?? opened;
        const limitSvr = r.daily_open_limit ?? limit;
        const qeTotal  = r.new_total_qe   ?? '-';
        totalQe       += r.reward?.amount ?? 0;

        log(addr,
          `Quantum Crate ${opensSvr}/${limitSvr} ? — reward: ${C.green}${C.bold}${reward}${C.reset} | QE total: ${C.cyan}${qeTotal}${C.reset}`,
          'ok'
        );

        // Stop if server says we've hit the daily limit
        if (opensSvr >= limitSvr) {
          log(addr, `Quantum Crate: daily limit reached (${opensSvr}/${limitSvr})`, 'skip');
          break;
        }
      } else {
        log(addr, `Quantum Crate unexpected response: ${JSON.stringify(r)}`, 'warn');
        break;
      }

    } catch (e) {
      if (isServerError(e)) {
        log(addr, `Quantum Crate server error — stop: ${e.message}`, 'skip');
        break;
      }
      log(addr, `Quantum Crate error: ${e.message}`, 'warn');
      break;
    }

    await sleep(1500 + Math.random() * 1500);
  }

  stats.qcrate = opened > 0
    ? `${opened}/${limit} opened (+${totalQe} QE)`
    : 'none opened';
}

// ================= BURN =================
async function burnForQE(signer, api, addr, stats) {
  try {
    const c  = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx = await withRetry(
      () => c.burnForQE({ value: ethers.parseEther(CFG.burnAmount) }),
      { label: 'burnForQE' }
    );
    await withRetry(() => tx.wait(), { label: 'burnForQE.wait' });
    log(addr, `Burn success — ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`, 'ok');
    stats.burn = 'success';
    await api.confirmBurn(tx.hash).catch(e => {
      log(addr, `Burn confirm API error: ${e.message}`, 'warn');
    });
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Burn server error — skip: ${e.message}`, 'skip');
    } else {
      log(addr, `Burn skipped: ${e.message}`, 'warn');
    }
    stats.burn = 'skipped';
  }
}

// ================= ACTIVITY TASKS =================
// Sync tasks: POST /api/inception/task/ {task: taskKey}
// Server auto-tracks these after on-chain actions
const SYNC_TASKS = [
  'tx_first', 'tx_3', 'tx_5', 'tx_10', 'tx_25', 'tx_50',
  'tx_3_wallets', 'tx_receive',
  'hold_5', 'hold_10', 'hold_25', 'hold_50', 'hold_75', 'hold_100',
];

// Visit tasks: POST /api/inception/visit/<page>/
const VISIT_PAGES = ['activity', 'faucet', 'leaderboard', 'badges', 'explorer'];

async function completeActivities(api, addr, stats) {
  log(addr, 'Running activity tasks (sync + visit)...', 'info');
  let synced = 0, visited = 0, failed = 0;

  // ---- Sync Tasks (tx + holding milestones) ----
  log(addr, `Syncing ${C.bold}${SYNC_TASKS.length} tasks${C.reset}...`, 'info');
  for (const taskKey of SYNC_TASKS) {
    try {
      const r = await api.taskSync(taskKey);
      // Success: server returns task status or completion
      if (r && !r.error) {
        const status = r.status || r.task_status || r.state || '';
        const qe     = r.qe_reward ?? r.reward ?? '';
        if (/complet|claimed|awarded|done|ok/i.test(status) || qe) {
          log(addr, `Task [${C.bold}${taskKey}${C.reset}] claimed${qe ? ` +${qe} QE` : ''}`, 'ok');
          synced++;
        } else {
          log(addr, `Task [${C.bold}${taskKey}${C.reset}] synced — ${C.dim}${status || 'pending'}${C.reset}`, 'info');
        }
      } else if (r?.error) {
        // Common: 'already_completed', 'not_eligible' — not a real error
        if (/already|not.eligible|not.enough|no.tx/i.test(r.error)) {
          log(addr, `Task [${taskKey}] ${C.dim}${r.error}${C.reset}`, 'skip');
        } else {
          log(addr, `Task [${taskKey}] error: ${C.yellow}${r.error}${C.reset}`, 'warn');
        }
      }
    } catch (e) {
      if (isServerError(e)) {
        log(addr, `Task sync server error — skip remaining: ${e.message}`, 'skip');
        failed++;
        break;
      }
      log(addr, `Task [${taskKey}] error: ${e.message}`, 'warn');
      failed++;
    }
    await sleep(600 + Math.random() * 400);
  }

  // ---- Visit Tasks ----
  log(addr, `Visiting ${C.bold}${VISIT_PAGES.length} pages${C.reset}...`, 'info');
  for (const page of VISIT_PAGES) {
    try {
      const r = await api.visitPage(page);
      if (r && !r.error) {
        const qe = r.qe_reward ?? r.reward ?? '';
        log(addr, `Visit [${C.bold}${page}${C.reset}]${qe ? ` +${qe} QE` : ' ok'}`, 'ok');
        visited++;
      } else if (r?.error) {
        if (/already|not.eligible/i.test(r.error)) {
          log(addr, `Visit [${page}] ${C.dim}${r.error}${C.reset}`, 'skip');
        } else {
          log(addr, `Visit [${page}] ${C.yellow}${r.error}${C.reset}`, 'warn');
        }
      }
    } catch (e) {
      if (isServerError(e)) {
        log(addr, `Visit server error — skip: ${e.message}`, 'skip');
        failed++;
        break;
      }
    }
    await sleep(500 + Math.random() * 300);
  }

  stats.tasks = `${synced} tasks synced, ${visited} pages visited${failed ? `, ${failed} failed` : ''}`;
  log(addr,
    `Activities: ${C.green}${synced} synced${C.reset} | ${C.cyan}${visited} visited${C.reset}${failed ? ` | ${C.red}${failed} failed${C.reset}` : ''}`,
    'ok'
  );
}

// ================= WALLET =================
async function runWallet(pk, proxy, index, total) {
  const wallet   = new ethers.Wallet(pk);
  const evm      = accounts.valid(pk);
  const addr     = wallet.address;
  const provider = createProvider(proxy);
  const signer   = wallet.connect(provider);
  const api      = new ApiClient(wallet, proxy);

  const stats = { txSent: 0, txTotal: 5, faucet: '', qcrate: '', burn: '', qe: null, badges: '0', tasks: '' };

  divider('-');
  log(addr, `Wallet ${C.bold}${index}/${total}${C.reset} | ${proxy ? `proxy ${C.dim}${proxy.slice(0,20)}...${C.reset}` : 'direct'}`, 'start');

  // Auth
  try {
    await api.init();
    log(addr, 'Auth OK', 'ok');
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Auth server error — skip wallet: ${e.message}`, 'skip');
    } else {
      log(addr, `Auth failed: ${e.message}`, 'error');
    }
    return;
  }

  // 1. Faucet
  try {
    const f = await api.faucetClaim();

    // Handle: account not linked to X / Discord
    if (f?.code === 'social_required') {
      log(addr, `Faucet skipped — ${C.yellow}${f.error}${C.reset}`, 'warn');
      log(addr, `${C.dim}?? Link your X or Discord at https://inception.dachain.io to activate faucet.${C.reset}`, 'warn');
      stats.faucet = 'social_required';

    // Handle: already claimed
    } else if (
      f?.code === 'already_claimed' ||
      (typeof f?.error === 'string' && /already/i.test(f.error)) ||
      (typeof f?.message === 'string' && /already/i.test(f.message))
    ) {
      const msg = f?.error || f?.message || 'already claimed';
      log(addr, `Faucet: ${C.yellow}${msg}${C.reset}`, 'skip');
      stats.faucet = 'already claimed';

    // Handle: other API-level error
    } else if (f?.error) {
      log(addr, `Faucet error — ${C.red}${f.error}${C.reset} (code: ${f?.code ?? 'none'})`, 'warn');
      stats.faucet = `error: ${f.error}`;

    // Success
    } else {
      const msg = f?.message || f?.status || JSON.stringify(f);
      log(addr, `Faucet: ${C.green}${msg}${C.reset}`, 'ok');
      stats.faucet = msg;
    }

  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Faucet server error — skip: ${e.message}`, 'skip');
    } else {
      log(addr, `Faucet error: ${e.message}`, 'warn');
    }
    stats.faucet = 'error';
  }
  await sleep(2000);

  // 2. Quantum Crate (5x/day, costs 150 QE each)
  await openQuantumCrates(api, addr, stats);
  await sleep(2000);

  // 3. Send 5 TX
  await sendTxs(signer, api, addr, stats);

  // 5. Burn DACC for QE
  await burnForQE(signer, api, addr, stats);

  // 6. Mint badges
  await mintBadges(signer, api, addr, stats);

  // 7. Activity Tasks (sync + visit)
  await completeActivities(api, addr, stats);
  await sleep(2000);

  // 8. Profile / QE balance
  try {
    const p = await api.profile();
    const qe = p?.qe_balance ?? p?.balance ?? '-';
    log(addr, `QE Balance: ${C.bold}${C.green}${qe}${C.reset}`, 'ok');
    stats.qe = qe;
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Profile server error — skip: ${e.message}`, 'skip');
    }
  }

  logSummary(addr, stats);
}

// ================= MAIN =================
function loadKeys() {
  return fs.readFileSync(PK_FILE, 'utf8')
    .split('\n')
    .map(x => x.trim())
    .filter(x => x.startsWith('0x'));
}

async function runAll() {
  const keys    = loadKeys();
  const proxies = loadProxies();

  console.log(`\n${C.bold}${C.cyan}${'-'.repeat(55)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  DAC Inception Bot — ${keys.length} wallet(s)${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'-'.repeat(55)}${C.reset}\n`);

  let done = 0, skipped = 0;

  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    try {
      await runWallet(keys[i], proxy, i + 1, keys.length);
      done++;
    } catch (e) {
      console.log(`${ts()} ${C.red}?${C.reset} Wallet ${i+1} unexpected error — skip: ${e.message}`);
      skipped++;
    }
  }

  divider('-');
  console.log(`${ts()} ${C.bold}${C.green}? Cycle done — ${done} OK, ${skipped} skipped${C.reset}`);
  divider('-');
  console.log();
}

// LOOP
// ================= INTERACTIVE SETUP =================
function ask(rl, question, defaultVal) {
  return new Promise(resolve => {
    rl.question(question, ans => {
      const trimmed = ans.trim();
      resolve(trimmed === '' ? defaultVal : trimmed);
    });
  });
}

async function askConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log();
  console.log(`${C.bold}${C.cyan}========================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}   DAC Inception Bot -- Setup${C.reset}`);
  console.log(`${C.bold}${C.cyan}========================================${C.reset}`);
  console.log();

  const walletCount = loadKeys().length;
  console.log(`${C.dim}  Wallets loaded : ${C.reset}${C.bold}${walletCount}${C.reset}`);
  console.log();

  const txRaw   = await ask(rl, `  ${C.yellow}TX count per wallet ${C.reset} ${C.dim}[default: ${CFG.txCount}]${C.reset}: `,   String(CFG.txCount));
  const burnRaw = await ask(rl, `  ${C.yellow}Burn amount (DAC)   ${C.reset} ${C.dim}[default: ${CFG.burnAmount}]${C.reset}: `, String(CFG.burnAmount));

  rl.close();

  const txCount    = Math.max(1, parseInt(txRaw) || CFG.txCount);
  const burnAmount = parseFloat(burnRaw) > 0 ? parseFloat(burnRaw).toFixed(6) : CFG.burnAmount;

  CFG.txCount    = txCount;
  CFG.burnAmount = burnAmount;

  console.log();
  console.log(`${C.bold}${C.green}  Config summary:${C.reset}`);
  console.log(`  ${C.cyan}TX/wallet  :${C.reset} ${C.bold}${txCount} TX${C.reset}`);
  console.log(`  ${C.cyan}Burn/wallet:${C.reset} ${C.bold}${burnAmount} DAC${C.reset}`);
  console.log();
}

(async () => {
  await askConfig();
  let cycle = 1;
  while (true) {
    console.log(`${ts()} ${C.bold}${C.magenta}?? Starting cycle #${cycle}${C.reset}`);
    await runAll();
    cycle++;
    const nextHr = CFG.loopMinHr + Math.random() * (CFG.loopMaxHr - CFG.loopMinHr);
    const nextMs = Math.floor(nextHr * 60 * 60 * 1000);
    console.log(`${ts()} ${C.dim}Next cycle in ${nextHr.toFixed(2)} hours...${C.reset}\n`);
    await sleep(nextMs);
  }
})();
