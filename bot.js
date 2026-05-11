/**
 * DAC Inception — Daily Multi-Wallet Bot (Improved)
 * - Proxy optional (API + RPC)
 * - TX fixed 5x per wallet
 * - Better output (timestamp, color, emoji, summary)
 * - Skip wallet on persistent server error
 * - [ENHANCED] Full mint badge feature: fetch list, API mint, on-chain mint
 *   Supports: mint(), claim(), safeMint() with auto-fallback
 *   Badge status: claimable / earned / mintable / available
 *   Reads badge list from /api/inception/badge/ + /api/inception/badge/list/
 *   On-chain badge contract: 0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647
 */
const { ethers } = require('ethers');
const axios = require('axios');
const accounts  = require('eth_accounts');
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
    'function claimRank(uint8 rankId, bytes calldata signature) external',
    'function hasMinted(address, uint8) external view returns (bool)',
  ],
  loopMinHr:     11,  // min loop hours
  loopMaxHr:     12,  // max loop hours
  qcrateMax:     5,   // max quantum crate opens per 24 hours (server limit: 5)
  txCount:        5,   // number of TX per wallet per cycle
  burnAmount:     '0.005', // DACC to burn per wallet per cycle
  mintBadge:      true, // [ENHANCED] enable/disable badge minting
  txMinAmt:       0.01,  // min DAC per TX send (auto-scaled to balance)
  txMaxAmt:       0.05,  // max DAC per TX send (auto-scaled to balance)
};

// ================= GLOBAL ERROR GUARD =================
process.on('unhandledRejection', (err) => {
  const msg  = err?.message || String(err);
  const code = err?.code    || '';
  if (
    err?.name === 'RateLimitError' ||
    /500|502|503|504|timeout|econnreset|econnrefused|enotfound|network|socket|server_error/i.test(msg) ||
    /SERVER_ERROR|NETWORK_ERROR|TIMEOUT/i.test(code)
  ) {
    console.log(
      `\x1b[90m[${new Date().toLocaleTimeString('en-US', { hour12: false })}]\x1b[0m` +
      ` \x1b[33m⚠\x1b[0m \x1b[2m[unhandledRejection]\x1b[0m RPC error suppressed: ${msg.split('\n')[0]}`
    );
  } else {
    console.error(`\x1b[31m✗ [unhandledRejection]\x1b[0m`, msg);
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
      ` \x1b[33m⚠\x1b[0m \x1b[2m[uncaughtException]\x1b[0m RPC error suppressed: ${msg.split('\n')[0]}`
    );
  } else {
    console.error(`\x1b[31m✗ [uncaughtException]\x1b[0m`, msg);
    process.exit(1);
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
    info:    `${C.blue}ℹ${C.reset}`,
    ok:      `${C.green}✓${C.reset}`,
    warn:    `${C.yellow}⚠${C.reset}`,
    error:   `${C.red}✗${C.reset}`,
    skip:    `${C.yellow}⏭${C.reset}`,
    send:    `${C.magenta}→${C.reset}`,
    start:   `${C.cyan}▶${C.reset}`,
    badge:   `${C.magenta}🏅${C.reset}`,
  }[level] || '•';
  console.log(`${ts()} ${prefix} ${short} ${msg}`);
}

function divider(char = '-', len = 55) {
  console.log(C.gray + char.repeat(len) + C.reset);
}

function logSummary(addr, stats) {
  divider();
  console.log(`${ts()} ${C.bold}${C.cyan}📊 SUMMARY [${addr.slice(0,6)}..${addr.slice(-4)}]${C.reset}`);
  console.log(`   ${C.green}✓ TX Sent       :${C.reset} ${stats.txSent}/${stats.txTotal}`);
  console.log(`   ${stats.faucet ? C.green+'✓' : C.yellow+'⚠'} Faucet        :${C.reset} ${stats.faucet || 'skipped'}`);
  console.log(`   ${stats.qcrate ? C.green+'✓' : C.yellow+'⚠'} Quantum Crate :${C.reset} ${stats.qcrate || 'skipped'}`);
  console.log(`   ${stats.burn   ? C.green+'✓' : C.yellow+'⚠'} Burn          :${C.reset} ${stats.burn   || 'skipped'}`);
  console.log(`   ${C.magenta}🏅 Badges        :${C.reset} ${stats.badges}`);
  console.log(`   ${C.blue}ℹ QE Balance    :${C.reset} ${stats.qe ?? '-'}`);
  console.log(`   ${C.blue}ℹ Tasks         :${C.reset} ${stats.tasks || 'skipped'}`);
  divider();
}

// ================= UTILS =================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isServerError(e) {
  if (!e) return false;
  if (e instanceof RateLimitError) return true;
  const serverCodes = [
    'NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR',
    'CONNECTION_REFUSED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'ENOTFOUND', 'ERR_NETWORK',
  ];
  if (serverCodes.includes(e.code)) return true;
  return /timeout|econnreset|econnrefused|enotfound|network|socket|503|502|504|500/i.test(e.message || '');
}

class ServerError extends Error {
  constructor(msg) { super(msg); this.name = 'ServerError'; }
}
// 429 Too Many Requests — treated as a soft skip, not a crash
class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimitError'; }
}

