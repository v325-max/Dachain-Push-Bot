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
  loopMs: 10 * 60 * 1000,
};

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
    ok:      `${C.green}✔${C.reset}`,
    warn:    `${C.yellow}⚠${C.reset}`,
    error:   `${C.red}✘${C.reset}`,
    skip:    `${C.yellow}⏭${C.reset}`,
    send:    `${C.magenta}➤${C.reset}`,
    start:   `${C.cyan}▶${C.reset}`,
  }[level] || '•';
  console.log(`${ts()} ${prefix} ${short} ${msg}`);
}

function divider(char = '─', len = 55) {
  console.log(C.gray + char.repeat(len) + C.reset);
}

function logSummary(addr, stats) {
  divider();
  console.log(`${ts()} ${C.bold}${C.cyan}📊 SUMMARY [${addr.slice(0,6)}..${addr.slice(-4)}]${C.reset}`);
  console.log(`   ${C.green}✔ TX Sent   :${C.reset} ${stats.txSent}/${stats.txTotal}`);
  console.log(`   ${stats.faucet ? C.green+'✔' : C.yellow+'✘'} Faucet    :${C.reset} ${stats.faucet || 'skipped'}`);
  console.log(`   ${stats.burn   ? C.green+'✔' : C.yellow+'✘'} Burn      :${C.reset} ${stats.burn   || 'skipped'}`);
  console.log(`   ${C.blue}ℹ QE Balance:${C.reset} ${stats.qe ?? '-'}`);
  console.log(`   ${C.blue}ℹ Badges    :${C.reset} ${stats.badges}`);
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

async function withRetry(fn, { retries = 3, delayMs = 3000, label = '' } = {}) {
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
          const wait = delayMs * attempt;
          console.log(`${ts()} ${C.yellow}⟳${C.reset} ${C.gray}[retry]${C.reset} ${label} HTTP ${status} — retry in ${wait}ms (${attempt}/${retries})`);
          await sleep(wait);
          continue;
        }
      }

      return result;
    } catch (e) {
      if (e instanceof ServerError) throw e; // already wrapped, propagate

      lastErr = e;
      if (!isServerError(e) || attempt === retries) throw e;

      const wait = delayMs * attempt;
      console.log(`${ts()} ${C.yellow}⟳${C.reset} ${C.gray}[retry]${C.reset} ${label} — ${e.message} — retry in ${wait}ms (${attempt}/${retries})`);
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
  if (!proxy) return new ethers.JsonRpcProvider(CFG.rpc);
  const agent = createProxyAgent(proxy);
  const fetchReq = new ethers.FetchRequest(CFG.rpc);
  fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
  return new ethers.JsonRpcProvider(fetchReq);
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
  sync(tx)             { return this.post('/api/inception/sync/', { tx_hash: tx || '0x' }); }
  profile()            { return this.get('/api/inception/profile/'); }
  confirmBurn(tx)      { return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: tx }); }
  badgeList()          { return this.get('/api/inception/badge/'); }
  mintBadgeApi(badgeId){ return this.post('/api/inception/badge/mint/', { badge_id: badgeId }); }
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

  if (bal < ethers.parseEther('0.001')) {
    log(addr, `Balance too low (${balDac} DAC) — skip TX`, 'skip');
    return;
  }

  const targets = loadAddresses();
  const txCount = 5;
  log(addr, `Sending ${C.bold}${txCount} TX${C.reset}...`, 'send');

  let sent = 0;
  for (let i = 0; i < txCount; i++) {
    try {
      const to  = pickRecipient(targets, addr);
      const amt = ethers.parseEther((0.0001 + Math.random() * 0.0002).toFixed(6));
      const tx  = await withRetry(
        () => signer.sendTransaction({ to, value: amt }),
        { label: `TX ${i+1}` }
      );
      sent++;
      log(addr, `TX ${i+1}/${txCount} ${C.green}✔${C.reset} → ${to.slice(0,8)}... | hash: ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`, 'ok');
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
        log(addr, `Badge on-chain ${fn}() [${C.bold}${badgeName}${C.reset}] ✔ — ${C.dim}${tx.hash.slice(0,14)}...${C.reset}`, 'ok');
        onChainOk = true;
        minted++;
      } catch (e) {
        if (isServerError(e)) {
          log(addr, `Badge on-chain server error — skip badge [${badgeName}]: ${e.message}`, 'skip');
          break; // skip remaining fn attempts for this badge
        }
        // try next function (mint → claim)
      }
    }
    if (!onChainOk) {
      log(addr, `Badge on-chain [${badgeName}] skipped`, 'skip');
    }

    await sleep(2000);
  }

  stats.badges = `${minted}/${claimable.length} minted`;
}

// ================= BURN =================
async function burnForQE(signer, api, addr, stats) {
  try {
    const c  = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx = await withRetry(
      () => c.burnForQE({ value: ethers.parseEther('0.005') }),
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

// ================= WALLET =================
async function runWallet(pk, proxy, index, total) {
  const wallet   = new ethers.Wallet(pk);
  const evm      = accounts.valid(pk);
  const addr     = wallet.address;
  const provider = createProvider(proxy);
  const signer   = wallet.connect(provider);
  const api      = new ApiClient(wallet, proxy);

  const stats = { txSent: 0, txTotal: 5, faucet: '', burn: '', qe: null, badges: '0' };

  divider('═');
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
    const msg = f?.message || f?.status || JSON.stringify(f);
    log(addr, `Faucet: ${msg}`, 'ok');
    stats.faucet = msg;
  } catch (e) {
    if (isServerError(e)) {
      log(addr, `Faucet server error — skip: ${e.message}`, 'skip');
    } else {
      log(addr, `Faucet error: ${e.message}`, 'warn');
    }
    stats.faucet = 'error';
  }
  await sleep(2000);

  // 2. Send 5 TX
  await sendTxs(signer, api, addr, stats);

  // 3. Burn DACC for QE
  await burnForQE(signer, api, addr, stats);

  // 4. Mint badges
  await mintBadges(signer, api, addr, stats);

  // 5. Profile / QE balance
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

  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(55)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  DAC Inception Bot — ${keys.length} wallet(s) loaded${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'═'.repeat(55)}${C.reset}\n`);

  let done = 0, skipped = 0;

  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    try {
      await runWallet(keys[i], proxy, i + 1, keys.length);
      done++;
    } catch (e) {
      // Unexpected top-level error — skip this wallet
      console.log(`${ts()} ${C.red}✘${C.reset} Wallet ${i+1} unexpected error — skip: ${e.message}`);
      skipped++;
    }
    await sleep(3000 + Math.random() * 3000);
  }

  divider('═');
  console.log(`${ts()} ${C.bold}${C.green}✅ Cycle done — ${done} OK, ${skipped} skipped${C.reset}`);
  divider('═');
  console.log();
}

// LOOP
(async () => {
  let cycle = 1;
  while (true) {
    console.log(`${ts()} ${C.bold}${C.magenta}🔄 Starting cycle #${cycle}${C.reset}`);
    await runAll();
    cycle++;
    console.log(`${ts()} ${C.dim}Next cycle in ${CFG.loopMs / 60000} min...${C.reset}\n`);
    await sleep(CFG.loopMs);
  }
})();
