# DAC Inception — Daily Testnet Bot

Automated daily activities for [DAC Inception](https://inception.dachain.io/activity) testnet.

**Chain:** DAC Quantum Chain (ID: 21894)
**RPC:** `https://rpctest.dachain.tech`
**Explorer:** `https://exptest.dachain.tech`

---

## Recent Updates

| Version | Change |
|---------|--------|
| **v1.7** | Fixed activity tasks — correct endpoint `POST /api/inception/task/` with `{task: taskKey}`; added 14 sync tasks + 5 visit page calls per cycle; removed duplicate `runWallet` |
| **v1.6** | Full English output — all prompts, logs, and summaries now in English; interactive setup asks TX count and burn amount on every run |
| **v1.5** | Auto activity tasks — `completeActivities()` fetches `/api/inception/task/`, detects open/pending tasks, auto-syncs onchain tasks, completes social tasks, and claims rewards each cycle |
| **v1.4** | Parallel multi-wallet execution — replaced sequential `for` loop + 3s delay with `runWithConcurrency()` pool; added `concurrency` field in CFG; wallets ran simultaneously *(removed in v1.6)* |
| **v1.3** | Retry logic for all API calls (axios) — HTTP 429/5xx + network errors |
| **v1.2** | Badge auto-mint — checks & mints all claimable badges each cycle |
| **v1.1** | Retry logic for RPC errors — auto-retries up to 3x with backoff |
| **v1.0** | Proxy support for API + RPC traffic; TX count fixed at 5x per wallet |

---

## Next Update

Auto Reff

---

## Activities (Per Cycle)

| # | Action | Description |
|---|--------|-------------|
| 1 | 🚰 Faucet | Claim free DACC (requires X or Discord linked) |
| 2 | 📦 Quantum Crate | Open up to 5 crates/day — costs 150 QE each |
| 3 | 💸 TX | Transfer to `address.txt` list or random addresses |
| 4 | 🔥 Burn | Burn DACC → Quantum Energy (QE) |
| 5 | 🏅 Badge | Auto-mint all claimable badges (API + on-chain) |
| 6 | 📋 Tasks | Sync 14 onchain tasks + visit 5 pages |
| 7 | 📊 Profile | Fetch and log QE balance |

---

## Activity Tasks

Tasks are sourced from [inception.dachain.io/activity](https://inception.dachain.io/activity). The bot handles two categories automatically each cycle.

### ✅ Automated — Sync Tasks
Called via `POST /api/inception/task/` with `{ task: taskKey }` after on-chain activity.

| Task Key | Description | QE Reward |
|----------|-------------|-----------|
| `tx_first` | Send first transaction | 50 |
| `tx_3` | Send 3 transactions | 25 |
| `tx_5` | Send 5 transactions | 50 |
| `tx_10` | Send 10 transactions | 100 |
| `tx_25` | Send 25 transactions | 150 |
| `tx_50` | Send 50 transactions | 250 |
| `tx_3_wallets` | Send to 3 distinct wallets | 75 |
| `tx_receive` | Receive DACC from another wallet | 50 |
| `hold_5` | Hold 5+ DACC balance | 25 |
| `hold_10` | Hold 10+ DACC balance | 50 |
| `hold_25` | Hold 25+ DACC balance | 100 |
| `hold_50` | Hold 50+ DACC balance | 150 |
| `hold_75` | Hold 75+ DACC balance | 200 |
| `hold_100` | Hold 100+ DACC balance | 300 |

**Total: up to 1,575 QE from sync tasks**

### ✅ Automated — Visit Tasks
Called via `POST /api/inception/visit/<page>/` — triggers page-visit rewards.

| Page | Endpoint | QE Reward |
|------|----------|-----------|
| Activity | `/api/inception/visit/activity/` | — |
| Faucet | `/api/inception/visit/faucet/` | 25 |
| Leaderboard | `/api/inception/visit/leaderboard/` | 25 |
| Badges | `/api/inception/visit/badges/` | 25 |
| Explorer | `/api/inception/visit/explorer/` | 50 |

**Total: up to 125 QE from visit tasks**

### 🔄 Auto-tracked (no bot action needed)
Server tracks these automatically based on on-chain activity. No API call required.

| Section | Tasks | QE |
|---------|-------|----|
| Onboarding | Sign in, Double Drip, Triple Streak | 100 |
| Faucet Milestones | 10 / 20 / 30 / 40 claims, 3-day row | 375 |
| Transactions | First swap, Liquidity provider, NFT minter | 275 |
| Streaks | 3 / 7 / 14 / 21 / 30-day activity | 2,150 |
| Weekly | Check-in, Recruiter | 250 |

**Total: up to 3,150 QE tracked automatically**

### ❌ Manual Only (cannot be automated)

| Task | Why | QE |
|------|-----|----|
| Link X account | Requires OAuth redirect | 75 |
| Link Discord | Requires OAuth redirect | 100 |
| Follow on X | Trust verification by team | 200 |
| Join Telegram | Trust verification by team | 100 |
| Verify email | Email inbox required | 75 |
| Referrals (1/3/10/25/50) | Real user invite required | up to 2,750 |

---

## Badges (Auto-earned & Auto-minted)

| Badge | Requirement | QE Reward |
|-------|-------------|-----------|
| Sign In | First login | 25 |
| First Crate | Open 1 crate | 25 |
| First Transaction | Send 1 tx | 50 |
| Getting Started | Send 3 tx | 25 |
| 10 Transactions | Send 10 tx | 100 |
| 50 Transactions | Send 50 tx | 250 |
| First Drip | Claim faucet 1x | 25 |
| Regular | Claim faucet 10x | 50 |
| Daily Streak | 3/7/14/21/30 days | 50–1,000 |
| QE Milestones | 500+ total QE | 50–5,000 |

> Badges are automatically detected and minted via API + on-chain Rank Badge contract every cycle.

---

## Setup

### 1. Prerequisites

```bash
git clone https://github.com/v325-max/Dachain-Push-Bot.git
cd Dachain-Push-Bot
npm install
```

### 2. Wallet Keys

Create `pk.txt` — one private key per line:

```bash
# Single wallet
echo "0xYOUR_PRIVATE_KEY_HERE" > pk.txt

# Multi-wallet
echo "0xWALLET_1_KEY" >  pk.txt
echo "0xWALLET_2_KEY" >> pk.txt
echo "0xWALLET_3_KEY" >> pk.txt
```

> ⚠️ Never share or commit `pk.txt`!

### 3. Address List (Optional)

Create `address.txt` — recipient addresses, one per line:

```bash
echo "0xRECIPIENT_1" > address.txt
echo "0xRECIPIENT_2" >> address.txt
```

> If `address.txt` doesn't exist, the bot generates random recipient addresses automatically.

### 4. Proxy (Optional)

Create `proxy.txt` — one proxy per line:

```bash
echo "host:port" > proxy.txt
echo "user:pass@host:port" >> proxy.txt
echo "http://user:pass@host:port" >> proxy.txt
```

Supported formats:
```
host:port
user:pass@host:port
http://user:pass@host:port
socks5://host:port
```

> If `proxy.txt` is missing or empty, all wallets run direct — no error.
> Proxies rotate per wallet: wallet 1 → proxy 1, wallet 2 → proxy 2, and so on.

### 5. Prerequisites per Wallet

Each wallet must have:
- ✅ Connected at [inception.dachain.io](https://inception.dachain.io) at least once
- ✅ Linked X (Twitter) or Discord for faucet access
- ✅ Some DACC balance for TX and burn (claim faucet first)

---

## Usage

### Interactive Setup

Every time the bot starts, it prompts you to configure the run:

![Setup Preview](https://gumloop.com/files/Eemnu9SRHovoRrJMYGXQzW?version_id=msu43HAv7NqJt9BFzukxJj)

> Press **Enter** on any prompt to accept the default value shown in `[brackets]`.

### Single Run

```bash
node bot.js --once
```

### Loop Mode

```bash
node bot.js
```

### Cron Mode (4x daily: 00:00, 06:00, 12:00, 18:00 UTC)

```bash
node bot.js --cron
```

### Custom Options

```bash
node bot.js --tx 15             # 15 transfers per cycle
node bot.js --burn 0.01         # burn 0.01 DAC per cycle
node bot.js --tx 15 --burn 0.01 # combine options
```

---

## Systemd Service (Linux)

```bash
sudo tee /etc/systemd/system/dachain-bot.service << 'EOF'
[Unit]
Description=DAC Inception Daily Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/dachain-bot
ExecStart=/usr/bin/node bot.js --cron
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dachain-bot
sudo systemctl start dachain-bot

# Check logs
sudo journalctl -u dachain-bot -f
```

## Crontab (Alternative)

```bash
crontab -e

# Add (runs at 00:00, 06:00, 12:00, 18:00 UTC):
0 0,6,12,18 * * * cd /root/dachain-bot && /usr/bin/node bot.js --once >> bot.log 2>&1
```

---

## Files

| File | Required | Description |
|------|----------|-------------|
| `bot.js` | ✅ | Main bot script |
| `pk.txt` | ✅ | Private keys (one per line) |
| `address.txt` | ❌ | Recipient addresses (optional) |
| `proxy.txt` | ❌ | Proxy list (optional) |
| `state.json` | — | Runtime state (auto-generated) |
| `bot.log` | — | Activity log (auto-generated) |
| `package.json` | ✅ | Project config |

---

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  pk.txt     │────▶│  bot.js      │────▶│  DAC API        │
│  (wallets)  │     │  (ethers.js) │     │  (CSRF+cookie)  │
└─────────────┘     └──────┬───────┘     └────────┬────────┘
                           │                       │
┌─────────────┐     ┌──────▼───────┐        ┌──────▼────────┐
│ address.txt │────▶│  DAC Chain   │        │  Inception    │
│ (recipients)│     │  (RPC)       │        │  Dashboard    │
└─────────────┘     └──────────────┘        └───────────────┘
        ▲
┌───────┴─────┐
│  proxy.txt  │  (optional — routes API + RPC traffic)
└─────────────┘
```

**Flow per wallet:**

```
1. GET  /csrf/                              → get CSRF cookie
2. POST /api/auth/wallet/                  → login wallet
3. POST /api/inception/faucet/             → claim DACC
4. POST /api/inception/crate/open/         → open quantum crates (up to 5x)
5. POST tx × N                             → transfer to recipients
6. burnForQE()                             → burn DACC on-chain
7. POST /api/inception/sync/               → sync txs to API
8. GET  /api/inception/badge/              → fetch claimable badges
9. POST /api/inception/badge/mint/         → mint each badge (API)
   + on-chain mint()                       → mint badge on-chain
10. POST /api/inception/task/              → sync 14 onchain tasks
    POST /api/inception/visit/<page>/      → visit 5 pages
11. GET  /api/inception/profile/           → fetch QE balance
```

**Retry logic:**

All RPC and API calls are automatically retried up to **5 times** with randomized backoff.

| Layer | Retried errors |
|-------|----------------|
| RPC (ethers) | `NETWORK_ERROR`, `TIMEOUT`, `SERVER_ERROR`, `CONNECTION_REFUSED` |
| API network | `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` |
| API HTTP | `429` (rate limit), `500`, `502`, `503`, `504` |

**Proxy routing:**
- `proxy.txt` present → all API (axios) + RPC (ethers) calls route through proxy
- `proxy.txt` absent → direct connection, no error

---

## Contracts

| Contract | Address |
|----------|---------|
| QE Exchange | `0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24` |
| Rank Badge | `0xB36ab4c2Bd6aCfC36e9D6c53F39F4301901Bd647` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Faucet: link X or Discord` | Link social at [inception.dachain.io](https://inception.dachain.io) |
| `Low balance — skip TX` | Claim faucet first |
| `CSRF verification failed` | Cookie expired — restart bot |
| `Auth failed` | Check private key format in `pk.txt` |
| `Crate limit reached` | Already opened today — wait 24h |
| `TX error: insufficient funds` | Top up wallet or reduce burn amount |
| `Proxy error / connection refused` | Check proxy format in `proxy.txt` |
| `Badge on-chain mint skipped` | Badge not yet earned or already minted |
| `API retry exhausted` | Server down — bot will retry next cycle |
| `Task: already / not_eligible` | Normal — task already completed before |

---

## License

MIT
