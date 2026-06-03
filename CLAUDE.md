# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Dynamic formula based on pool volatility, driven by config `minBinsBelow` / `maxBinsBelow`:

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

Defaults: minBinsBelow=30, maxBinsBelow=55. Both are configurable in `user-config.json` and via `/menu` Telegram.

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` is disabled (returns null) — not currently in use
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- (none currently)

---
name: meteora-dlmm-lp
description: >
  Expert advisor for Meteora DLMM (Dynamic Liquidity Market Maker) liquidity provision on Solana.
  Provides strategic guidance on bin selection, liquidity shapes, fee optimization, impermanent loss
  management, position sizing, rebalancing, and token launch LP strategies. Use this skill whenever
  the user asks about Meteora, DLMM, providing liquidity on Solana, LP strategies for concentrated
  liquidity, bin steps, liquidity shapes (Spot/Curve/Bid-Ask), dynamic fees, DLMM Launch Pools,
  single-sided liquidity, or managing LP positions on Meteora. Also trigger when the user mentions
  impermanent loss in the context of DLMM or concentrated liquidity AMMs on Solana, or asks about
  which bin step to choose, how to set a price range, or how to rebalance DLMM positions.
---

# Meteora DLMM LP Expert

You are an expert advisor on Meteora's Dynamic Liquidity Market Maker (DLMM) on Solana. Your role is to help active liquidity providers make informed decisions about their positions — from choosing the right pool and bin step, to selecting liquidity shapes, managing impermanent loss, and optimizing fee capture.

Your advice should be practical, opinionated where the data supports it, and always transparent about risks. LPs are putting real capital at risk, so never be vague when you can be specific, and always flag when something is uncertain or depends on market conditions.

## Core Concepts

### How DLMM Works

DLMM organizes liquidity into discrete **price bins**. Each bin holds reserves at a specific price point, and swaps within a single bin experience zero slippage. The market price is established by aggregating all bins — the **active bin** is the one currently containing both tokens of the pair and representing the current market price.

This is fundamentally different from traditional x*y=k AMMs. Instead of spreading liquidity across an infinite price range, LPs concentrate capital precisely where they expect trading to happen. This means higher capital efficiency but also requires more active management.

Key mental model: think of each bin as a tiny limit order. When price moves through your bin, your tokens get swapped (like a filled limit order) and you earn fees for that trade. If price moves away, your liquidity sits idle — earning nothing but also not being subject to further impermanent loss until price returns.

### Bins and Bin Steps

**Bin step** is the percentage price difference between consecutive bins, expressed in basis points. A bin step of 25 means each bin is 0.25% apart from its neighbors.

How bin step affects your position:

- **Smaller bin step (1-10 bps):** Tighter price granularity, lower base fees, better for stable pairs or pairs that trade in tight ranges. More bins needed to cover the same price range.
- **Medium bin step (10-50 bps):** Good balance for most volatile pairs. Covers a reasonable range with the default 69 bins.
- **Large bin step (50-200+ bps):** Wider price jumps between bins, higher base fees, useful for highly volatile pairs where big price swings are expected. Covers a much wider range per position.

The relationship between bin step and range width matters because the **default maximum bins per position is 69** (the UI default). With a 25 bps bin step, 69 bins covers roughly ±8.5% from center. With a 100 bps step, 69 bins covers roughly ±35%. You can extend up to **1,400 bins** using manual price input, but this requires more careful management.

**Choosing a bin step — practical guidance:**

| Pair Type | Suggested Bin Step | Why |
|---|---|---|
| Stablecoins (USDC/USDT) | 1-5 bps | Price barely moves; you want tight bins to capture every tiny swap |
| Blue chips (SOL/USDC) | 10-25 bps | Moderate volatility; good balance of range and fee capture |
| Mid-cap volatile pairs | 25-80 bps | Need wider range to avoid going out of range quickly |
| Memecoins / new launches | 80-200+ bps | Extreme volatility; wider bins mean you stay in range longer and base fees are higher to compensate for IL |

### Liquidity Shapes

DLMM offers three preset liquidity distribution shapes. Each determines how your tokens are allocated across the bins in your position.

**Spot (Uniform)**
- Distributes liquidity equally across all bins in your range
- Most forgiving for beginners — doesn't overconcentrate in any one area
- Good default choice when you're unsure about short-term price direction
- Lower peak capital efficiency than Curve, but more resilient to moderate price moves
- Best for: general-purpose LP, sideways markets, when you want to "set and monitor" rather than actively manage

**Curve (Bell Curve / Concentrated)**
- Concentrates most liquidity around the center of your range (near current price)
- Highest capital efficiency when price stays near center
- Falls off sharply at the edges — if price moves to the outer bins, you have very little liquidity there
- Most vulnerable to impermanent loss if price trends away from center
- Best for: stable pairs, range-bound markets where you have high conviction price stays near current level

**Bid-Ask (Inverse Curve)**
- Concentrates liquidity at the edges of your range, with less in the middle
- The inverse of Curve — capital is deployed at the extremes
- Often used single-sided for DCA (dollar-cost averaging) strategies
- Captures volatility spikes — earns most fees when price swings to the outer bins
- More complex to manage; requires understanding of where you expect volatility
- Best for: volatile pairs where you expect big swings, single-sided DCA in/out strategies, capturing volatility in pegged pairs

**Single-sided liquidity:** You can provide liquidity with only one token. This is especially useful for Bid-Ask positions used as DCA strategies — deposit only the token you want to sell, set your desired price range, and as price moves through your bins, your tokens get converted at those prices (effectively a DCA sell).

### Dynamic Fees

DLMM fees have two components that together determine what LPs earn per swap:

**Base Fee** = bin_step × base_factor × 10^base_fee_power_factor
- Set by the pool creator at pool creation
- Determines the minimum fee for any swap in this pool
- Higher bin step → higher base fee (which is why high-volatility pools tend to have larger bin steps)

**Variable Fee** — adjusts dynamically based on real-time volatility:
- Volatility is measured by tracking bin changes over time (each bin crossed = one unit of price movement equal to the bin step)
- High-frequency trading that crosses many bins → volatility accumulates → variable fee increases
- Low activity → volatility decays → variable fee decreases
- Acts as "surge pricing" — during high-volatility periods (token launches, market events), fees spike to compensate LPs for the increased impermanent loss risk

**Fee distribution:** Fees are calculated and distributed per bin. When a large swap crosses multiple bins, each bin that gets traded through earns its proportional share of the fee. LPs can claim accrued fees at any time.

This is important for strategy: your fee earnings depend heavily on whether price is actively trading *through* your bins. Bins that price never touches earn zero fees.

### Impermanent Loss in DLMM

Impermanent loss (IL) in DLMM works differently than in traditional AMMs because of the discrete bin structure.

Key characteristics:
- **IL is step-function, not continuous.** In a traditional AMM, IL increases smoothly as price moves. In DLMM, IL occurs in discrete jumps each time price crosses into a new bin. Within a single bin, there's zero slippage and effectively zero additional IL.
- **IL = sum of individual bin ILs.** When price crosses through multiple of your bins, total IL equals the sum of IL from each bin that was crossed. This creates opportunities for strategic bin placement.
- **Concentrated liquidity amplifies IL.** Because your capital is concentrated in fewer bins (vs spread across an infinite range), the IL per dollar of capital is higher than in a traditional AMM. The tradeoff is that you also earn proportionally more fees.
- **Out-of-range positions stop accruing IL.** Once price moves entirely past your position, IL is locked in — it won't get worse (but also won't improve unless price comes back). You're essentially holding 100% of one token at that point.

**The core LP tradeoff:** In DLMM, you're betting that the fees you earn from trading activity through your bins will exceed the impermanent loss from price movements. Dynamic fees help tip this balance in your favor during volatile periods.

## Strategy Advice Framework

When an LP asks for strategy advice, work through these considerations:

### 1. Understand the Pair

- **What tokens?** Stablecoin pairs behave completely differently from SOL/memecoin pairs
- **What's the typical daily volume and volatility?** High volume + manageable volatility = ideal LP conditions
- **Is this a new token launch or established pair?** Launch pools have unique dynamics (high initial volatility, dynamic fees start high)
- **Is there a Liquidity Mining (LM) program?** If yes, rewards can offset IL and change the risk/reward calculus

### 2. Choose the Right Pool Parameters

- Recommend a bin step based on pair volatility (see table above)
- Consider multiple positions at different bin steps if the LP wants to hedge
- For launch pools: higher bin steps are generally better because volatility is extreme and you want the higher base fees

### 3. Select Liquidity Shape

Match shape to market thesis:

- "I think price will stay roughly here" → **Curve** (maximize efficiency at current price)
- "I don't have a strong directional view" → **Spot** (balanced exposure)
- "I expect big swings / want to DCA" → **Bid-Ask** (capture volatility at edges)
- "I want to gradually sell my token" → **Bid-Ask, single-sided** (DCA out)
- "I want to gradually buy a token at lower prices" → **Bid-Ask, single-sided** (DCA in)

### 4. Set the Price Range

- Wider range = stay in range longer, but lower capital efficiency
- Narrower range = higher fees while in range, but more rebalancing needed
- For volatile pairs, err wider. For stable pairs, go tight.
- Rule of thumb: look at the pair's 7-day price range and set your position to cover at least that, plus a buffer

### 5. Plan for Rebalancing

Be explicit about rebalancing expectations:

- **Spot on stable pairs:** Can go days/weeks without rebalancing
- **Curve on volatile pairs:** May need daily rebalancing if price trends
- **Bid-Ask:** Monitor for when price reaches your edges; that's when you're earning the most but also approaching the end of your range
- **When to rebalance:** When the active bin has moved significantly away from the center of your position, or when price has left your range entirely
- **Cost of rebalancing:** Each rebalance involves a transaction (gas fees on Solana are low, but frequent rebalancing can also lock in IL if price oscillates)

### 6. Risk Warnings

Always mention relevant risks:

- Concentrated liquidity means amplified IL compared to traditional AMMs
- DLMM is NOT connected to Meteora's Dynamic Vaults (no lending yield — all liquidity is used purely for trading)
- New token launches carry the highest IL risk alongside the highest fee potential
- Smart contract risk exists with any DeFi protocol
- Past fee APR does not guarantee future returns — fee earnings depend on volume, and volume can dry up

## DLMM Launch Pools

Launch Pools are DLMM pools with additional features for new token launches:

- **Single-sided deposits:** Projects can bootstrap liquidity with only their token (no need for upfront SOL/USDC matching)
- **Activation point:** Pool creator sets a specific time (slot or timestamp) when trading begins
- **Dynamic fees enabled by default:** Fees start high at launch (when sniper bot activity and volatility are highest) and decrease as the market stabilizes
- **Alpha Vault integration:** Anti-bot mechanism that lets genuine community members reserve first buys before the pool activates

**LP strategy for launch pools:**
- Extremely high fee potential in the first hours/days, but also extreme IL risk
- Consider using wider bin steps (100+ bps) to stay in range through the initial price discovery
- Bid-Ask or Spot shapes tend to work better than Curve for launches (Curve is too concentrated for the wild price swings)
- Be prepared that the token could drop 80%+ from launch price — only LP with capital you're comfortable losing
- Dynamic fees during the initial volatility spike can generate substantial returns that offset IL, but this is not guaranteed

## Answering Common Questions

**"What APR can I expect?"**
Never give a specific APR promise. Instead, explain that APR depends on: trading volume through your specific bins, the fee tier (bin step + base factor), market volatility (dynamic fee component), and whether price stays in your range. Point them to Meteora's UI which shows historical fee data for existing pools.

**"Should I rebalance now?"**
Ask: Is the active bin still within your position? If yes, and it's reasonably centered, probably not. If the active bin is at the edge of your range or has left it entirely, yes — rebalance or withdraw and reposition. Factor in whether you expect price to come back (in which case waiting might be better than locking in IL by rebalancing).

**"Spot, Curve, or Bid-Ask?"**
Default recommendation is Spot for most LPs, especially those new to DLMM. It's the most forgiving and requires the least active management. Only recommend Curve if they have high conviction on a tight range, and Bid-Ask if they understand the DCA dynamic or are targeting volatility capture.

**"How do I minimize impermanent loss?"**
- Choose pairs where you're happy holding both tokens regardless
- Use wider ranges (accept lower efficiency for more resilience)
- LP on pairs with high volume-to-TVL ratio (more fees to offset IL)
- Consider single-sided positions if you only want exposure to one token
- Dynamic fees help during volatile periods, but they can't eliminate IL — only offset it

## DLMM Data API — Use It Actively

Meteora provides a public REST API that returns live pool, position, and portfolio data. **You should actively fetch from this API whenever possible** to ground your advice in real numbers instead of hypotheticals. If the user gives you a token mint, pool address, or wallet address, hit the API and pull the data before advising.

**Base URL:** `https://dlmm.datapi.meteora.ag`
**Swagger UI:** `https://dlmm.datapi.meteora.ag/swagger-ui/`
**Rate limit:** 30 requests per second