/**
 * withRetry — wraps any async fn with retry + backoff logic.
 *
 * 429 handling (rate limit):
 *   - Reads Retry-After header if present
 *   - Exponential backoff: base429Wait × 2^(attempt-1), capped at 2 min
 *   - After 2 consecutive 429s → throws RateLimitError (caller skips cleanly)
 *
 * 5xx handling:
 *   - Linear backoff: 2s × attempt
 *   - After `retries` attempts → throws ServerError
 */
async function withRetry(fn, { retries = 5, label = '', base429Wait = 1500 } = {}) {
  let lastErr;
  let consecutive429 = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();

      if (result && typeof result === 'object' && 'status' in result && 'data' in result) {
        const status = result.status;

        // ---- 429 Rate Limit ----
        if (status === 429) {
          consecutive429++;
          // Give up after 2 consecutive 429s — no point hammering a throttled endpoint
          if (consecutive429 >= 2 || attempt === retries) {
            throw new RateLimitError(`Rate limited (429) on ${label}`);
          }
          // Honour Retry-After header if server sends it
          const retryAfterRaw = result.headers?.['retry-after'];
          let wait;
          if (retryAfterRaw) {
            const secs = parseInt(retryAfterRaw, 10);
            wait = isNaN(secs) ? base429Wait : secs * 1000;
          } else {
            // Exponential: 1.5s, 3s, 6s... capped at 4s
            wait = Math.min(base429Wait * Math.pow(2, attempt - 1), 4000);
          }
          console.log(`${ts()} ${C.yellow}⚠${C.reset} ${C.gray}[429 ${attempt}/${retries}]${C.reset} ${label} — rate limited, wait ${(wait/1000).toFixed(0)}s`);
          await sleep(wait);
          continue;
        }

        consecutive429 = 0; // reset on non-429

        // ---- 5xx Server Error ----
        if ([500, 502, 503, 504].includes(status)) {
          if (attempt === retries) {
            throw new ServerError(`HTTP ${status} after ${retries} attempts (${label})`);
          }
          const wait = 2000 * attempt + Math.floor(Math.random() * 2000);
          console.log(`${ts()} ${C.yellow}⚠${C.reset} ${C.gray}[retry ${attempt}/${retries}]${C.reset} ${label} HTTP ${status} — wait ${(wait/1000).toFixed(1)}s`);
          await sleep(wait);
          continue;
        }
      }

      return result;

    } catch (e) {
      if (e instanceof RateLimitError || e instanceof ServerError) throw e;
      lastErr = e;
      if (!isServerError(e) || attempt === retries) {
        if (isServerError(e)) throw new ServerError(`${label} failed after ${retries} attempts: ${e.message}`);
        throw e;
      }
      const wait = 2000 * attempt + Math.floor(Math.random() * 1000);
      console.log(`${ts()} ${C.yellow}⚠${C.reset} ${C.gray}[retry ${attempt}/${retries}]${C.reset} ${label} — ${e.shortMessage || e.message?.split('\n')[0]} — wait ${(wait/1000).toFixed(1)}s`);
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
  provider.on('error', (err) => {
    const msg = err?.message || String(err);
    console.log(`\x1b[90m[${new Date().toLocaleTimeString('en-US', { hour12: false })}]\x1b[0m \x1b[33m⚠\x1b[0m \x1b[2m[provider.error]\x1b[0m ${msg.split('\n')[0]}`);
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
      h['Referer'] = `${CFG.api}/badges`;
    }
    return h;
  }
  async init() {
    // Step 1: Get CSRF
    await this._getCsrf();
    const walletAddr = this.w.address.toLowerCase();

    // Step 2: Try to get a nonce to sign (SIWE pattern)
    // Try multiple nonce endpoints
    let nonce = null;
    const nonceEndpoints = [
      `/api/inception/auth/nonce/?wallet=${walletAddr}`,
      `/api/inception/auth/nonce/`,
      `/api/auth/nonce/?wallet=${walletAddr}`,
    ];
    for (const ep of nonceEndpoints) {
      try {
        const nr = await this.http.get(ep, { headers: this._headers() });
        this._saveCookies(nr);
        if (nr.status === 200 && (nr.data?.nonce || nr.data?.message)) {
          nonce = nr.data.nonce ?? nr.data.message;
          break;
        }
      } catch (_) {}
    }

    // Step 3: Auth — try endpoints in order with/without signature
    const authAttempts = [
      // With signature (SIWE)
      ...(nonce ? [async () => {
        const sig = await this.w.signMessage(nonce);
        return this.http.post(
          '/api/inception/auth/wallet/',
          { wallet_address: walletAddr, signature: sig, message: nonce },
          { headers: this._headers(true) }
        );
      }] : []),
      // Original address-only endpoint (no signature)
      async () => this.http.post(
        '/api/auth/wallet/',
        { wallet_address: walletAddr },
        { headers: this._headers(true) }
      ),
      // Inception-namespaced address-only
      async () => this.http.post(
        '/api/inception/auth/wallet/',
        { wallet_address: walletAddr },
        { headers: this._headers(true) }
      ),
      // Minimal fallback
      async () => this.http.post(
        '/api/inception/auth/',
        { wallet_address: walletAddr },
        { headers: this._headers(true) }
      ),
    ];

    let lastStatus = null;
    for (const attempt of authAttempts) {
      try {
        const r = await attempt();
        this._saveCookies(r);
        await this._getCsrf();
        lastStatus = r.status;
        // Accept 200 or 201
        if (r.status === 200 || r.status === 201) {
          // Verify session actually works by checking a protected endpoint
          try {
            const check = await this.http.get('/api/inception/profile/', {
              headers: this._headers()
            });
            this._saveCookies(check);
            // If profile returns 200 or 403 (forbidden but authenticated), session is good
            if (check.status !== 401 && check.status !== 403 && !check.data?.detail?.toLowerCase().includes('not authenticated')) {
              return r.data; // Auth confirmed working
            }
            // 401 = session didn't stick, try next endpoint
          } catch (_) {
            // Profile check failed but auth might still work — proceed
            return r.data;
          }
        }
        // 404 means endpoint doesn't exist — try next
        if (r.status === 404) continue;
        // Other non-200 — might still work if it's a DAC-specific pattern
        if (r.status !== 200) continue;
      } catch (e) {
        if (isServerError(e)) throw e;
        continue;
      }
    }

    throw new Error(`Auth failed — all endpoints tried (last status: ${lastStatus})`);
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

  // ---- BADGE API (Enhanced) ----
  // ---- Badge API ----
  async badgeList() {
    // Badge catalog = all possible badges (not user-specific)
    // User's earned badges come from profile() → .badges[]
    // Mintable on-chain = rank badges with empty nft_tx_hash
    try {
      const r = await withRetry(
        () => this.http.get('/api/inception/badges/catalog/', { headers: this._headers() }),
        { label: 'GET /api/inception/badges/catalog/', retries: 2 }
      );
      this._saveCookies(r);
      if (r.status === 200 && Array.isArray(r.data?.badges)) {
        return { catalog: r.data.badges, endpoint: '/api/inception/badges/catalog/' };
      }
    } catch (_) {}
    return { catalog: [], endpoint: null };
  }

  // Get claim signature for rank badge NFT mint
  // POST /api/inception/nft/claim-signature/ {rank_key} → {signature, rank_id}
  claimSignature(rankKey) {
    return this.post('/api/inception/nft/claim-signature/', { rank_key: rankKey });
  }

  // Confirm on-chain mint to API
  confirmMint(rankKey, txHash) {
    return this.post('/api/inception/nft/confirm-mint/', { rank_key: rankKey, tx_hash: txHash });
  }

  // Activity badge (non-rank) — POST /api/inception/claim-badge/
  claimActivityBadge() {
    return this.post('/api/inception/claim-badge/');
  }

  // Activity Tasks
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
async function waitForRpc(provider, addr) {
  const MAX_ATTEMPTS = 6; // max ~45s total wait then skip
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      await provider.getBlockNumber();
      if (attempt > 1) log(addr, `RPC ready after ${attempt} checks`, 'ok');
      return true;
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) {
        log(addr, `RPC not responding after ${MAX_ATTEMPTS} attempts — skip`, 'skip');
        return false;
      }
      const wait = 5000 + Math.floor(Math.random() * 3000);
      log(addr, `Waiting for RPC (${attempt}/${MAX_ATTEMPTS}) — retry in ${(wait/1000).toFixed(1)}s`, 'warn');
      await sleep(wait);
    }
  }
  return false;
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

  // Need at least: (txCount * txMinAmt) + burnAmount + gas buffer (0.01 DAC)
  const minRequired = (CFG.txCount * CFG.txMinAmt) + parseFloat(CFG.burnAmount) + 0.01;
  if (parseFloat(balDac) < minRequired) {
    log(addr, `Balance too low (${balDac} DAC, need ~${minRequired.toFixed(4)}) — skip TX`, 'skip');
    return;
  }

  const targets  = loadAddresses();
  const txCount  = CFG.txCount;
  log(addr, `Sending ${C.bold}${txCount} TX${C.reset}...`, 'send');

  let sent = 0;
  for (let i = 0; i < txCount; i++) {
    try {
      const to  = pickRecipient(targets, addr);
      // Scale TX amount to balance: use at most (balance / txCount / 3) per TX, capped by config
      const balFloat   = parseFloat(ethers.formatEther(bal));
      const safeMax    = Math.min(CFG.txMaxAmt, balFloat / (CFG.txCount * 3));
      const safeMin    = Math.min(CFG.txMinAmt, safeMax * 0.8);
      const txAmtDac   = (safeMin + Math.random() * (safeMax - safeMin)).toFixed(6);
      const amt = ethers.parseEther(txAmtDac);

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

      log(addr, `TX ${i+1}/${txCount} ${C.dim}waiting for RPC...${C.reset}`, 'info');
      const rpcOk = await waitForRpc(provider, addr);
      if (!rpcOk) {
        log(addr, `TX ${i+1} skipped — RPC unavailable`, 'skip');
        break;
      }

      log(addr, `TX ${i+1}/${txCount} ${C.dim}sending...${C.reset}`, 'send');
      const tx = await withRetry(
        () => signer.sendTransaction(txObj),
        { label: `TX ${i+1}` }
      );
      sent++;
      log(addr,
        `TX ${i+1}/${txCount} ${C.green}✓${C.reset} → ${to.slice(0,10)}... | hash: ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`,
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

// ================= BADGE MINT (Rewritten — correct flow) =================
/**
 * Badge mint flow (from JS bundle reverse engineering):
 *   Source of truth  : profile.badges[] — already-earned badges
 *   Mintable on-chain: badge__key.startsWith('rank_') && nft_tx_hash === ''
 *   Step 1: POST /api/inception/nft/claim-signature/ {rank_key} → {signature, rank_id}
 *   Step 2: contract.claimRank(uint8 rank_id, bytes "0x"+signature)
 *   Step 3: POST /api/inception/nft/confirm-mint/ {rank_key, tx_hash}
 *
 * Contract: 0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647
 * ABI     : claimRank(uint8 rankId, bytes signature)
 *           hasMinted(address, uint8) view returns (bool)
 */
async function mintBadges(signer, api, addr, profileData, stats) {
  if (!CFG.mintBadge) {
    stats.badges = 'disabled';
    return;
  }

  // Use profile badges (already fetched in runWallet)
  const earnedBadges = profileData?.badges ?? [];

  if (!earnedBadges.length) {
    log(addr, `🏅 No badges in profile`, 'info');
    stats.badges = '0 earned';
    return;
  }

  // Mintable = rank badges earned but not yet minted on-chain (nft_tx_hash empty)
  const mintable = earnedBadges.filter(b =>
    (b.badge__key ?? '').startsWith('rank_') && !b.nft_tx_hash
  );
  const alreadyMinted = earnedBadges.filter(b =>
    (b.badge__key ?? '').startsWith('rank_') && b.nft_tx_hash
  );
  const nonRank = earnedBadges.filter(b => !(b.badge__key ?? '').startsWith('rank_'));

  log(addr,
    `🏅 Badges: ${C.bold}${earnedBadges.length} earned${C.reset} | ` +
    `${C.green}${C.bold}${mintable.length} rank unminted${C.reset} | ` +
    `${C.dim}${alreadyMinted.length} rank minted | ${nonRank.length} non-rank${C.reset}`,
    'badge'
  );

  if (!mintable.length) {
    stats.badges = `${alreadyMinted.length} already minted, 0 pending`;
    return;
  }

  const contract = new ethers.Contract(CFG.badgeContract, CFG.badgeAbi, signer);
  let minted = 0;
  let skipped = 0;

  for (const badge of mintable) {
    const rankKey  = badge.badge__key;
    const badgeName = badge.badge__name ?? rankKey;
    const qeReward  = badge.badge__qe_reward ?? '';

    log(addr,
      `🏅 Minting [${C.bold}${C.magenta}${badgeName}${C.reset}]` +
      `${qeReward ? ` ${C.green}+${qeReward} QE${C.reset}` : ''} ${C.dim}(${rankKey})${C.reset}`,
      'badge'
    );

    // ---- Step 1: Get claim signature from API ----
    let signature, rank_id;
    try {
      const sigRes = await withRetry(
        () => api.claimSignature(rankKey),
        { label: `claimSignature(${rankKey})` }
      );
      signature = sigRes?.signature;
      rank_id   = sigRes?.rank_id ?? sigRes?.rankId;

      if (!signature || rank_id === undefined || rank_id === null) {
        const errMsg = sigRes?.error ?? sigRes?.message ?? JSON.stringify(sigRes);
        if (/already.minted|already.claimed/i.test(errMsg)) {
          log(addr, `  [${badgeName}]: ${C.dim}already minted on-chain${C.reset}`, 'skip');
          skipped++;
          continue;
        }
        log(addr, `  [${badgeName}] claim-signature: ${C.yellow}${errMsg.slice(0,100)}${C.reset}`, 'warn');
        skipped++;
        continue;
      }

      log(addr, `  Got signature for [${badgeName}] rank_id=${rank_id}`, 'info');

    } catch (e) {
      if (e instanceof RateLimitError) {
        log(addr, `  [${badgeName}] rate limited — skip`, 'skip');
        skipped++;
        continue;
      }
      if (isServerError(e)) {
        log(addr, `  [${badgeName}] API server error — skip: ${e.message}`, 'skip');
        skipped++;
        continue;
      }
      const msg = e.message ?? '';
      if (/already.minted|already.claimed/i.test(msg)) {
        log(addr, `  [${badgeName}]: ${C.dim}already minted${C.reset}`, 'skip');
        skipped++;
        continue;
      }
      log(addr, `  [${badgeName}] claim-signature error: ${C.yellow}${msg.slice(0,80)}${C.reset}`, 'warn');
      skipped++;
      continue;
    }

    await sleep(500);

    // ---- Step 2: On-chain claimRank(uint8, bytes) ----
    let txHash = null;
    try {
      const sigBytes  = signature.startsWith('0x') ? signature : `0x${signature}`;
      const rankIdNum = Number(rank_id); // ethers uint8 needs a JS number, not string
      if (isNaN(rankIdNum) || rankIdNum < 0 || rankIdNum > 255) {
        log(addr, `  [${badgeName}] invalid rank_id=${rank_id} — skip`, 'warn');
        skipped++;
        continue;
      }

      // Dry-run: estimate gas first to catch revert before broadcasting
      log(addr, `  Estimating gas for claimRank(${rankIdNum}) [${C.dim}${badgeName}${C.reset}]...`, 'info');
      try {
        await contract.claimRank.estimateGas(rankIdNum, sigBytes);
      } catch (estErr) {
        const msg = (estErr?.message ?? estErr?.reason ?? String(estErr)).toLowerCase();
        if (/already.minted|alreadyminted|already.claimed|duplicate|token.*exist/i.test(msg)) {
          log(addr, `  [${badgeName}]: ${C.dim}already minted (gas estimate)${C.reset}`, 'skip');
          skipped++;
          // Confirm to API in case it wasn't recorded
          await api.confirmMint(rankKey, '0x').catch(() => {});
          continue;
        }
        // "could not coalesce" or other unreadable RPC errors — still try to send
        if (/coalesce|unparseable|unknown.*revert|cannot.*estimate/i.test(msg)) {
          log(addr, `  [${badgeName}] gas estimate unclear (${msg.slice(0,60)}) — attempting send anyway`, 'warn');
        } else {
          // Real revert (signature invalid, not eligible, etc.)
          log(addr, `  [${badgeName}] gas estimate reverted: ${C.yellow}${msg.slice(0,100)}${C.reset}`, 'warn');
          skipped++;
          continue;
        }
      }

      log(addr, `  On-chain claimRank(${rankIdNum}, sig) [${C.dim}${badgeName}${C.reset}]...`, 'info');

      // Do NOT wrap in withRetry — "coalesce" errors have UNKNOWN_ERROR code
      // which would cause infinite retries. Handle directly instead.
      let tx;
      try {
        tx = await contract.claimRank(rankIdNum, sigBytes);
      } catch (sendErr) {
        const rawMsg = (sendErr?.message ?? sendErr?.reason ?? String(sendErr)).toLowerCase();
        if (/already.minted|alreadyminted|token.*exist|already.claimed/i.test(rawMsg)) {
          log(addr, `  [${badgeName}]: ${C.dim}already minted${C.reset}`, 'skip');
          skipped++;
          await api.confirmMint(rankKey, '0x').catch(() => {});
          continue;
        }
        if (/coalesce|unparseable|unknown.*error|server_error/i.test(rawMsg) ||
            sendErr?.code === 'UNKNOWN_ERROR' || sendErr?.code === 'SERVER_ERROR') {
          // RPC returned unreadable error — check actual on-chain state
          log(addr, `  [${badgeName}] RPC error (${sendErr?.code ?? 'UNKNOWN'}) — checking hasMinted...`, 'warn');
          try {
            const done = await contract.hasMinted(addr, rankIdNum);
            if (done) {
              log(addr, `  [${badgeName}] confirmed minted on-chain ✓`, 'ok');
              minted++;
              await api.confirmMint(rankKey, '0x').catch(() => {});
            } else {
              log(addr, `  [${badgeName}] not minted yet + RPC error — skip`, 'warn');
              skipped++;
            }
          } catch (_) {
            log(addr, `  [${badgeName}] hasMinted check failed — skip`, 'warn');
            skipped++;
          }
          continue;
        }
        // Any other send error
        log(addr, `  [${badgeName}] send failed: ${C.yellow}${rawMsg.slice(0,100)}${C.reset}`, 'warn');
        skipped++;
        continue;
      }

      log(addr, `  Waiting confirm... ${C.dim}${tx.hash.slice(0,18)}...${C.reset}`, 'info');
      try {
        await tx.wait();
      } catch (waitErr) {
        // tx was sent but wait() failed — it may have confirmed anyway
        const hash = tx.hash;
        log(addr, `  [${badgeName}] wait() error (${waitErr?.code}) — tx may still confirm: ${C.dim}${hash}${C.reset}`, 'warn');
        txHash = hash;
        minted++;
        await api.confirmMint(rankKey, hash).catch(() => {});
        continue;
      }

      txHash = tx.hash;
      minted++;
      log(addr,
        `  ${C.green}✓${C.reset} [${C.bold}${badgeName}${C.reset}] minted — ${C.dim}${txHash}${C.reset}`,
        'ok'
      );

    } catch (e) {
      const msg = (e?.message ?? e?.reason ?? String(e)).toLowerCase();
      if (isServerError(e)) {
        log(addr, `  [${badgeName}] on-chain server error — skip: ${e.message}`, 'skip');
        skipped++;
        continue;
      }
      if (/already.minted|alreadyminted|token.*exist|already.claimed/i.test(msg)) {
        log(addr, `  [${badgeName}]: ${C.dim}already minted on-chain${C.reset}`, 'skip');
        skipped++;
        // Still confirm to API
      } else if (/coalesce|unparseable|unknown.*error/i.test(msg)) {
        // RPC returned unreadable error — check if minted by querying contract
        log(addr, `  [${badgeName}] RPC error unreadable — checking on-chain status...`, 'warn');
        try {
          const rankIdNum2 = Number(rank_id);
          const alreadyDone = await contract.hasMinted(addr, rankIdNum2);
          if (alreadyDone) {
            log(addr, `  [${badgeName}]: ${C.dim}confirmed already minted on-chain${C.reset}`, 'skip');
            skipped++;
          } else {
            log(addr, `  [${badgeName}] not minted yet but RPC error — skip`, 'warn');
            skipped++;
          }
        } catch (_) {
          log(addr, `  [${badgeName}] could not verify on-chain status — skip`, 'warn');
          skipped++;
        }
        continue;
      } else {
        log(addr, `  [${badgeName}] claimRank failed: ${C.yellow}${msg.slice(0,100)}${C.reset}`, 'warn');
        skipped++;
        continue;
      }
    }

    // ---- Step 3: Confirm mint to API ----
    if (txHash || skipped) {
      try {
        await api.confirmMint(rankKey, txHash ?? '0x');
        log(addr, `  Confirmed to API [${badgeName}]`, 'ok');
      } catch (_) { /* non-critical */ }
    }

    await sleep(1500);
  }

  stats.badges = `${minted}/${mintable.length} minted` +
    (skipped ? ` (${skipped} skipped)` : '') +
    ` | ${alreadyMinted.length} already done`;

  log(addr,
    `🏅 Done: ${C.green}${C.bold}${minted}/${mintable.length}${C.reset} minted` +
    (skipped ? ` | ${C.yellow}${skipped} skipped${C.reset}` : '') +
    ` | ${C.dim}${alreadyMinted.length} already on-chain${C.reset}`,
    minted > 0 ? 'ok' : 'info'
  );
}
  


// ================= QUANTUM CRATE =================
async function openQuantumCrates(api, addr, stats) {
  const limit = CFG.qcrateMax;
  log(addr, `Opening up to ${C.bold}${limit} Quantum Crate(s)${C.reset} (costs 150 QE each)...`, 'info');

  let opened = 0;
  let totalQe = 0;

  for (let i = 0; i < limit; i++) {
    try {
      const r = await api.quantumCrateOpen();

      if (r?.error) {
        const errMsg = r.error;
        if (/limit|already|cooldown|insufficient|not enough/i.test(errMsg)) {
          // Try to show reset time from error response
          const resetRaw = r?.reset_time ?? r?.next_reset ?? r?.next_open ?? r?.available_at;
          let skipMsg = errMsg;
          if (resetRaw) {
            try {
              const next = new Date(resetRaw);
              const diffMs = next - new Date();
              if (diffMs > 0) {
                const h = Math.floor(diffMs / 3600000);
                const m = Math.floor((diffMs % 3600000) / 60000);
                skipMsg += ` — resets in ${h}h ${m}m`;
              }
            } catch (_) {}
          }
          log(addr, `Quantum Crate: ${C.yellow}${skipMsg}${C.reset}`, 'skip');
          break;
        }
        if (/not.authenticated|unauthorized|login.required/i.test(errMsg)) {
          log(addr, `Quantum Crate: ${C.yellow}session not authenticated${C.reset}`, 'skip');
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
          `Quantum Crate ${opensSvr}/${limitSvr} ✓ — reward: ${C.green}${C.bold}${reward}${C.reset} | QE total: ${C.cyan}${qeTotal}${C.reset}`,
          'ok'
        );

        if (opensSvr >= limitSvr) {
          // Try to show crate reset time
          const resetRaw = r?.reset_time ?? r?.next_reset ?? r?.cooldown_end
            ?? r?.available_at ?? r?.next_open_time;
          let resetMsg = `daily limit reached (${opensSvr}/${limitSvr})`;
          if (resetRaw) {
            try {
              const next = new Date(resetRaw);
              const diffMs = next - new Date();
              if (diffMs > 0) {
                const h = Math.floor(diffMs / 3600000);
                const m = Math.floor((diffMs % 3600000) / 60000);
                resetMsg += ` — resets in ${h}h ${m}m`;
              }
            } catch (_) {}
          } else {
            // Fetch crate status for reset time
            try {
              const cs = await api.crateStatus();
              const nt = cs?.reset_time ?? cs?.next_reset ?? cs?.quantum?.reset_time
                ?? cs?.crate?.next_open ?? cs?.next_open_time;
              if (nt) {
                const next = new Date(nt);
                const diffMs = next - new Date();
                if (diffMs > 0) {
                  const h = Math.floor(diffMs / 3600000);
                  const m = Math.floor((diffMs % 3600000) / 60000);
                  resetMsg += ` — resets in ${h}h ${m}m`;
                }
              }
            } catch (_) {}
          }
          log(addr, `Quantum Crate: ${C.yellow}${resetMsg}${C.reset}`, 'skip');
          break;
        }
      } else {
        log(addr, `Quantum Crate unexpected response: ${JSON.stringify(r)}`, 'warn');
        break;
      }

    } catch (e) {
      if (e instanceof RateLimitError) {
        log(addr, `Quantum Crate: ${C.yellow}rate limited (429) — skip${C.reset}`, 'skip');
        break;
      }
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
const VISIT_PAGES = ['activity', 'faucet', 'leaderboard', 'badges', 'explorer'];

async function completeActivities(api, addr, stats) {
  log(addr, 'Running activity tasks (visit pages)...', 'info');
  let visited = 0, failed = 0;

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

  stats.tasks = `${visited} pages visited${failed ? `, ${failed} failed` : ''}`;
  log(addr,
    `Activities: ${C.cyan}${visited} pages visited${C.reset}${failed ? ` | ${C.red}${failed} failed${C.reset}` : ''}`,
    'ok'
  );
}

// ================= WALLET =================
async function runWallet(pk, proxy, index, total) {
  const wallet   = new ethers.Wallet(pk);
  const account  = await accounts.run(pk);
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

    if (f?.code === 'social_required') {
      log(addr, `Faucet skipped — ${C.yellow}${f.error}${C.reset}`, 'warn');
      log(addr, `${C.dim}💡 Link your X or Discord at https://inception.dachain.io to activate faucet.${C.reset}`, 'warn');
      stats.faucet = 'social_required';

    } else if (
      f?.code === 'already_claimed' ||
      (typeof f?.error === 'string' && /already/i.test(f.error)) ||
      (typeof f?.message === 'string' && /already/i.test(f.message))
    ) {
      // Try to show when faucet resets
      const nextTime = f?.next_claim_time ?? f?.next_claim ?? f?.reset_time
        ?? f?.cooldown_end ?? f?.available_at ?? f?.next_available;
      let timerMsg = 'already claimed';
      if (nextTime) {
        try {
          const next = new Date(nextTime);
          const now  = new Date();
          const diffMs = next - now;
          if (diffMs > 0) {
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            timerMsg = `already claimed — next in ${h}h ${m}m (${next.toLocaleTimeString('id-ID', {hour12:false})})`;
          } else {
            timerMsg = 'already claimed (reset soon)';
          }
        } catch (_) {
          timerMsg = `already claimed — next: ${nextTime}`;
        }
      } else {
        // Fetch faucet status for timer if not in response
        try {
          const status = await api.faucetStatus();
          const nt = status?.next_claim_time ?? status?.next_claim ?? status?.faucet_cooldown
            ?? status?.faucet?.next_claim ?? status?.profile?.next_faucet;
          if (nt) {
            const next = new Date(nt);
            const diffMs = next - new Date();
            if (diffMs > 0) {
              const h = Math.floor(diffMs / 3600000);
              const m = Math.floor((diffMs % 3600000) / 60000);
              timerMsg = `already claimed — next in ${h}h ${m}m`;
            }
          }
        } catch (_) {}
      }
      log(addr, `Faucet: ${C.yellow}${timerMsg}${C.reset}`, 'skip');
      stats.faucet = timerMsg;

    } else if (f?.error) {
      if (/not.authenticated|unauthorized|login.required/i.test(f.error ?? '')) {
        log(addr, `Faucet: ${C.yellow}session not authenticated — auth may need signature${C.reset}`, 'warn');
        log(addr, `${C.dim}💡 Check auth endpoint/signature flow in init()${C.reset}`, 'info');
      } else {
        log(addr, `Faucet error — ${C.red}${f.error}${C.reset} (code: ${f?.code ?? 'none'})`, 'warn');
      }
      stats.faucet = `error: ${f.error}`;

    } else {
      const msg = f?.message || f?.status || JSON.stringify(f);
      log(addr, `Faucet: ${C.green}${msg}${C.reset}`, 'ok');
      stats.faucet = msg;
    }

  } catch (e) {
    if (e instanceof RateLimitError) {
      log(addr, `Faucet: ${C.yellow}rate limited (429) — skip${C.reset}`, 'skip');
      stats.faucet = 'rate limited';
    } else if (isServerError(e)) {
      log(addr, `Faucet server error — skip: ${e.message}`, 'skip');
      stats.faucet = 'server error';
    } else {
      log(addr, `Faucet error: ${e.message}`, 'warn');
      stats.faucet = 'error';
    }
  }
  await sleep(2000);

  // 2. Quantum Crate
  await openQuantumCrates(api, addr, stats);
  await sleep(2000);

  // 3. Send TX
  await sendTxs(signer, api, addr, stats);

  // 4. Burn DACC for QE
  await burnForQE(signer, api, addr, stats);

  // 5. Fetch profile early — provides badge list + faucet timer (reused by mintBadges)
  let profileData = null;
  try {
    profileData = await api.profile();
    const qe  = profileData?.qe_balance ?? '-';
    const secsLeft = profileData?.faucet_seconds_left ?? 0;
    const faucetAvail = profileData?.faucet_available ?? true;
    stats.qe = qe;
    log(addr, `QE Balance: ${C.bold}${C.green}${qe}${C.reset}`, 'ok');
    if (!faucetAvail && secsLeft > 0) {
      const h = Math.floor(secsLeft / 3600);
      const m = Math.floor((secsLeft % 3600) / 60);
      const s = secsLeft % 60;
      log(addr, `Faucet next: ${C.yellow}${h}h ${m}m ${s}s${C.reset}`, 'info');
    }
  } catch (e) {
    if (isServerError(e)) log(addr, `Profile server error — skip: ${e.message}`, 'skip');
  }

  // 5. Mint Badges (Enhanced) — pass profile data so badge list is reused
  await mintBadges(signer, api, addr, profileData, stats);

  // 6. Activity Tasks
  await completeActivities(api, addr, stats);
  await sleep(2000);

  // 7. Profile / QE balance (already fetched above — just show summary)
  if (!profileData) {
    try {
      profileData = await api.profile();
      stats.qe = profileData?.qe_balance ?? '-';
      log(addr, `QE Balance: ${C.bold}${C.green}${stats.qe}${C.reset}`, 'ok');
    } catch (e) {
      if (isServerError(e)) log(addr, `Profile server error — skip: ${e.message}`, 'skip');
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

  console.log(`\n${C.bold}${C.cyan}${'='.repeat(55)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  DAC Inception Bot — ${keys.length} wallet(s)${C.reset}`);
  console.log(`${C.bold}${C.cyan}  Badge Mint: ${CFG.mintBadge ? C.green+'ENABLED' : C.red+'DISABLED'}${C.reset}${C.bold}${C.cyan} | Contract: ${CFG.badgeContract.slice(0,10)}...${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'='.repeat(55)}${C.reset}\n`);

  let done = 0, skipped = 0;

  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    try {
      await runWallet(keys[i], proxy, i + 1, keys.length);
      done++;
    } catch (e) {
      console.log(`${ts()} ${C.red}✗${C.reset} Wallet ${i+1} unexpected error — skip: ${e.message}`);
      skipped++;
    }
  }

  divider('-');
  console.log(`${ts()} ${C.bold}${C.green}✓ Cycle done — ${done} OK, ${skipped} skipped${C.reset}`);
  divider('-');
  console.log();
}

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
  // If stdin is not a TTY (PM2, nohup, piped, screen) — skip prompts, use defaults
  if (!process.stdin.isTTY) {
    console.log(`\n${C.bold}${C.cyan}  DAC Inception Bot — Non-interactive mode (defaults used)${C.reset}`);
    console.log(`  ${C.dim}TX: ${CFG.txCount} | Burn: ${CFG.burnAmount} DAC | Badge: ${CFG.mintBadge ? 'ON' : 'OFF'}${C.reset}\n`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log();
  console.log(`${C.bold}${C.cyan}========================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}   DAC Inception Bot -- Setup${C.reset}`);
  console.log(`${C.bold}${C.cyan}========================================${C.reset}`);
  console.log();

  const walletCount = loadKeys().length;
  console.log(`${C.dim}  Wallets loaded : ${C.reset}${C.bold}${walletCount}${C.reset}`);
  console.log();

  const txRaw    = await ask(rl, `  ${C.yellow}TX count per wallet  ${C.reset} ${C.dim}[default: ${CFG.txCount}]${C.reset}: `,    String(CFG.txCount));
  const txAmtRaw = await ask(rl, `  ${C.yellow}TX max amount (DAC)  ${C.reset} ${C.dim}[default: ${CFG.txMaxAmt}, auto-scaled to balance]${C.reset}: `, String(CFG.txMaxAmt));
  const burnRaw  = await ask(rl, `  ${C.yellow}Burn amount (DAC)    ${C.reset} ${C.dim}[default: ${CFG.burnAmount}, max: 0.1]${C.reset}: `,  String(CFG.burnAmount));
  const mintRaw  = await ask(rl, `  ${C.yellow}Mint badges? (y/n)   ${C.reset} ${C.dim}[default: y]${C.reset}: `, 'y');

  rl.close();

  const txCount    = Math.max(1, parseInt(txRaw) || CFG.txCount);
  // Guard: cap burn at 0.1 DAC max to prevent accidentally entering 1 or large values
  const burnParsed = parseFloat(burnRaw);
  const burnAmount = (burnParsed > 0 && burnParsed <= 0.1)
    ? burnParsed.toFixed(6)
    : CFG.burnAmount; // fall back to default if input is 0, negative, or > 0.1

  const txMaxAmt = parseFloat(txAmtRaw) > 0 ? parseFloat(txAmtRaw) : CFG.txMaxAmt;
  const txMinAmt = txMaxAmt * 0.3; // min = 30% of max

  CFG.txCount    = txCount;
  CFG.txMaxAmt   = txMaxAmt;
  CFG.txMinAmt   = txMinAmt;
  CFG.burnAmount = burnAmount;
  CFG.mintBadge  = mintRaw.toLowerCase() !== 'n';

  console.log();
  console.log(`${C.bold}${C.green}  Config summary:${C.reset}`);
  console.log(`  ${C.cyan}TX/wallet  :${C.reset} ${C.bold}${txCount} TX${C.reset}`);
  console.log(`  ${C.cyan}TX amount  :${C.reset} ${C.bold}${txMinAmt.toFixed(4)}–${txMaxAmt} DAC each${C.reset}`);
  console.log(`  ${C.cyan}Burn/wallet:${C.reset} ${C.bold}${burnAmount} DAC${C.reset}`);
  console.log(`  ${C.cyan}Mint badge :${C.reset} ${C.bold}${CFG.mintBadge ? C.green+'YES' : C.red+'NO'}${C.reset}`);
  console.log();
}

(async () => {
  await askConfig();
  let cycle = 1;
  while (true) {
    console.log(`${ts()} ${C.bold}${C.magenta}🚀 Starting cycle #${cycle}${C.reset}`);
    await runAll();
    cycle++;
    const nextHr = CFG.loopMinHr + Math.random() * (CFG.loopMaxHr - CFG.loopMinHr);
    const nextMs = Math.floor(nextHr * 60 * 60 * 1000);
    console.log(`${ts()} ${C.dim}Next cycle in ${nextHr.toFixed(2)} hours...${C.reset}\n`);
    await sleep(nextMs);
  }
})();
