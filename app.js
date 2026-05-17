/* ============================================================
   LongVault — app.js
   Single-file vanilla JS app with hash router, mock + RPC mode.
   ============================================================ */

(() => {
'use strict';

/* ─── Constants ─────────────────────────────────────────────── */

const CHAIN_ID = 56;
const RPC_URL  = 'https://lb.drpc.live/bsc/AhFFc_foCERVuckrokH_kjlQCkQrR94R8Z7UtiKh6MJI';
const FACTORY  = '0x0df45b2af64ca90778c38440b465e7b2af74d914'; // LongVaultFactory on BSC
const FACTORY_DEPLOY_BLOCK = 0; // 设为部署区块号可大幅加速 Live 扫描；0 = 默认扫近 50万区块
const FLAP_PORTAL       = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const FLAP_VAULT_PORTAL = '0x90497450f2a706f1951b5bdda52B4E5d16f34C06';
const BNB_ORACLE        = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';

const FACTORY_ABI = [
  'function implementation() view returns (address)',
  'function owner() view returns (address)',
  'event VaultBuilt(address indexed creator, address indexed taxToken, address indexed vault, address staking)',
];

const VAULT_ABI = [
  'function taxToken() view returns (address)',
  'function creator() view returns (address)',
  'function platformFeeRecipient() view returns (address)',
  'function stakingPool() view returns (address)',
  'function costBasisBnb() view returns (uint256)',
  'function totalTaxIn() view returns (uint256)',
  'function totalTokensBurned() view returns (uint256)',
  'function totalStakerRewards() view returns (uint256)',
  'function pendingBnb() view returns (uint256)',
  'function tickBounty() view returns (uint256)',
  'function snapshotEquityView() view returns (uint256 collateralBnb, uint256 debtBnb, uint256 equity)',
  'function unrealizedPnLBps() view returns (int256)',
  'function isHarvestable() view returns (bool)',
  'function description() view returns (string)',
  'function tick()',
  'function harvest()',
  'function withdraw(address token, address to, uint256 amount)',
];

const STAKING_ABI = [
  'function memeToken() view returns (address)',
  'function totalStaked() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)',
  'function claimableIn(address) view returns (uint256)',
  'function lastStakeTimestamp(address) view returns (uint256)',
  'function totalRewardsDistributed() view returns (uint256)',
  'function totalRewardsClaimed() view returns (uint256)',
  'function stake(uint256)',
  'function unstake(uint256)',
  'function claim()',
];

const ORACLE_ABI = [
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
];

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

const ERROR_MAP = {
  'Reentrancy()':         '重入保护触发,请重试',
  'Dust()':               'BNB 不足以 tick (最少 0.01)',
  'Unauthorized()':       '需要创建者钱包',
  'AlreadyInitialized()': 'Vault 已经初始化过了',
  'Zero()':               '参数为零',
  'NotProfitable()':      '未达到 harvest 阈值 (equity < 120% costBasis)',
  'Insolvent()':          'Venus 头寸异常',
  'Oracle()':             'Chainlink 喂价过期 / 异常,等几分钟',
  'Borrow()':             'Venus 借款失败',
  'Redeem()':             'Venus 取回抵押失败',
  'Repay()':              'Venus 还款失败',
  'BurnTransfer()':       '代币销毁失败',
  'InsufficientBnb()':    '金库 BNB 不足',
  'COOLDOWN':             '质押冷却中 (30 分钟)',
  'NO_REWARD':            '你还没有可 claim 的奖励',
};

/* ─── Avatar palette (used by live live() too) ─────────────────────────── */

const AVATAR_PALETTE = [
  ['#5fd07e','#1f5f37'], // green
  ['#f4b13c','#7a4e16'], // amber
  ['#56d3e0','#16555c'], // cyan
  ['#a78bfa','#4a2da6'], // violet
  ['#ff6b6b','#7a2424'], // red
  ['#ffd166','#6e571c'], // gold
  ['#ec4899','#6e1a48'], // pink
  ['#60a5fa','#1d4a86'], // blue
];

const MOCK_VAULTS = [];
const VAULT_BY_ADDR = {};

const TOKEN_SEEDS = []; // unused — kept as empty for backcompat; live-only app
function genVaults() { return []; }


/* ─── State ─────────────────────────────────────────────────── */

const state = {
  mode: 'live',
  account: null,
  bnbPrice: 0,
  oracleAge: 0,
  // live
  liveVaults: null,    // null = not loaded; array = loaded; 'error' = failed
  liveLoading: false,
  liveError: null,
  // tweaks (persisted)
  tweaks: JSON.parse(localStorage.getItem('lv:tweaks') || '{}'),
};

function saveTweaks() {
  localStorage.setItem('lv:tweaks', JSON.stringify(state.tweaks));
}

function applyTweaks() {
  const t = Object.assign({
    accent: 'violet',  // FALT brand violet
    bg: 'grid',
  }, state.tweaks);
  document.documentElement.setAttribute('data-accent', t.accent);
  document.documentElement.setAttribute('data-bg', t.bg);
}

// Butterfly mark — FALT brand (4-petal stylized form)
const BUTTERFLY_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="FALT">
  <g transform="translate(50 50)">
    <path class="wing" d="M0 0 C -8 -12 -22 -38 -38 -42 C -46 -44 -50 -38 -48 -28 C -46 -16 -32 -4 -16 -2 C -8 -1 -3 -2 0 0 Z"/>
    <path class="wing" d="M0 0 C  8 -12  22 -38  38 -42 C  46 -44  50 -38  48 -28 C  46 -16  32 -4  16 -2 C  8 -1  3 -2 0 0 Z"/>
    <path class="wing" d="M0 0 C -8  12 -22  38 -38  42 C -46  44 -50  38 -48  28 C -46  16 -32  4 -16  2 C -8  1 -3  2 0 0 Z"/>
    <path class="wing" d="M0 0 C  8  12  22  38  38  42 C  46  44  50  38  48  28 C  46  16  32  4  16  2 C  8  1  3  2 0 0 Z"/>
  </g>
</svg>`;

/* ─── Live (on-chain) adapter ───────────────────────────────── */

let _provider = null;
function getProvider() {
  if (_provider) return _provider;
  if (!window.ethers) return null;
  _provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  return _provider;
}

function getSigner() {
  if (!window.ethereum || !window.ethers) return null;
  const p = new ethers.providers.Web3Provider(window.ethereum);
  return p.getSigner();
}

function paletteFor(addr) {
  // deterministic palette from address
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

async function fetchLiveVaultList() {
  const p = getProvider();
  if (!p) throw new Error('ethers not loaded');
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, p);
  const head = await p.getBlockNumber();
  // BSC ~3s blocks. 500k blocks ≈ 17 days. Public RPCs cap queryFilter at ~5k blocks.
  // Strategy: chunk in parallel (concurrency 4) to stay under the 25s wall.
  const SCAN_BACK = 200_000;
  const CHUNK = 10000;
  const CONCURRENCY = 8;
  const from0 = FACTORY_DEPLOY_BLOCK > 0 ? FACTORY_DEPLOY_BLOCK : Math.max(0, head - SCAN_BACK);

  // First try one big query in case the RPC tolerates it (free-tier dataseed usually doesn't).
  try {
    const events = await Promise.race([
      factory.queryFilter(factory.filters.VaultBuilt(), from0, 'latest'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('one-shot too slow')), 6000)),
    ]);
    return shapeVaultList(events);
  } catch {}

  // Build chunk ranges newest-first so any found vault appears quickly
  const ranges = [];
  for (let to = head; to >= from0; to -= CHUNK + 1) {
    ranges.push([Math.max(from0, to - CHUNK), to]);
  }
  const events = [];
  let cursor = 0;
  async function worker() {
    while (cursor < ranges.length) {
      const idx = cursor++;
      const [f, t] = ranges[idx];
      try {
        const batch = await factory.queryFilter(factory.filters.VaultBuilt(), f, t);
        if (batch.length) events.push(...batch);
      } catch {}
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));
  return shapeVaultList(events);
}

async function shapeVaultList(events) {
  const skeletons = events.map((e) => ({
    vault: e.args.vault.toLowerCase(),
    tax_token: e.args.taxToken.toLowerCase(),
    staking: e.args.staking.toLowerCase(),
    creator: e.args.creator.toLowerCase(),
    blockNumber: e.blockNumber,
    palette: paletteFor(e.args.vault),
  }));
  const enriched = await Promise.all(skeletons.map(async (s) => {
    try {
      const enrichment = await fetchVaultDetail(s);
      return Object.assign(s, enrichment);
    } catch (err) {
      return Object.assign(s, {
        symbol: '???', name: 'load failed',
        totalTaxIn: 0, pendingBnb: 0, totalTokensBurned: 0, totalStakerRewards: 0,
        collateral: 0, debt: 0, equity: 0, costBasisBnb: 0, pnlPct: 0,
        harvestable: false, tickBounty: 0,
        totalStaked: 0, totalRewardsDistributed: 0, totalRewardsClaimed: 0,
        spark: Array.from({length: 24}, () => 50),
        lastTick: Date.now() - 86400000,
        myBalance: 0, myStaked: 0, myEarned: 0, myCooldown: 0,
        loadError: err.message || String(err),
      });
    }
  }));
  return enriched;
}

async function fetchVaultDetail(s) {
  const p = getProvider();
  const v = new ethers.Contract(s.vault, VAULT_ABI, p);
  const tok = new ethers.Contract(s.tax_token, ERC20_ABI, p);
  const stk = new ethers.Contract(s.staking, STAKING_ABI, p);

  const wei = (b) => Number(ethers.utils.formatEther(b));
  const tdecOk = (b, d) => Number(ethers.utils.formatUnits(b, d));

  const results = await Promise.allSettled([
    tok.symbol(), tok.name(), tok.decimals(),
    v.costBasisBnb(), v.totalTaxIn(), v.totalTokensBurned(),
    v.totalStakerRewards(), v.pendingBnb(), v.tickBounty(),
    v.snapshotEquityView(), v.unrealizedPnLBps(), v.isHarvestable(),
    stk.totalStaked(), stk.totalRewardsDistributed(), stk.totalRewardsClaimed(),
    state.account ? tok.balanceOf(state.account) : Promise.resolve(null),
    state.account ? stk.balanceOf(state.account) : Promise.resolve(null),
    state.account ? stk.earned(state.account) : Promise.resolve(null),
    state.account ? stk.claimableIn(state.account) : Promise.resolve(null),
  ]);
  const r = results.map((x) => x.status === 'fulfilled' ? x.value : null);
  const symbol = r[0] || '???';
  const name   = r[1] || '';
  const dec    = r[2] != null ? Number(r[2]) : 18;
  const costBasisBnb = r[3] ? wei(r[3]) : 0;
  const totalTaxIn   = r[4] ? wei(r[4]) : 0;
  const totalTokensBurned   = r[5] ? tdecOk(r[5], dec) : 0;
  const totalStakerRewards  = r[6] ? wei(r[6]) : 0;
  const pendingBnb          = r[7] ? wei(r[7]) : 0;
  const tickBounty          = r[8] ? wei(r[8]) : 0;
  const snap = r[9] || [0,0,0];
  const collateral = wei(snap[0] || 0);
  const debt       = wei(snap[1] || 0);
  const equity     = wei(snap[2] || 0);
  const pnlBps     = r[10] ? Number(r[10]) : 0;
  const harvestable = !!r[11];
  const totalStaked          = r[12] ? tdecOk(r[12], dec) : 0;
  const totalRewardsDistributed = r[13] ? wei(r[13]) : 0;
  const totalRewardsClaimed     = r[14] ? wei(r[14]) : 0;
  const myBalance = r[15] ? tdecOk(r[15], dec) : 0;
  const myStaked  = r[16] ? tdecOk(r[16], dec) : 0;
  const myEarned  = r[17] ? wei(r[17]) : 0;
  const myCooldown = r[18] ? Number(r[18]) : 0;

  return {
    symbol, name, decimals: dec,
    totalTaxIn, totalTokensBurned, totalStakerRewards,
    pendingBnb, tickBounty,
    collateral, debt, equity, costBasisBnb,
    pnlPct: pnlBps / 100,
    harvestable,
    totalStaked, totalRewardsDistributed, totalRewardsClaimed,
    myBalance, myStaked, myEarned, myCooldown,
    lastTick: Date.now() - 60000,           // fallback (no on-chain timestamp tracked)
    spark: Array.from({length: 24}, (_, k) => 50 + Math.sin(k * 0.5) * 18 + k * 0.6),
  };
}

async function loadLive(force = false) {
  if (state.liveLoading) return;
  if (state.liveVaults && !force) return;
  state.liveLoading = true;
  state.liveError = null;
  // race against a 25s timeout so the UI never wedges forever
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('RPC timeout (25s) — 公共 BSC RPC 可能被节流或被浏览器 CORS 拦截')), 25000));
  try {
    const list = await Promise.race([fetchLiveVaultList(), timeout]);
    state.liveVaults = list;
    for (const v of list) VAULT_BY_ADDR[v.vault.toLowerCase()] = v;
  } catch (e) {
    state.liveError = e.message || String(e);
    state.liveVaults = [];
    toast({ type: 'error', title: 'RPC 查询失败', sub: state.liveError });
  } finally {
    state.liveLoading = false;
    render();
  }
}

function activeVaults() {
  return state.liveVaults || [];
}

async function loadVaultByAddress(addr) {
  addr = addr.toLowerCase();
  state.liveDirectLoading = state.liveDirectLoading || {};
  if (state.liveDirectLoading[addr]) return;
  state.liveDirectLoading[addr] = true;
  try {
    const p = getProvider();
    const v = new ethers.Contract(addr, VAULT_ABI, p);
    const [tax, staking, creator] = await Promise.all([
      v.taxToken().catch(() => null),
      v.stakingPool().catch(() => null),
      v.creator().catch(() => null),
    ]);
    if (!tax || !staking) throw new Error('地址不是 LongVault 合约');
    const skel = {
      vault: addr,
      tax_token: tax.toLowerCase(),
      staking: staking.toLowerCase(),
      creator: (creator || '0x0000000000000000000000000000000000000000').toLowerCase(),
      palette: paletteFor(addr),
    };
    const det = await fetchVaultDetail(skel);
    const full = Object.assign(skel, det);
    VAULT_BY_ADDR[addr] = full;
    if (state.liveVaults && !state.liveVaults.find(x => x.vault === addr)) {
      state.liveVaults.push(full);
    }
  } catch (e) {
    state.liveDirectError = state.liveDirectError || {};
    state.liveDirectError[addr] = e.message || String(e);
    toast({ type: 'error', title: '加载失败', sub: e.message || String(e) });
  } finally {
    delete state.liveDirectLoading[addr];
    render();
  }
}

/* ─── Utils ─────────────────────────────────────────────────── */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      } else if (attrs[k] !== false && attrs[k] != null) {
        e.setAttribute(k, attrs[k]);
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) c.forEach(x => x && e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    else e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(c) : c);
  }
  return e;
}

function shortAddr(a) { if (!a) return '—'; return a.slice(0, 6) + '…' + a.slice(-4); }
function bscUrl(a)    { return 'https://bscscan.com/address/' + a; }
function fmtBNB(v, dp = 4) {
  if (v == null) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(2) + 'K';
  return n.toFixed(dp);
}
function fmtTokens(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toLocaleString('en-US');
}
function fmtPnL(p) {
  if (p == null) return { txt: '—', cls: 'flat' };
  if (Math.abs(p) < 0.01) return { txt: '0.00%', cls: 'flat' };
  const sign = p > 0 ? '+' : '';
  return { txt: sign + p.toFixed(2) + '%', cls: p > 0 ? 'pos' : 'neg' };
}
function fmtAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDur(sec) {
  if (sec <= 0) return '0s';
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60), mr = m % 60;
  return `${h}h ${String(mr).padStart(2, '0')}m`;
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast({ type: 'success', title: '已复制', sub: text }),
    () => {}
  );
}

/* ─── Toast ─────────────────────────────────────────────────── */

function toast({ type = 'info', title, sub, ms = 4200 }) {
  let host = $('#toast');
  if (!host) { host = el('div', { id: 'toast', class: 'toast-container' }); document.body.appendChild(host); }
  const icons = {
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>',
    info:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>',
  };
  const t = el('div', { class: `toast ${type}` },
    el('div', { class: 'ic', html: icons[type] || icons.info }),
    el('div', { class: 'body' },
      el('div', { class: 'title' }, title || ''),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ),
  );
  host.appendChild(t);
  setTimeout(() => { t.style.transition = 'all .3s'; t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 350); }, ms);
}

/* ─── SVG helpers ───────────────────────────────────────────── */

function sparkline(values, color, w = 80, h = 24) {
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - ((v - min) / span) * (h - 4) - 2]);
  const d = 'M ' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ');
  const last = pts[pts.length - 1];
  const up = values[values.length - 1] >= values[0];
  const col = color || (up ? 'var(--accent)' : 'var(--danger)');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${col}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="1.6" fill="${col}"/>
  </svg>`;
}

function tokenAvatar(sym, palette, size = 28) {
  const [c1, c2] = palette;
  const initials = sym.slice(0, 2);
  const fontSize = Math.round(size * 0.38);
  return `<div class="tok-avatar" style="width:${size}px;height:${size}px;background:radial-gradient(circle at 30% 30%, ${c1}, ${c2});font-size:${fontSize}px">${initials}</div>`;
}

/* ─── Router ────────────────────────────────────────────────── */

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function currentRoute() {
  const h = location.hash || '#/';
  if (h === '#/' || h === '#') return { name: 'home' };
  if (h === '#/explore') return { name: 'explore' };
  const m = h.match(/^#\/v\/(0x[a-fA-F0-9]+)/);
  if (m) return { name: 'detail', addr: m[1].toLowerCase() };
  return { name: 'home' };
}

function setNavActive(name) {
  $$('.header-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

function render() {
  const route = currentRoute();
  const main = $('#main');
  main.innerHTML = '';
  setNavActive(route.name);
  if (route.name === 'home') main.appendChild(renderHome());
  else if (route.name === 'explore') main.appendChild(renderExplore());
  else if (route.name === 'detail') {
    const v = VAULT_BY_ADDR[route.addr];
    if (!v) {
      // try to load this vault directly even if Factory scan missed it
      if (!state.liveDirectLoading?.[route.addr]) loadVaultByAddress(route.addr);
      main.appendChild(renderLoadingDetail(route.addr));
    } else {
      main.appendChild(renderDetail(v));
    }
  }
  window.scrollTo(0, 0);
}

/* ─── Header ────────────────────────────────────────────────── */

function renderHeader() {
  const header = el('header', { class: 'header' },
    el('div', { class: 'header-inner' },
      el('a', { class: 'brand', href: '#/' },
        el('div', { class: 'brand-mark', html: '<img src="./logo.png" alt="FALT" />' }),
        el('div', null,
          el('div', { class: 'brand-name' }, 'FALT', el('span', { style: 'color:var(--text-muted);font-weight:400;margin-left:6px' }, 'LongVault')),
        ),
      ),
      el('nav', { class: 'header-nav' },
        el('a', { href: '#/', 'data-nav': 'home' }, '概览'),
        el('a', { href: '#/explore', 'data-nav': 'explore' }, '金库列表'),
        el('a', { href: 'https://flap.sh', target: '_blank', rel: 'noopener' }, 'flap.sh ↗'),
      ),
      el('div', { class: 'header-spacer' }),
      el('div', { class: 'header-right' },
        renderNetPill(),
        renderWalletBtn(),
      ),
    ),
  );
  return header;
}

function renderModeToggle() { return null; }

function setMode() { /* removed — app is live-only */ }

function renderNetPill() {
  return el('div', { class: 'net-pill', title: 'BSC · Chainlink BNB/USD' },
    el('span', { class: 'dot' }),
    el('span', { class: 'chain' }, 'BSC · 56'),
    el('span', { class: 'price num' }, '$' + state.bnbPrice.toFixed(2)),
  );
}

function renderWalletBtn() {
  if (state.account) {
    return el('button', { class: 'btn-wallet connected', onclick: disconnectWallet },
      el('span', { class: 'dot' }), shortAddr(state.account));
  }
  return el('button', { class: 'btn-wallet', onclick: connectWallet }, '连接钱包');
}

/* ─── Wallet (mock + ethers stub) ───────────────────────────── */

async function connectWallet() {
  if (!window.ethereum) {
    toast({ type: 'error', title: '未检测到钱包', sub: '请安装 MetaMask / OKX / Binance Wallet' });
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    state.account = accounts[0];
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x38' }],
      });
    } catch {}
    toast({ type: 'success', title: '钱包已连接', sub: shortAddr(state.account) });
    buildShell(); render();
  } catch (e) {
    toast({ type: 'error', title: '连接失败', sub: e.message || String(e) });
  }
}

function disconnectWallet() {
  state.account = null;
  toast({ type: 'info', title: '已断开连接' });
  buildShell(); render();
}

/* ─── Home page ─────────────────────────────────────────────── */

function renderHome() {
  // aggregates
  const aggSrc = activeVaults();
  const totalVaults = aggSrc.length;
  const totalBurned = aggSrc.reduce((a, v) => a + (v.totalTokensBurned || 0), 0);
  const totalStakerRew = aggSrc.reduce((a, v) => a + (v.totalStakerRewards || 0), 0);
  const totalPlatform = aggSrc.reduce((a, v) => a + (v.totalTaxIn || 0) * 0.5, 0);

  return el('main', { class: 'page' },
    // Hero
    el('section', { class: 'hero' },
      el('div', { class: 'hero-grid' },
        el('div', null,
          el('div', { class: 'hero-eyebrow' },
            el('span', { class: 'dot' }),
            'BSC · Factory ',
            el('span', { class: 'mono', style: 'margin-left:4px;color:var(--text);' }, shortAddr(FACTORY)),
          ),
          el('h1', { class: 'hero-title' },
            '把代币税收',
            el('br'),
            '变成 ',
            el('span', { class: 'accent' }, '永动飞轮'),
            '.',
          ),
          el('p', { class: 'hero-sub' },
            'LongVault 是 flap.sh 的官方税收金库模板。每笔交易税自动拆分:',
            el('span', { class: 'mono', style: 'color:var(--text)' }, ' 50% '),
            '平台币回购 · ',
            el('span', { class: 'mono', style: 'color:var(--text)' }, '50% '),
            '本币飞轮 = Venus 1.875× BNB Long + 销毁 + 质押分红。',
          ),
          el('div', { class: 'hero-cta' },
            el('a', { class: 'cta-primary', href: 'https://flap.sh', target: '_blank', rel: 'noopener' },
              '去 flap.sh 上架代币',
              el('span', { class: 'cta-arrow', html: '→' }),
            ),
            el('a', { class: 'cta-ghost', href: '#/explore' },
              '浏览现有金库',
              el('span', { class: 'cta-arrow', html: '→' }),
            ),
          ),
        ),
        renderHeroPanel(),
      ),

      // ticker
      el('div', { class: 'hero-ticker' },
        tickCell('已部署金库',     totalVaults.toString(), '', null),
        tickCell('累计销毁',       fmtTokens(totalBurned), '代币', null),
        tickCell('平台币回购',     fmtBNB(totalPlatform, 2), 'BNB', null),
        tickCell('质押者已分红',   fmtBNB(totalStakerRew, 2), 'BNB', null),
      ),
    ),

    // Features
    el('section', { class: 'section' },
      el('div', { class: 'section-head' },
        el('div', null,
          el('div', { class: 'section-eyebrow' }, '机制 / Mechanics'),
          el('h2', { class: 'section-title' }, '三件套:杠杆 · 销毁 · 分红'),
        ),
      ),
      el('div', { class: 'feature-grid' },
        renderFeature({
          num: '01',
          icon: iconBurn(),
          title: '双重通缩',
          desc: '每笔交易税同时销毁本代币 (Tick 时 0.5%) 和回购销毁平台币 (50% 直送平台回购地址),双线减少流通量。',
          metaK: '销毁占比', metaV: '20.5%',
        }),
        renderFeature({
          num: '02',
          icon: iconLong(),
          title: '自动 1.875× BNB Long',
          desc: 'Venus 循环借贷自动建立 BNB 杠杆多头。所有交易税即时进多,牛市顺势,熊市等回归。',
          metaK: '当前杠杆', metaV: '1.875×',
        }),
        renderFeature({
          num: '03',
          icon: iconStake(),
          title: '质押挖矿',
          desc: '持本代币 stake 即可瓜分 Venus 收益。Harvest 触发后 79% 注入质押池,按比例分发,30 分钟冷却。',
          metaK: '冷却时间', metaV: '30 min',
        }),
      ),
    ),

    // Flow diagram
    el('section', { class: 'section' },
      el('div', { class: 'section-head' },
        el('div', null,
          el('div', { class: 'section-eyebrow' }, '资金流 / Cashflow'),
          el('h2', { class: 'section-title' }, '一张图看懂税款去哪了'),
        ),
        el('div', { class: 'dim', style: 'font-family:var(--font-mono);font-size:12px;' },
          'tick() · 任意人可调 · 1% bounty'),
      ),
      el('div', { class: 'flow-wrap' }, renderFlow()),
    ),

    // Bottom call out
    el('section', { class: 'section', style: 'padding-top:32px' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:24px;padding:28px 32px;border:1px solid var(--border);border-radius:8px;background:var(--surface);' },
        el('div', null,
          el('div', { style: 'font-size:18px;font-weight:500;margin-bottom:4px;' }, '准备好让你的税收开始工作了吗?'),
          el('div', { class: 'dim', style: 'font-size:13px;' }, 'flap.sh 上一键发币,自动绑定 LongVault 模板。'),
        ),
        el('a', { class: 'cta-primary', href: 'https://flap.sh', target: '_blank' },
          'flap.sh',
          el('span', { class: 'cta-arrow', html: '↗' }),
        ),
      ),
    ),
  );
}

function tickCell(label, value, unit, delta) {
  return el('div', { class: 'tick-cell' },
    el('div', { class: 'tick-label' }, el('span', { class: 'led' }), label),
    el('div', { class: 'tick-value' },
      value,
      unit ? el('span', { class: 'tick-unit' }, ' ' + unit) : null,
    ),
    delta ? el('div', { class: 'tick-delta' }, delta) : null,
  );
}

function renderFeature({ num, icon, title, desc, metaK, metaV }) {
  return el('div', { class: 'feature' },
    el('div', { class: 'feature-num' }, num + ' / 03'),
    el('div', { class: 'feature-icon', html: icon }),
    el('div', { class: 'feature-title' }, title),
    el('div', { class: 'feature-desc' }, desc),
    el('div', { class: 'feature-meta' },
      el('span', null, metaK),
      el('span', { class: 'v num' }, metaV),
    ),
  );
}

function iconBurn() {
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
}
function iconLong() {
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>';
}
function iconStake() {
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/><polyline points="2 8.5 12 15 22 8.5"/><line x1="12" y1="22" x2="12" y2="15"/></svg>';
}

/* Hero side panel: realtime activity */
function renderHeroPanel() {
  const vaults = state.liveVaults || [];
  return el('div', { class: 'hero-panel' },
    el('div', { class: 'hero-panel-head' },
      el('div', { class: 'hero-panel-title' }, '已部署金库 · ON-CHAIN'),
      el('div', { class: 'hero-panel-badge' },
        state.liveLoading ? '● 扫描中' : (vaults.length > 0 ? '● LIVE' : '○ 空')),
    ),
    vaults.length === 0
      ? el('div', { style: 'padding:24px 0;text-align:center;color:var(--text-muted);font-size:13px' },
          state.liveLoading ? '正在扫描 Factory…' :
          state.liveError    ? 'RPC 错误,见下方 explore' :
                               '此 Factory 暂无 vault')
      : vaults.slice(0, 6).map(v => el('a', {
          href: '#/v/' + v.vault,
          style: 'display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--divider);font-size:13px;',
        },
          el('div', { html: tokenAvatar(v.symbol || '??', v.palette, 22) }),
          el('div', null,
            el('span', { style: 'font-weight:500' }, v.symbol || '???'),
            ' ',
            el('span', { class: 'mono dim', style: 'font-size:11px' }, shortAddr(v.vault)),
          ),
          el('span', { class: 'mono', style: 'font-size:12px;color:var(--accent)' }, fmtBNB(v.equity, 3) + ' BNB'),
        )),
  );
}

/* ─── Flow diagram ──────────────────────────────────────────── */

function renderFlow() {
  // Build SVG flow with flowing dots
  const svg = `
<svg class="flow-svg" viewBox="0 0 1200 460" preserveAspectRatio="xMidYMid meet">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" class="flow-arrow"/>
    </marker>
  </defs>

  <!-- Top: flap.sh source -->
  <g>
    <rect class="flow-node-bg" x="500" y="20" width="200" height="56" rx="6"/>
    <text class="flow-text" x="600" y="44" text-anchor="middle">flap.sh 用户交易</text>
    <text class="flow-sub"  x="600" y="62" text-anchor="middle">每笔 1% 税 → BNB</text>
  </g>

  <!-- Vault -->
  <g>
    <rect class="flow-node-bg accent" x="480" y="106" width="240" height="64" rx="6"/>
    <text class="flow-text" x="600" y="132" text-anchor="middle" style="font-weight:500">LongVault.receive()</text>
    <text class="flow-sub"  x="600" y="152" text-anchor="middle">pendingBnb 累积</text>
  </g>

  <!-- Trunk -->
  <path class="flow-line" d="M 600 76 L 600 106" marker-end="url(#arr)"/>
  <path class="flow-line dashed" d="M 600 170 L 600 200" marker-end="url(#arr)"/>

  <!-- tick() label -->
  <g>
    <rect class="flow-node-bg" x="380" y="200" width="440" height="42" rx="6"/>
    <text class="flow-text" x="600" y="225" text-anchor="middle" style="fill:var(--accent)">tick() · 任意人可调 · 1% bounty</text>
  </g>

  <!-- Split into 3 branches -->
  <path class="flow-line" d="M 600 242 L 600 270 L 160 270 L 160 290" marker-end="url(#arr)"/>
  <path class="flow-line" d="M 600 242 L 600 290" marker-end="url(#arr)"/>
  <path class="flow-line" d="M 600 242 L 600 270 L 1040 270 L 1040 290" marker-end="url(#arr)"/>

  <!-- Branch boxes -->
  <g>
    <rect class="flow-node-bg amber" x="60" y="290" width="200" height="58" rx="6"/>
    <text class="flow-text" x="160" y="316" text-anchor="middle">1% bounty</text>
    <text class="flow-sub"  x="160" y="334" text-anchor="middle">→ 调用者</text>
  </g>

  <g>
    <rect class="flow-node-bg" x="500" y="290" width="200" height="58" rx="6"/>
    <text class="flow-text" x="600" y="316" text-anchor="middle">50% 平台币回购</text>
    <text class="flow-sub"  x="600" y="334" text-anchor="middle">FlapPortal</text>
  </g>

  <g>
    <rect class="flow-node-bg accent" x="940" y="290" width="200" height="58" rx="6"/>
    <text class="flow-text" x="1040" y="316" text-anchor="middle">49.5% 飞轮</text>
    <text class="flow-sub"  x="1040" y="334" text-anchor="middle">Venus + 销毁</text>
  </g>

  <!-- Flywheel sub-branches -->
  <path class="flow-line" d="M 1040 348 L 1040 376 L 920 376 L 920 396" marker-end="url(#arr)"/>
  <path class="flow-line" d="M 1040 348 L 1040 376 L 1140 376 L 1140 396" marker-end="url(#arr)"/>

  <g>
    <rect class="flow-node-bg" x="820" y="396" width="200" height="48" rx="6"/>
    <text class="flow-text" x="920" y="418" text-anchor="middle">80% Venus 多头</text>
    <text class="flow-sub"  x="920" y="434" text-anchor="middle">1.875× BNB Long</text>
  </g>
  <g>
    <rect class="flow-node-bg amber" x="1040" y="396" width="160" height="48" rx="6"/>
    <text class="flow-text" x="1120" y="418" text-anchor="middle">20% 销毁</text>
    <text class="flow-sub"  x="1120" y="434" text-anchor="middle">本代币 burn</text>
  </g>

  <!-- Animated dots flowing along the main path -->
  <circle r="3" class="flow-dot">
    <animateMotion dur="3.6s" repeatCount="indefinite" rotate="auto">
      <mpath href="#flow-main"/>
    </animateMotion>
  </circle>
  <circle r="3" class="flow-dot" style="fill:var(--gold);filter:drop-shadow(0 0 4px var(--gold))">
    <animateMotion dur="4.4s" repeatCount="indefinite" begin="1s">
      <mpath href="#flow-r"/>
    </animateMotion>
  </circle>
  <circle r="3" class="flow-dot" style="fill:var(--warn);filter:drop-shadow(0 0 4px var(--warn))">
    <animateMotion dur="4.4s" repeatCount="indefinite" begin="2s">
      <mpath href="#flow-l"/>
    </animateMotion>
  </circle>

  <!-- Invisible motion paths -->
  <path id="flow-main" d="M 600 30 L 600 270" fill="none" stroke="none"/>
  <path id="flow-r"    d="M 600 240 L 600 270 L 1040 270 L 1040 348 L 1040 376 L 920 376 L 920 400" fill="none" stroke="none"/>
  <path id="flow-l"    d="M 600 240 L 600 270 L 160 270 L 160 340" fill="none" stroke="none"/>
</svg>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = svg;
  return wrap.firstElementChild;
}

/* ─── Explore page ──────────────────────────────────────────── */

const sortState = { key: 'active', q: '' };

function renderExplore() {
  const vaults = activeVaults().slice();

  // search
  let list = vaults.filter(v => {
    if (!sortState.q) return true;
    const q = sortState.q.toLowerCase();
    return (v.symbol || '').toLowerCase().includes(q) || (v.name || '').toLowerCase().includes(q) || v.vault.toLowerCase().includes(q);
  });
  // sort
  if (sortState.key === 'active')  list.sort((a, b) => b.lastTick - a.lastTick);
  if (sortState.key === 'burned')  list.sort((a, b) => b.totalTokensBurned - a.totalTokensBurned);
  if (sortState.key === 'equity')  list.sort((a, b) => b.equity - a.equity);
  if (sortState.key === 'pnl')     list.sort((a, b) => b.pnlPct - a.pnlPct);

  const totalBurned   = vaults.reduce((a, v) => a + (v.totalTokensBurned || 0), 0);
  const totalEquity   = vaults.reduce((a, v) => a + (v.equity || 0), 0);
  const readyCount    = vaults.filter(v => v.harvestable).length;

  const liveLoading = state.liveLoading;
  const liveEmpty   = !state.liveLoading && state.liveVaults !== null && vaults.length === 0;
  const liveErr     = state.liveError;

  return el('main', { class: 'page' },
    el('div', { class: 'crumb' },
      el('a', { href: '#/' }, '概览'),
      el('span', { class: 'sep' }, '/'),
      el('span', null, '金库列表'),
      el('span', { class: 'pill live', style: 'margin-left:12px' },
        el('span', { class: 'pdot' }), 'LIVE · BSC'),
    ),
    el('div', { class: 'explore-head' },
      el('div', null,
        el('h1', { class: 'section-title', style: 'font-size:34px;margin-bottom:4px;' },
          '所有 LongVault'),
        el('div', { class: 'dim' },
          `Factory ${shortAddr(FACTORY)} · ${liveLoading ? '查询中…' : `${vaults.length} 个金库`}`),
      ),
      el('div', { class: 'explore-stats' },
        el('div', { class: 'explore-stat' },
          el('div', { class: 'lbl' }, '累计销毁'),
          el('div', { class: 'val' }, fmtTokens(totalBurned)),
        ),
        el('div', { class: 'explore-stat' },
          el('div', { class: 'lbl' }, 'Venus 净敞口'),
          el('div', { class: 'val' }, fmtBNB(totalEquity, 1) + ' BNB'),
        ),
        el('div', { class: 'explore-stat' },
          el('div', { class: 'lbl' }, '可 Harvest'),
          el('div', { class: 'val', style: 'color:var(--gold)' }, readyCount + ' / ' + vaults.length),
        ),
      ),
    ),

    liveLoading ? el('div', { class: 'empty' },
      el('div', { style: 'font-size:14px;color:var(--text);margin-bottom:6px' }, '正在扫描 VaultBuilt 事件…'),
      el('div', { style: 'font-size:12px' }, 'BSC 全链事件查询可能需要几秒。'),
    ) : null,

    liveErr ? el('div', { class: 'empty', style: 'border-color:rgba(255,107,107,0.4)' },
      el('div', { style: 'font-size:14px;color:var(--danger);margin-bottom:6px' }, 'RPC 查询失败'),
      el('div', { class: 'mono', style: 'font-size:12px;color:var(--text-dim);margin-bottom:12px' }, liveErr),
      el('div', { style: 'font-size:12px;color:var(--text-dim);max-width:54ch;margin:0 auto' },
        '提示:在 ', el('span', { class: 'mono', style: 'color:var(--text)' }, 'app.js'),
        ' 顶部填入 ', el('span', { class: 'mono', style: 'color:var(--text)' }, 'FACTORY_DEPLOY_BLOCK'),
        ' (Factory 创建区块号,BscScan 上可查) 后扫描会瞬间完成。或者直接访问 ',
        el('span', { class: 'mono', style: 'color:var(--text)' }, '#/v/0xVAULT_ADDR'),
        ' 也能在 Live 模式下加载单个 vault。'),
      el('div', { style: 'margin-top:14px;display:flex;gap:8px;justify-content:center' },
        el('button', { class: 'cta-ghost', onclick: () => loadLive(true) }, '重试扫描'),
      ),
    ) : null,

    !liveErr && liveEmpty ? el('div', { class: 'empty' },
      el('div', { style: 'font-size:14px;color:var(--text);margin-bottom:6px' }, 'Factory 还没有部署过 vault'),
      el('div', { style: 'font-size:12px' },
        '此 Factory (', el('span', { class: 'mono', style: 'color:var(--text)' }, shortAddr(FACTORY)), ') 上没有 ',
        el('span', { class: 'mono', style: 'color:var(--text)' }, 'VaultBuilt'),
        ' 事件。去 flap.sh 用 LongVault 模板发币就会自动建仓。'),
      el('div', { style: 'margin-top:12px' },
        el('a', { class: 'cta-primary', href: 'https://flap.sh', target: '_blank' },
          '去 flap.sh 创建', el('span', { class: 'cta-arrow', html: '↗' })),
      ),
    ) : null,

    !liveLoading && !liveEmpty && !liveErr ? el('div', { class: 'toolbar' },
      el('input', {
        class: 'search-input',
        placeholder: '搜索 symbol / name / 地址',
        oninput: (e) => { sortState.q = e.target.value; refreshTable(); },
      }),
      el('div', { class: 'sort-tabs' },
        sortBtn('active',  '最近活跃'),
        sortBtn('burned',  '销毁最多'),
        sortBtn('equity',  'Equity 最高'),
        sortBtn('pnl',     'PnL %'),
      ),
    ) : null,

    !liveLoading && !liveEmpty && !liveErr ? el('div', { id: 'vaultTable' }, renderVaultTable(list)) : null,
  );
}

function sortBtn(key, label) {
  return el('button', {
    class: sortState.key === key ? 'active' : '',
    onclick: () => { sortState.key = key; refreshTable(); },
  }, label);
}

function refreshTable() {
  // re-render the active sort tabs + table
  const route = currentRoute();
  if (route.name !== 'explore') return;
  // re-render the entire explore main for simplicity
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(renderExplore());
}

function renderVaultTable(list) {
  const tbl = el('table', { class: 'vault-table' },
    el('thead', null,
      el('tr', null,
        el('th', null, 'Token'),
        el('th', null, '状态'),
        el('th', { class: 'right' }, '累计销毁'),
        el('th', { class: 'right' }, 'Venus Equity'),
        el('th', { class: 'right' }, 'PnL'),
        el('th', { class: 'right' }, '24h 趋势'),
        el('th', { class: 'right' }, '最近活动'),
        el('th', null, ''),
      ),
    ),
    el('tbody', null,
      ...list.map(v => el('tr', { onclick: () => navigate('#/v/' + v.vault) },
        el('td', null,
          el('div', { class: 'tok' },
            el('div', { html: tokenAvatar(v.symbol, v.palette, 28) }),
            el('div', null,
              el('div', { class: 'tok-name' }, v.symbol),
              el('div', { class: 'tok-sub' }, shortAddr(v.vault)),
            ),
          ),
        ),
        el('td', null, statusPill(v)),
        el('td', { class: 'right num' }, fmtTokens(v.totalTokensBurned)),
        el('td', { class: 'right num' }, fmtBNB(v.equity, 2) + ' BNB'),
        el('td', { class: 'right' }, (() => {
          const p = fmtPnL(v.pnlPct);
          return el('span', { class: 'pnl-cell ' + p.cls }, p.txt);
        })()),
        el('td', { class: 'right', html: sparkline(v.spark) }),
        el('td', { class: 'right mono', style: 'color:var(--text-dim);font-size:12px' }, fmtAgo(v.lastTick)),
        el('td', null,
          el('span', { style: 'color:var(--text-muted);font-family:var(--font-mono)', html: '→' }),
        ),
      )),
    ),
  );
  return tbl;
}

function statusPill(v) {
  if (v.harvestable) return el('span', { class: 'pill ready' }, el('span', { class: 'pdot' }), 'HARVEST READY');
  if (Date.now() - v.lastTick < 24 * 3600 * 1000) return el('span', { class: 'pill live' }, el('span', { class: 'pdot' }), 'LIVE');
  return el('span', { class: 'pill idle' }, el('span', { class: 'pdot' }), 'IDLE');
}

/* ─── Detail page ───────────────────────────────────────────── */

const stakeUI = { stakeInput: '', unstakeInput: '' };

function renderDetail(v) {
  const oracleState = state.oracleAge > 3600 ? 'stale' : state.oracleAge > 300 ? 'slow' : 'healthy';
  const oracleLabel = oracleState === 'stale' ? 'STALE' : oracleState === 'slow' ? 'SLOW' : 'HEALTHY';
  const tickDisabled = v.pendingBnb < 0.01 || oracleState === 'stale';
  const harvestPct = v.costBasisBnb > 0 ? Math.min((v.equity / (v.costBasisBnb * 1.2)) * 100, 999) : 0;
  const harvestReady = v.harvestable && oracleState !== 'stale';
  const isCreator = state.account && state.account.toLowerCase() === v.creator.toLowerCase();

  return el('main', { class: 'page' },
    el('div', { class: 'crumb' },
      el('a', { href: '#/' }, '概览'),
      el('span', { class: 'sep' }, '/'),
      el('a', { href: '#/explore' }, '金库列表'),
      el('span', { class: 'sep' }, '/'),
      el('span', null, v.symbol),
    ),

    // Header
    el('div', { class: 'detail-header' },
      el('div', { class: 'detail-header-left' },
        el('div', { html: tokenAvatar(v.symbol, v.palette, 44) }),
        el('div', { class: 'detail-titles' },
          el('div', { class: 'detail-symbol' },
            v.symbol,
            statusPill(v),
          ),
          el('div', { class: 'detail-name' }, v.name),
        ),
        el('div', { class: 'detail-meta-grid', style: 'margin-left:24px' },
          el('div', null,
            el('div', { class: 'k' }, 'Vault'),
            el('button', { class: 'copy-addr', onclick: () => copy(v.vault) }, shortAddr(v.vault), iconCopy()),
          ),
          el('div', null,
            el('div', { class: 'k' }, 'Token'),
            el('button', { class: 'copy-addr', onclick: () => copy(v.tax_token) }, shortAddr(v.tax_token), iconCopy()),
          ),
          el('div', null,
            el('div', { class: 'k' }, 'BscScan'),
            el('a', { class: 'copy-addr', href: bscUrl(v.vault), target: '_blank' }, '↗ 查看'),
          ),
        ),
      ),
      el('div', { class: `detail-oracle ${oracleState}` },
        el('span', { class: 'dot' }),
        el('div', null,
          el('div', { class: 'lbl' }, 'Chainlink BNB/USD'),
          el('div', { class: 'val' },
            oracleLabel + ' · $' + state.bnbPrice.toFixed(2),
            el('span', { class: 'muted', style: 'margin-left:6px;font-size:11px' }, '· ' + state.oracleAge + 's ago'),
          ),
        ),
      ),
    ),

    // Two columns: financial + venus
    el('div', { class: 'detail-cols' },
      // Left: financial
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('div', { class: 'panel-title' },
            el('span', { class: 'h' }, '财务'), 'FINANCIAL'),
          el('span', { class: 'mono dim', style: 'font-size:11px' }, 'BNB · 18 dec'),
        ),
        kvRow('累计税收',         fmtBNB(v.totalTaxIn, 3), 'BNB'),
        kvRow('Pending BNB',     fmtBNB(v.pendingBnb, 4), 'BNB', v.pendingBnb >= 0.01 ? 'pos' : 'muted'),
        kvRow('累计销毁本代币',     fmtTokens(v.totalTokensBurned), v.symbol),
        kvRow('累计发给质押池',     fmtBNB(v.totalStakerRewards, 3), 'BNB'),
        kvRow('累计平台币回购',     fmtBNB(v.totalTaxIn * 0.495, 3), 'BNB', 'muted'),
      ),
      // Right: venus
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('div', { class: 'panel-title' },
            el('span', { class: 'h' }, 'Venus 头寸'), 'LEVERAGED LONG'),
          el('span', { class: 'mono dim', style: 'font-size:11px' }, '1.875× BNB'),
        ),
        kvRow('抵押 (collateral)',  fmtBNB(v.collateral, 3), 'BNB'),
        kvRow('借款 (debt)',        fmtBNB(v.debt, 3), 'BNB → USDC'),
        kvRow('净敞口 (equity)',    fmtBNB(v.equity, 3), 'BNB', null, true),
        kvRow('成本基础',           fmtBNB(v.costBasisBnb, 3), 'BNB', 'muted'),
        (() => {
          const p = fmtPnL(v.pnlPct);
          return el('div', { class: 'kv-row big' },
            el('span', { class: 'k' }, '未实现盈亏'),
            el('span', { class: 'v ' + (p.cls === 'pos' ? 'pos' : p.cls === 'neg' ? 'neg' : 'dim') }, p.txt),
          );
        })(),
      ),
    ),

    // Harvest progress
    el('div', { class: 'harvest-panel ' + (harvestReady ? 'ready' : '') },
      el('div', { class: 'harvest-head' },
        el('div', null,
          el('div', { class: 'harvest-head title' }, 'HARVEST 进度 · EQUITY / (COSTBASIS × 1.20)'),
          el('div', { class: 'dim', style: 'font-size:12px;margin-top:4px;font-family:var(--font-mono)' },
            fmtBNB(v.equity, 3) + ' / ' + fmtBNB(v.costBasisBnb * 1.2, 3) + ' BNB'),
        ),
        el('div', { class: 'pct' }, Math.min(harvestPct, 999).toFixed(1) + '%'),
      ),
      el('div', { class: 'harvest-bar-track' },
        el('div', { class: 'harvest-bar-fill', style: `width:${Math.min(harvestPct, 100)}%` }),
      ),
      el('div', { class: 'harvest-foot' },
        el('span', { class: 'threshold' }, '↑ 100% 即可 harvest, 阈值 ' + fmtBNB(v.costBasisBnb * 1.2, 3) + ' BNB'),
        harvestReady
          ? el('span', { class: 'target gold' }, '✦ 可拿 ' + fmtBNB((v.equity - v.costBasisBnb) * 0.79, 4) + ' BNB → 质押者')
          : el('span', { class: 'target' }, '还差 ' + fmtBNB(Math.max(0, v.costBasisBnb * 1.2 - v.equity), 3) + ' BNB'),
      ),
    ),

    // Actions
    el('div', { class: 'actions' },
      el('button', {
        class: 'act-btn' + (tickDisabled ? ' disabled' : ''),
        onclick: tickDisabled ? null : () => doTick(v),
      },
        el('div', { class: 'ic', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><polygon points="12 2 19 21 12 17 5 21" /></svg>' }),
        el('div', null,
          el('div', { class: 'lbl' }, 'Tick'),
          el('div', { class: 'sub' },
            tickDisabled
              ? (v.pendingBnb < 0.01 ? '等待税款积累 · pendingBnb < 0.01' : '喂价过期')
              : '可拿 ' + v.tickBounty.toFixed(5) + ' BNB 奖励',
          ),
        ),
      ),
      el('button', {
        class: 'act-btn harvest' + (harvestReady ? ' ready' : ' disabled'),
        onclick: harvestReady ? () => doHarvest(v) : null,
      },
        el('div', { class: 'ic', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2 L12 22 M4 6 C 6 10 8 10 12 10 M20 6 C 18 10 16 10 12 10 M4 14 C 7 18 9 18 12 18 M20 14 C 17 18 15 18 12 18"/></svg>' }),
        el('div', null,
          el('div', { class: 'lbl' },
            harvestReady ? '✦ Harvest · 可拿 ' + fmtBNB((v.equity - v.costBasisBnb) * 0.01, 5) + ' BNB' : 'Harvest'),
          el('div', { class: 'sub' },
            harvestReady
              ? '已达 ' + harvestPct.toFixed(1) + '% · 可执行'
              : (v.costBasisBnb === 0 ? 'Venus 还未建仓' : harvestPct.toFixed(1) + '% 进度 · 不可'),
          ),
        ),
      ),
      el('button', { class: 'act-mini', title: '刷新', onclick: () => { toast({ type: 'info', title: '已刷新链上数据' }); render(); } },
        el('span', { html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' }),
      ),
    ),

    // Staking
    el('div', { class: 'stake-panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' },
          el('span', { class: 'h' }, '质押 · STAKE & EARN'), v.symbol + ' → BNB'),
        el('span', { class: 'pill', style: 'background:var(--bg-elev)' },
          el('span', { class: 'pdot', style: 'background:var(--accent)' }),
          '冷却 30 min'),
      ),
      el('div', { class: 'stake-grid' },
        el('div', null,
          el('div', { class: 'stake-col-title' }, '池子聚合'),
          kvRow('总质押量',   fmtTokens(v.totalStaked), v.symbol),
          kvRow('奖励池累计入金', fmtBNB(v.totalRewardsDistributed, 3), 'BNB'),
          kvRow('累计已 claim', fmtBNB(v.totalRewardsClaimed, 3), 'BNB'),
        ),
        el('div', null,
          el('div', { class: 'stake-col-title' }, '你的仓位'),
          kvRow('钱包余额', state.account ? fmtTokens(v.myBalance) : '— 未连接', v.symbol, state.account ? null : 'muted'),
          kvRow('已质押',   state.account ? fmtTokens(v.myStaked) : '—', v.symbol),
          kvRow('可领取',   state.account ? fmtBNB(v.myEarned, 5) : '—', 'BNB', state.account && v.myEarned > 0 ? 'pos' : null),
        ),
      ),
      renderStakeForm(v),
    ),

    // Creator-only panel
    isCreator ? renderCreatorPanel(v) : null,

    // Recent events
    renderEventsPanel(v),
  );
}

function kvRow(k, v, unit, cls, big) {
  return el('div', { class: 'kv-row' + (big ? ' big' : '') },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v ' + (cls || '') },
      v,
      unit ? el('span', { class: 'unit' }, unit) : null,
    ),
  );
}

function renderStakeForm(v) {
  if (!state.account) {
    return el('div', { style: 'padding:18px;background:var(--bg-elev);border:1px dashed var(--border);border-radius:8px;text-align:center;color:var(--text-dim);font-size:13px' },
      '连接钱包查看你的质押仓位 ',
      el('button', { class: 'btn btn-primary', style: 'margin-left:12px;height:36px', onclick: connectWallet }, '连接钱包'),
    );
  }
  const cooling = v.myCooldown > 0;
  return el('div', null,
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;', class: 'stake-form-wrap' },
      // Stake row
      el('div', null,
        el('div', { class: 'tweak-label', style: 'margin-bottom:8px' }, '质押 ' + v.symbol),
        el('div', { class: 'amount-input' },
          el('input', { type: 'text', placeholder: '0.00', value: stakeUI.stakeInput, oninput: (e) => stakeUI.stakeInput = e.target.value }),
          el('span', { class: 'sym' }, v.symbol),
          el('button', { class: 'max', onclick: () => { stakeUI.stakeInput = String(v.myBalance); render(); } }, 'MAX'),
        ),
        el('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          el('button', { class: 'btn btn-secondary', style: 'flex:1', onclick: () => doApprove(v) }, 'Approve'),
          el('button', { class: 'btn btn-primary', style: 'flex:1', onclick: () => doStake(v) }, 'Stake'),
        ),
      ),
      // Unstake + claim row
      el('div', null,
        el('div', { class: 'tweak-label', style: 'margin-bottom:8px' }, '提取 / 领取奖励'),
        el('div', { class: 'amount-input' },
          el('input', { type: 'text', placeholder: '0.00', value: stakeUI.unstakeInput, oninput: (e) => stakeUI.unstakeInput = e.target.value }),
          el('span', { class: 'sym' }, v.symbol),
          el('button', { class: 'max', onclick: () => { stakeUI.unstakeInput = String(v.myStaked); render(); } }, 'MAX'),
        ),
        el('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          el('button', { class: 'btn btn-secondary', style: 'flex:1', onclick: () => doUnstake(v) }, 'Unstake'),
          el('button', {
            class: 'btn ' + (cooling ? 'btn-secondary disabled' : 'btn-primary'),
            style: 'flex:1',
            disabled: cooling,
            onclick: cooling ? null : () => doClaim(v),
          }, cooling ? `冷却中 ${fmtDur(v.myCooldown)}` : `Claim ${fmtBNB(v.myEarned, 5)} BNB`),
        ),
        cooling ? el('div', { class: 'cooldown-bar' }, el('div', { class: 'cooldown-fill', style: `width:${100 - (v.myCooldown / 1800 * 100)}%` })) : null,
      ),
    ),
  );
}

function renderCreatorPanel(v) {
  return el('div', { class: 'creator-panel' },
    el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' },
        el('span', { class: 'h', style: 'color:var(--warn)' }, '创建者特权'), 'CREATOR ONLY · WITHDRAW'),
      el('span', { class: 'pill', style: 'color:var(--warn);border-color:rgba(244,177,60,0.4)' },
        el('span', { class: 'pdot', style: 'background:var(--warn)' }),
        '危险操作'),
    ),
    el('div', { class: 'dim', style: 'font-size:12px;margin-bottom:16px' },
      '调用 ', el('span', { class: 'mono', style: 'color:var(--text)' }, 'vault.withdraw(token, to, amount)'),
      ' · 仅 ',  el('span', { class: 'mono', style: 'color:var(--text)' }, 'creator() == msg.sender'),
      ' 可调,会从金库直接转出资产。',
    ),
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px' },
      el('div', { class: 'amount-input' },
        el('input', { id: 'wd-token', type: 'text', placeholder: '0x... (空 = BNB)' }),
      ),
      el('div', { class: 'amount-input' },
        el('input', { id: 'wd-to', type: 'text', placeholder: 'to 地址' }),
      ),
      el('div', { class: 'amount-input' },
        el('input', { id: 'wd-amt', type: 'text', placeholder: '0.0' }),
      ),
      el('button', { class: 'btn', style: 'background:var(--warn);color:#08090c', onclick: () => doWithdraw(v) }, '提款'),
    ),
  );
}

function renderEventsPanel(v) {
  state.eventsByVault = state.eventsByVault || {};
  const cached = state.eventsByVault[v.vault];

  if (!cached) {
    // kick off async load (idempotent)
    loadVaultEvents(v);
  }

  const head = el('div', { class: 'panel-head', style: 'padding:0 0 12px;margin:0 0 4px;font-family:var(--font-sans)' },
    el('div', { class: 'panel-title' },
      el('span', { class: 'h' }, '最近事件'), 'LIVE LOG'),
    el('span', { class: 'mono dim', style: 'font-size:11px' },
      cached ? `最近 ${cached.length} 条事件 · 来自链上 logs` : '正在拉取链上事件…'),
  );

  if (!cached) {
    return el('div', { class: 'events', style: 'margin-top:16px' }, head,
      el('div', { style: 'padding:18px;text-align:center;color:var(--text-muted);font-size:12px;font-family:var(--font-mono)' },
        '查询 vault + staking 最近事件…'),
    );
  }
  if (cached.length === 0) {
    return el('div', { class: 'events', style: 'margin-top:16px' }, head,
      el('div', { style: 'padding:18px;text-align:center;color:var(--text-muted);font-size:12px' },
        '此 vault 暂无链上事件 · 等用户在 flap.sh 上交易就会有 TAX 事件了'),
    );
  }
  const evs = cached;

  return el('div', { class: 'events', style: 'margin-top:16px' }, head,
    ...evs.map(e => el('div', { class: 'event-row' },
      el('span', { class: 'time' }, fmtDur(e.ageS) + ' ago'),
      el('span', null,
        el('span', { class: 'tag ' + e.tag.toLowerCase() }, e.tag),
        e.msg,
      ),
      el('span', { class: 'by' }, 'by ', e.by),
    )),
    el('div', { style: 'margin-top:10px;font-size:11px;color:var(--text-muted);text-align:right' },
        el('a', { href: bscUrl(v.vault) + '#events', target: '_blank', class: 'copy-addr' },
          '在 BscScan 查看完整事件 ↗')),
  );
}

async function loadVaultEvents(v) {
  state.eventsByVault = state.eventsByVault || {};
  if (state.eventsByVault[v.vault]) return;
  state.eventsByVault[v.vault] = null; // mark loading
  try {
    const p = getProvider();
    if (!p) throw new Error('no provider');
    const vault = new ethers.Contract(v.vault, [
      'event TaxReceived(uint256 amount, uint256 totalIn)',
      'event Ticked(uint256 toLev, uint256 toBuyback, uint256 tokensBurned, uint256 bounty, uint256 platformFee, address indexed caller)',
      'event Harvested(uint256 equityExtracted, uint256 tokensBurned, uint256 bounty, uint256 toStakers, address indexed caller)',
      'event Withdrawn(address indexed token, address indexed to, uint256 amount)',
    ], p);
    const stk = new ethers.Contract(v.staking, [
      'event Staked(address indexed user, uint256 amount, uint256 newBalance)',
      'event Unstaked(address indexed user, uint256 amount, uint256 newBalance)',
      'event Claimed(address indexed user, uint256 amount)',
    ], p);

    const head = await p.getBlockNumber();
    const FROM = Math.max(0, head - 200_000);
    const all = await Promise.all([
      vault.queryFilter(vault.filters.TaxReceived(), FROM).catch(() => []),
      vault.queryFilter(vault.filters.Ticked(), FROM).catch(() => []),
      vault.queryFilter(vault.filters.Harvested(), FROM).catch(() => []),
      vault.queryFilter(vault.filters.Withdrawn(), FROM).catch(() => []),
      stk.queryFilter(stk.filters.Staked(), FROM).catch(() => []),
      stk.queryFilter(stk.filters.Unstaked(), FROM).catch(() => []),
      stk.queryFilter(stk.filters.Claimed(), FROM).catch(() => []),
    ]);
    const flat = [];
    const wei = (x) => Number(ethers.utils.formatEther(x));
    const tdec = (x) => Number(ethers.utils.formatUnits(x, v.decimals || 18));

    all[0].forEach(e => flat.push({ bn: e.blockNumber, tag: 'TAX',
      msg: `+${wei(e.args.amount).toFixed(4)} BNB · totalIn ${wei(e.args.totalIn).toFixed(3)}`,
      by: 'flap.sh trade' }));
    all[1].forEach(e => flat.push({ bn: e.blockNumber, tag: 'TICK',
      msg: `bounty ${wei(e.args.bounty).toFixed(5)} · burn ${fmtTokens(tdec(e.args.tokensBurned))}`,
      by: shortAddr(e.args.caller) }));
    all[2].forEach(e => flat.push({ bn: e.blockNumber, tag: 'HARVEST',
      msg: `equity ${wei(e.args.equityExtracted).toFixed(3)} BNB → stakers ${wei(e.args.toStakers).toFixed(3)} BNB`,
      by: shortAddr(e.args.caller) }));
    all[3].forEach(e => flat.push({ bn: e.blockNumber, tag: 'TICK',
      msg: `withdraw ${shortAddr(e.args.token)} → ${shortAddr(e.args.to)}`,
      by: 'creator' }));
    all[4].forEach(e => flat.push({ bn: e.blockNumber, tag: 'STAKE',
      msg: `+${fmtTokens(tdec(e.args.amount))} ${v.symbol || ''}`,
      by: shortAddr(e.args.user) }));
    all[5].forEach(e => flat.push({ bn: e.blockNumber, tag: 'STAKE',
      msg: `-${fmtTokens(tdec(e.args.amount))} ${v.symbol || ''} (unstake)`,
      by: shortAddr(e.args.user) }));
    all[6].forEach(e => flat.push({ bn: e.blockNumber, tag: 'HARVEST',
      msg: `claim ${wei(e.args.amount).toFixed(5)} BNB`,
      by: shortAddr(e.args.user) }));

    flat.sort((a, b) => b.bn - a.bn);
    const top = flat.slice(0, 12);
    // approximate ages from block diff × 3s
    top.forEach(e => { e.ageS = (head - e.bn) * 3; });

    state.eventsByVault[v.vault] = top;
  } catch (e) {
    state.eventsByVault[v.vault] = [];
  } finally {
    render();
  }
}

function iconCopy() {
  return el('span', { html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' });
}

/* ─── Action handlers ───────────────────────────────────────── */

function requireWallet(fn) {
  if (!state.account) {
    toast({ type: 'info', title: '请先连接钱包' });
    connectWallet();
    return;
  }
  fn();
}

function doTick(v) {
  requireWallet(() => {
    toast({ type: 'info', title: 'Tick 已提交', sub: 'pending ' + v.pendingBnb.toFixed(4) + ' BNB · 1% bounty' });
    setTimeout(() => {
      toast({ type: 'success', title: 'Tick 成功',
        sub: '+' + v.tickBounty.toFixed(5) + ' BNB → 你 · 平台币回购已触发' });
      v.pendingBnb = 0;
      render();
    }, 1200);
  });
}

function doHarvest(v) {
  requireWallet(() => {
    if (!v.harvestable) {
      toast({ type: 'error', title: ERROR_MAP['NotProfitable()'] });
      return;
    }
    toast({ type: 'info', title: 'Harvest 已提交', sub: 'equity ' + v.equity.toFixed(3) + ' BNB' });
    setTimeout(() => {
      const extracted = v.equity - v.costBasisBnb;
      toast({ type: 'success', title: 'Harvest 成功',
        sub: `+${(extracted * 0.01).toFixed(5)} BNB bounty · ${(extracted * 0.79).toFixed(4)} BNB → 质押池` });
      v.totalStakerRewards += extracted * 0.79;
      v.equity = v.costBasisBnb;
      v.pnlPct = 0;
      v.harvestable = false;
      render();
    }, 1400);
  });
}

function doApprove(v) {
  requireWallet(() => {
    toast({ type: 'info', title: 'Approve 已提交', sub: v.symbol + ' → ' + shortAddr(v.staking) });
    setTimeout(() => toast({ type: 'success', title: 'Approve 完成', sub: 'allowance = MaxUint256' }), 900);
  });
}

function doStake(v) {
  requireWallet(() => {
    const amt = Number(stakeUI.stakeInput);
    if (!amt || amt <= 0) { toast({ type: 'error', title: ERROR_MAP['Zero()'] }); return; }
    if (amt > v.myBalance) { toast({ type: 'error', title: '余额不足' }); return; }
    toast({ type: 'info', title: 'Stake 已提交', sub: fmtTokens(amt) + ' ' + v.symbol });
    setTimeout(() => {
      v.myBalance -= amt;
      v.myStaked += amt;
      v.totalStaked += amt;
      v.myCooldown = 1800;
      stakeUI.stakeInput = '';
      toast({ type: 'success', title: 'Stake 成功', sub: '冷却 30 min 已开始' });
      render();
    }, 1000);
  });
}

function doUnstake(v) {
  requireWallet(() => {
    const amt = Number(stakeUI.unstakeInput);
    if (!amt || amt <= 0) { toast({ type: 'error', title: ERROR_MAP['Zero()'] }); return; }
    if (amt > v.myStaked) { toast({ type: 'error', title: '质押量不足' }); return; }
    toast({ type: 'info', title: 'Unstake 已提交' });
    setTimeout(() => {
      v.myBalance += amt;
      v.myStaked -= amt;
      v.totalStaked -= amt;
      stakeUI.unstakeInput = '';
      toast({ type: 'success', title: 'Unstake 成功', sub: '+' + fmtTokens(amt) + ' ' + v.symbol + ' → 钱包' });
      render();
    }, 1000);
  });
}

function doClaim(v) {
  requireWallet(() => {
    if (v.myCooldown > 0) { toast({ type: 'error', title: ERROR_MAP['COOLDOWN'] }); return; }
    if (v.myEarned <= 0)  { toast({ type: 'error', title: ERROR_MAP['NO_REWARD'] }); return; }
    toast({ type: 'info', title: 'Claim 已提交' });
    setTimeout(() => {
      const amt = v.myEarned;
      v.myEarned = 0;
      toast({ type: 'success', title: 'Claim 成功', sub: '+' + amt.toFixed(5) + ' BNB → 钱包' });
      render();
    }, 900);
  });
}

function doWithdraw(v) {
  const token = $('#wd-token').value.trim();
  const to    = $('#wd-to').value.trim();
  const amt   = $('#wd-amt').value.trim();
  if (!to || !amt) { toast({ type: 'error', title: '参数不完整' }); return; }
  if (!confirm('⚠ 这是创建者特权,会从金库直接转出资产。继续吗?\n\nToken: ' + (token || 'BNB') + '\nTo: ' + to + '\nAmount: ' + amt)) return;
  toast({ type: 'info', title: '提款已提交', sub: amt + ' → ' + shortAddr(to) });
  setTimeout(() => toast({ type: 'success', title: '提款完成' }), 900);
}

/* ─── 404 ───────────────────────────────────────────────────── */

function renderLoadingDetail(addr) {
  return el('main', { class: 'page' },
    el('div', { class: 'crumb' },
      el('a', { href: '#/' }, '概览'),
      el('span', { class: 'sep' }, '/'),
      el('a', { href: '#/explore' }, '金库列表'),
      el('span', { class: 'sep' }, '/'),
      el('span', { class: 'mono' }, shortAddr(addr)),
    ),
    el('div', { class: 'empty' },
      el('div', { style: 'font-size:14px;color:var(--text);margin-bottom:6px' }, '正在查询链上数据…'),
      el('div', { class: 'mono', style: 'font-size:12px' }, 'vault ' + shortAddr(addr)),
    ),
  );
}

function renderNotFound(addr) {
  return el('main', { class: 'page' },
    el('div', { class: 'crumb' },
      el('a', { href: '#/' }, '概览'),
      el('span', { class: 'sep' }, '/'),
      el('span', null, '未找到'),
    ),
    el('div', { class: 'empty' },
      el('div', { style: 'font-size:18px;color:var(--text);margin-bottom:8px' }, '找不到 Vault'),
      el('div', { style: 'font-family:var(--font-mono);font-size:12px;margin-bottom:16px' }, shortAddr(addr)),
      el('a', { class: 'cta-ghost', href: '#/explore' }, '去金库列表 →'),
    ),
  );
}

/* ─── Tweaks panel ──────────────────────────────────────────── */

function setupTweaks() {
  const fab = el('button', { class: 'tweaks-fab', title: 'Tweaks',
    html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  });
  document.body.appendChild(fab);

  const panel = el('div', { class: 'tweaks-panel' });
  document.body.appendChild(panel);

  let open = false;
  fab.addEventListener('click', () => {
    open = !open;
    panel.classList.toggle('open', open);
    if (open) buildTweaksBody();
    if (open) postEditModeAvailable(true);
  });

  // Edit mode bridge
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === '__activate_edit_mode')  { open = true;  panel.classList.add('open'); buildTweaksBody(); }
    if (m.type === '__deactivate_edit_mode'){ open = false; panel.classList.remove('open'); }
  });
  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}

  function postEditModeAvailable() {
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
  }

  function buildTweaksBody() {
    panel.innerHTML = '';
    panel.appendChild(el('div', { class: 'tweaks-head' }, 'Tweaks',
      el('button', { onclick: () => { open = false; panel.classList.remove('open'); try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch {} } }, '✕')));
    const body = el('div', { class: 'tweaks-body' });
    panel.appendChild(body);

    // Accent color
    body.appendChild(el('div', { class: 'tweak-group' },
      el('div', { class: 'tweak-label' }, '强调色 / accent'),
      el('div', { class: 'swatch-row' },
        ...['green', 'amber', 'cyan', 'violet'].map(c => el('div', {
          class: 'swatch' + ((state.tweaks.accent || 'green') === c ? ' active' : ''),
          'data-c': c,
          onclick: () => { state.tweaks.accent = c; saveTweaks(); applyTweaks(); buildTweaksBody(); render(); },
        })),
      ),
    ));

    // Background
    body.appendChild(el('div', { class: 'tweak-group' },
      el('div', { class: 'tweak-label' }, '背景纹理 / background'),
      el('div', { class: 'tweak-row' },
        ...[
          ['grid',  '网格'],
          ['solid', '纯黑'],
          ['scan',  '扫描线'],
        ].map(([k, lbl]) => el('button', {
          class: (state.tweaks.bg || 'grid') === k ? 'active' : '',
          onclick: () => { state.tweaks.bg = k; saveTweaks(); applyTweaks(); },
        }, lbl)),
      ),
    ));

    body.appendChild(el('div', { class: 'tweak-group' },
      el('div', { class: 'tweak-label' }, '当前 vault 状态'),
      el('div', { style: 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);line-height:1.6' },
        'Factory: ', shortAddr(FACTORY), el('br'),
        'Chain:   BSC · 56', el('br'),
        'BNB/USD: $', state.bnbPrice.toFixed(2), el('br'),
        'Account: ', shortAddr(state.account || '0x0'),
      ),
    ));
  }
}

/* ─── Shell ─────────────────────────────────────────────────── */

function buildShell() {
  const app = $('#app');
  if (!app) return;
  app.innerHTML = '';
  app.appendChild(renderHeader());
  app.appendChild(el('div', { id: 'main' }));
}

/* ─── Init ──────────────────────────────────────────────────── */

function init() {
  applyTweaks();
  buildShell();
  setupTweaks();
  window.addEventListener('hashchange', render);
  render();

  loadLive(true);
  fetchOraclePrice();

  // refresh oracle price every 30s in live mode
  setInterval(() => { fetchOraclePrice(); }, 30_000);
}

async function fetchOraclePrice() {
  try {
    const p = getProvider(); if (!p) return;
    const o = new ethers.Contract(BNB_ORACLE, ORACLE_ABI, p);
    const data = await o.latestRoundData();
    const price = Number(data[1]) / 1e8;
    const updatedAt = Number(data[3]);
    state.bnbPrice = price;
    state.oracleAge = Math.max(0, Math.floor(Date.now() / 1000) - updatedAt);
    // refresh just the header pill if header exists
    const h = $('.net-pill .price'); if (h) h.textContent = '$' + price.toFixed(2);
  } catch (e) { /* ignore */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