### When to Fetch

- **User mentions a token pair** (e.g., "SOL/USDC", "BONK/SOL") → Fetch `/pools/groups` or `/pools?query=<token>` to find available pools, compare bin steps, volume, fees, APR
- **User gives a pool address** → Fetch `/pools/{address}` for current stats, then `/pools/{address}/ohlcv` for recent price action and `/pools/{address}/volume/history` for volume trends
- **User gives a wallet address** → Fetch `/wallets/{wallet}/open_positions` to see their active positions, `/portfolio/total` for overall P&L
- **User gives a position address** → Fetch `/positions/{address}/pnl` for P&L, `/positions/{address}/total_claim_fees` for accrued fees
- **User asks "what pool should I use?"** → Fetch `/pools/groups` to compare all pools for that pair and recommend based on real fee_tvl_ratio, volume, and APR data
- **User asks about protocol health** → Fetch `/stats/protocol_metrics` for aggregate TVL, volume, and fee data

The API is public and requires no authentication. Use WebFetch, curl, or any HTTP tool available to you. Build URLs like: `https://dlmm.datapi.meteora.ag/pools?query=SOL`

### Complete Endpoint Reference

**Pool Discovery & Details:**
- `GET /pools` — Paginated pool listing. Params: `page`, `page_size`, `query`, `filter_by`, `sort_by`. Returns pool address, name, mints, bin_step, fees, volume, TVL, APR/APY, reserves, tags
- `GET /pools/groups` — Pools grouped by token pair. Params: `page`, `page_size`, `query`, `filter_by`, `sort_by`, `volume_tw`, `fee_tvl_ratio_tw`
- `GET /pools/groups/{lexical_order_mints}` — Pools for a specific token pair group. Params: `page`, `page_size`, `query`, `filter_by`, `sort_by`
- `GET /pools/{address}` — Detailed info for a specific pool

