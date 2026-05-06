# DAC Inception — Daily Testnet Bot
Automated daily activities for [DAC Inception](https://inception.dachain.io/activity) testnet.
**Chain:** DAC Quantum Chain (ID: 21894)
**RPC:** `https://rpctest.dachain.tech`
**Explorer:** `https://exptest.dachain.tech`
---
## Recent Updates
| Version | Change |
|---------|--------|
| **v1.4** | Parallel multi-wallet execution — replaced sequential `for` loop + 3s delay with `runWithConcurrency()` pool; added `concurrency` field in CFG (default: `3`); wallets now run simultaneously, cutting cycle time proportionally to concurrency level |
| **v1.3** | Added retry logic for all API calls (axios) — HTTP 429/5xx + network errors |
| **v1.2** | Added badge auto-mint — checks & mints all claimable badges each cycle |
| **v1.1** | Added retry logic for RPC errors — auto-retries up to 3x with backoff |
| **v1.0** | Proxy support for API + RPC traffic; TX count fixed at 15x per wallet |
---
## Next Update
Auto Reff
## Activities
| # | Action | Description |
|---|--------|-------------|
| 1 | 🚰 Faucet | Claim free DACC (requires X or Discord linked) |
| 2 | 💸 TX | Transfer **15x** to `address.txt` list or random addresses |
| 3 | 🔥 Burn | Burn DACC → Quantum Energy (QE) |
| 4 | 🏅 Badge | Auto-mint all claimable badges (API + on-chain) |
| 5 | 🔄 Sync | Sync all activity to API |
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
| Daily Streak | 3/7/14/21/30 days | 50–1000 |
| QE milestones | 500+ total QE | 50–5000 |
> The bot automatically detects and mints all claimable badges every cycle via API + on-chain Rank Badge contract.
---
## Setup
### 1. Prerequisites
```bash
# Clone repo
git clone https://github.com/v325-max/Dachain-Push-Bot.git
cd Dachain-Push-Bot
# Install dependencies
npm install
```
### 2. Wallet Keys
Create `pk.txt` in the project directory — one private key per line:
```bash
# Single wallet
echo "0xYOUR_PRIVATE_KEY_HERE" > pk.txt
# Multi-wallet
echo "0xWALLET_1_KEY" > pk.txt
echo "0xWALLET_2_KEY" >> pk.txt
echo "0xWALLET_3_KEY" >> pk.txt
```
> ⚠️ Never share or commit `pk.txt`!
### 3. Address List (Optional)
Create `address.txt` to send transactions to specific addresses. One address per line:
```bash
echo "0xRECIPIENT_1_ADDRESS" > address.txt
echo "0xRECIPIENT_2_ADDRESS" >> address.txt
```
> If `address.txt` doesn't exist, the bot generates random addresses automatically.
### 4. Proxy (Optional)
Create `proxy.txt` to route all traffic (API + RPC) through a proxy. One proxy per line:
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
> If `proxy.txt` doesn't exist or is empty, all wallets run **direct** without error.
> Proxies are rotated per wallet: wallet 1 → proxy 1, wallet 2 → proxy 2, and so on.
### 5. Concurrency (Multi-Wallet Speed)
Control how many wallets run **in parallel** by editing `concurrency` inside `CFG` in `bot.js`:
```js
const CFG = {
  // ...
  concurrency: 3,   // number of wallets processed simultaneously
};
```
| Wallet Count | Recommended `concurrency` |
|---|---|
| 5–10 | `3` (default) |
| 10–20 | `5` |
| 20+ | `8–10` |
> ⚠️ If using proxies, make sure you have enough proxies to match your concurrency setting to avoid IP rate-limiting.
### 6. Prerequisites per Wallet
Each wallet must have:
- ✅ Connected at [inception.dachain.io](https://inception.dachain.io) at least once
- ✅ Linked Twitter (X) or Discord for faucet
- ✅ Some DAC balance for txs and burn (claim faucet first)
---
## Usage
### Single Run
```bash
node bot.js --once
```
### Loop Mode (every 10 min)
```bash
node bot.js
```
### Cron Mode (4x daily: 00:00, 06:00, 12:00, 18:00 UTC)
```bash
node bot.js --cron
```
### Custom Options
```bash
node bot.js --tx 15             # 15 transfers per cycle (default)
node bot.js --burn 0.005        # burn 0.005 DAC per cycle (default)
node bot.js --tx 15 --burn 0.01 # combine options
```
---
## Systemd Service (Linux)
Run as background service with auto-restart:
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
# Edit crontab
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
| `address.txt` | ❌ | Recipient addresses (optional, one per line) |
| `proxy.txt` | ❌ | Proxy list (optional, one per line) |
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
**Parallel execution (v1.4+):**
Starting from v1.4, wallets are processed **concurrently** using a pool-based concurrency model:
```
Cycle start
├── Wallet 1 ──┐
├── Wallet 2 ──┼── running in parallel (up to N = concurrency)
├── Wallet 3 ──┘
├── Wallet 4 ──┐  (starts as soon as a slot frees up)
└── Wallet 5 ──┘
Cycle end ← all wallets done
```
Instead of waiting for each wallet to finish before starting the next, the bot runs up to `concurrency` wallets simultaneously — dramatically reducing total cycle time for large wallet sets.
**Flow per wallet:**
1. `GET /csrf/` → get CSRF cookie
2. `POST /api/auth/wallet/` → register/login wallet
3. `POST /api/inception/faucet/` → claim DACC
4. `POST tx × 15` → transfer to address.txt or random addresses
5. `POST burnForQE()` → burn 0.005 DACC on-chain
6. `POST /api/inception/sync/` → sync activity
7. `GET /api/inception/badge/` → fetch claimable badges
8. `POST /api/inception/badge/mint/` + on-chain mint → auto-mint each badge
9. `GET /api/inception/profile/` → check QE balance
**Retry logic:**
All RPC and API calls are automatically retried up to **3 times** with exponential backoff (3s → 6s → 9s).
| Layer | Retried errors |
|-------|----------------|
| RPC (ethers) | `NETWORK_ERROR`, `TIMEOUT`, `SERVER_ERROR`, `CONNECTION_REFUSED` |
| API network | `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` |
| API HTTP | `429` (rate limit), `500`, `502`, `503`, `504` |
**Proxy routing:**
- If `proxy.txt` exists → API calls (axios) + RPC calls (ethers) both route through proxy
- If no `proxy.txt` → direct connection, no error
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
| `Low balance — skip TX` | Claim faucet first for DAC |
| `CSRF verification failed` | Cookie expired — restart bot |
| `Auth failed` | Check private key format in `pk.txt` |
| `Crate limit reached` | Already opened today — wait 24h |
| `TX error: insufficient funds` | Top up wallet or reduce burn amount |
| `Proxy error / connection refused` | Check proxy format in `proxy.txt` |
| `Badge on-chain mint skipped` | Badge not yet earned or already minted |
| `API retry exhausted` | Server down — bot will retry next cycle |
| `Logs mixed between wallets` | Normal in parallel mode — each log line shows wallet address |
---
## License
MIT