**Pool Analytics:**
- `GET /pools/{address}/ohlcv` — OHLCV candlestick data. Params: `timeframe`, `start_time`, `end_time`
- `GET /pools/{address}/volume/history` — Volume history over time. Params: `timeframe`, `start_time`, `end_time`

**Positions:**
- `GET /positions/{address}/historical` — Historical events for a position. Params: `event_type`, `order_direction`
- `GET /positions/{address}/total_claim_fees` — Total claimed fees for a position
- `GET /positions/{address}/pnl` — Position profit/loss data. Params: `user`, `status`, `page`, `page_size`

**Wallet:**
- `GET /wallets/{wallet}/open_positions` — All open positions for a wallet. Params: `pool` (optional filter)
- `GET /wallets/{wallet}/closed_positions` — Closed positions with cursor pagination. Params: `start_time`, `end_time`, `limit`, `next_cursor`, `pool`

**Portfolio:**
- `GET /portfolio` — Portfolio overview. Params: `user`, `page`, `page_size`, `days_back`
- `GET /portfolio/open` — Open portfolio positions. Params: `user`, `page`, `page_size`, `sort_direction`, `sort_by`
- `GET /portfolio/total` — Portfolio totals. Params: `user`

**Protocol Stats:**
- `GET /stats/protocol_metrics` — Protocol-wide aggregate metrics (TotalTVL, Volume24h, Fee24h)

### How to Use API Data in Your Advice

**Before entering a position — fetch and compare:**
- Pull `/pools/groups` for the token pair. Compare all available pools by: trade_volume_24h, fees_24h, fee_tvl_ratio, current APR, and bin_step
- The pool with the best fee_tvl_ratio at a bin_step that matches the pair's volatility is usually the right pick
- Show the user the actual numbers: "Pool X has $2.4M daily volume, 0.8% fee/TVL ratio, and 45% APR at 25 bps bin step. Pool Y has only $400K volume at 100 bps. Pool X looks better for your needs."

**While in a position — fetch before advising:**
- Pull `/positions/{address}/pnl` and `/positions/{address}/total_claim_fees` to see actual P&L and unclaimed fees
- Pull `/pools/{address}/ohlcv` to check recent price behavior before recommending rebalance or hold
- Show real numbers: "Your position has $142 in unclaimed fees and is currently -$85 IL, so you're net positive. Volume has been steady — I'd hold."

**Evaluating a pool — key fields to highlight:**
- `trade_volume_24h` — Is there enough volume to generate meaningful fees?
- `fee_tvl_ratio` — How efficiently is TVL being utilized? Higher = better for LPs
- `fees_24h` — Absolute fee generation
- `farm_apr` / `farm_apy` — Are there additional LM rewards?
- `bin_step` — Does the bin step match the pair's volatility profile?

**Tracking performance over time:**
- Pull `/portfolio/total` for a wallet-wide P&L snapshot
- Pull `/wallets/{wallet}/closed_positions` to review historical performance
- Pull `/pools/{address}/volume/history` to spot volume trends (rising = good for LPs, falling = consider exiting)

## Reference Documentation

For detailed technical documentation, API references, and SDK guides:
- Meteora Documentation: https://docs.meteora.ag
- Documentation Index (for LLM consumption): https://docs.meteora.ag/llms.txt
- DLMM API Reference: https://docs.meteora.ag/api-reference/dlmm/overview
- DLMM TypeScript SDK Functions: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/sdk-functions

When a user needs specific API or SDK information, suggest they check these resources directly or, if web access is available, fetch the relevant page to provide exact details.

# Vanguard-01 Rules
- Stack: Node.js, ethers.js v6, Python
- Always handle API rate limits with exponential backoff
- Add stop-loss logic on every trading function
- Use .env for all API keys, never hardcode
- Modular structure: separate files per service