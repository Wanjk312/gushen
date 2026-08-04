/**
 * 主应用逻辑
 * 管理：自选股、当前选中股票、周期切换、实时报价、K线渲染
 */

const App = {
  currentCode: null,
  currentPeriod: 'day',  // 'minute' | '5day' | 'day' | 'week' | 'month'
  tickTimer: null,
  loading: false,

  // 缓存当前数据
  klines: null,
  intraday: null,
  quote: null,
  indicators: null,
  signalResult: null,
  multiPeriodAdvice: null,  // 多周期共振判断结果

  // ====== 初始化 ======
  async init() {
    DataStore.loadWatchlist();
    Charts.init('main-chart');
    this.bindEvents();

    // 默认添加海科新源
    if (DataStore.watchlist.length === 0) {
      DataStore.addStock('sz301292', '海科新源');
      DataStore.addStock('sh600519', '贵州茅台');
      DataStore.addStock('sz300750', '宁德时代');
    }

    // 拉所有自选股报价
    await this.refreshAllQuotes();

    // 渲染自选股
    this.renderWatchlist();

    // 默认选中第一个
    const first = DataStore.watchlist[0];
    if (first) {
      await this.selectStock(first.code);
    }

    // 启动实时轮询
    this.startRealtimeUpdate();
  },

  // ====== 事件绑定 ======
  bindEvents() {
    // 搜索框
    const searchInput = document.getElementById('stock-search');
    const searchResults = document.getElementById('search-results');

    let searchTimer = null;
    searchInput.addEventListener('input', (e) => {
      const keyword = e.target.value.trim();
      clearTimeout(searchTimer);
      if (keyword.length === 0) {
        searchResults.style.display = 'none';
        return;
      }
      searchTimer = setTimeout(async () => {
        const results = await API.search(keyword);
        this.renderSearchResults(results, searchInput, searchResults);
      }, 300);
    });

    // 点击外部关闭搜索结果
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
        searchResults.style.display = 'none';
      }
    });

    // 周期切换
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const period = btn.dataset.period;
        if (period === this.currentPeriod) return;
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentPeriod = period;
        if (this.currentCode) {
          this.loadCurrentStock();
        }
      });
    });
  },

  renderSearchResults(results, searchInput, searchResults) {
    if (!results || results.length === 0) {
      searchResults.innerHTML = '<div class="search-empty">未找到匹配股票</div>';
      searchResults.style.display = 'block';
      return;
    }
    searchResults.innerHTML = results.map(s => {
      const code = DataStore.toNetworkCode(s.code);
      const netName = s.name;
      return `
        <div class="search-item" data-code="${code}">
          <span class="search-code">${s.code}</span>
          <span class="search-name">${netName}</span>
          <span class="search-market">${s.marketName || s.market}</span>
        </div>
      `;
    }).join('');
    searchResults.style.display = 'block';

    searchResults.querySelectorAll('.search-item').forEach(item => {
      item.addEventListener('click', () => {
        const code = item.dataset.code;
        const name = item.querySelector('.search-name').textContent;
        if (DataStore.addStock(code, name)) {
          this.refreshAllQuotes();
          this.renderWatchlist();
          this.selectStock(code);
        } else {
          // 已存在，直接选中
          this.selectStock(code);
        }
        searchInput.value = '';
        searchResults.style.display = 'none';
      });
    });
  },

  // ====== 实时报价更新 ======
  async refreshAllQuotes() {
    if (DataStore.watchlist.length === 0) return;
    try {
      await DataStore.updateAllQuotes();
    } catch (e) {
      console.error('更新报价失败', e);
    }
  },

  // ====== 选中股票 ======
  async selectStock(code) {
    if (this.loading) return;
    this.currentCode = code;
    this.renderWatchlist();  // 高亮当前选中
    this.showLoading(true);
    try {
      await this.loadCurrentStock();
    } catch (e) {
      console.error('加载股票失败', e);
      alert('加载失败：' + e.message);
    } finally {
      this.showLoading(false);
    }
  },

  // ====== 加载当前股票数据（按周期）======
  async loadCurrentStock() {
    if (!this.currentCode) return;
    if (this.currentPeriod === 'minute') {
      // 分时
      const intraday = await DataStore.loadIntraday(this.currentCode);
      this.intraday = intraday;
      // 同时拿一次实时报价拿昨收
      let quote = DataStore.quotes[this.currentCode];
      if (!quote) {
        quote = await DataStore.updateQuote(this.currentCode);
      }
      this.quote = quote;

      Charts.render({
        type: 'minute',
        klines: intraday.points,
        prevClose: intraday.prevClose || quote.prevClose,
        currentPrice: intraday.lastPrice,
      });
      this.updateStockHeader();

      // 分时周期下，用分时数据本身算买卖点
      this.refreshSignalsForMinute();
      // 加载多周期共振（日K/周K/月K）
      this.loadMultiPeriodSignals();
    } else {
      // K线
      const klines = await DataStore.loadKline(this.currentCode, this.currentPeriod, 300);
      this.klines = klines;
      // 计算指标
      this.indicators = Indicators.calculateAll(klines);
      // 信号
      this.signalResult = Signals.analyze(klines, this.indicators);
      // 报价
      let quote = DataStore.quotes[this.currentCode];
      if (!quote) {
        quote = await DataStore.updateQuote(this.currentCode);
      }
      this.quote = quote;

      Charts.render({
        type: this.currentPeriod,
        klines,
        indicators: this.indicators,
        signals: this.signalResult,
        prevClose: quote.prevClose,
      });
      this.updateStockHeader();
      this.renderSignalPanel();
      // 加载多周期共振
      this.loadMultiPeriodSignals();
    }
  },

  // 加载多周期共振（拉日K/周K/月K）
  async loadMultiPeriodSignals() {
    if (!this.currentCode) return;
    try {
      const periodScores = { minute: null, "5day": null, day: null, week: null, month: null };
      // 当前周期已经有 score 了
      if (this.signalResult && this.signalResult.score !== undefined) {
        periodScores[this.currentPeriod] = this.signalResult.score;
      }
      // 拉日K
      if (this.currentPeriod !== "day") {
        const dayKlines = await DataStore.loadKline(this.currentCode, "day", 120);
        if (dayKlines && dayKlines.length > 30) {
          const dayInd = Indicators.calculateAll(dayKlines);
          const daySig = Signals.analyze(dayKlines, dayInd);
          periodScores.day = daySig.score || 0;
        }
      }
      // 拉周K
      if (this.currentPeriod !== "week") {
        const weekKlines = await DataStore.loadKline(this.currentCode, "week", 100);
        if (weekKlines && weekKlines.length > 20) {
          const weekInd = Indicators.calculateAll(weekKlines);
          const weekSig = Signals.analyze(weekKlines, weekInd);
          periodScores.week = weekSig.score || 0;
        }
      }
      // 拉月K
      if (this.currentPeriod !== "month") {
        const monthKlines = await DataStore.loadKline(this.currentCode, "month", 60);
        if (monthKlines && monthKlines.length > 12) {
          const monthInd = Indicators.calculateAll(monthKlines);
          const monthSig = Signals.analyze(monthKlines, monthInd);
          periodScores.month = monthSig.score || 0;
        }
      }
      this.multiPeriodAdvice = Signals.multiPeriodAdvice(periodScores, this.currentPeriod);
      this.renderMultiPeriodPanel();
    } catch (e) {
      console.error("多周期共振计算失败", e);
    }
  },

  // 渲染多周期共振面板
  renderMultiPeriodPanel() {
    const mpa = this.multiPeriodAdvice;
    if (!mpa) return;
    const panel = document.getElementById("signal-list");
    if (!panel) return;

    let detailsHtml = mpa.details.map(d => {
      const arrow = d.score > 0 ? "▲" : d.score < 0 ? "▼" : "◆";
      const cur = d.current ? " <span class='period-current'>当前</span>" : "";
      return `<div class="multi-row">
        <span class="multi-period">${d.periodName}${cur}</span>
        <span class="multi-score ${d.strengthColor}">${arrow} ${d.score}</span>
        <span class="multi-strength ${d.strengthColor}">${d.strength}</span>
      </div>`;
    }).join("");

    const icon = mpa.actionColor === "up" ? "▲" : mpa.actionColor === "down" ? "▼" : "◆";
    const html = `
      <div class="multi-panel">
        <div class="multi-title">
          <span class='multi-icon'>⚡</span>
          <span>多周期共振</span>
          <span class="multi-consensus ${mpa.consensusColor}">${mpa.consensus}</span>
        </div>
        <div class="multi-composite">
          <span class="multi-comp-label">加权综合</span>
          <span class="multi-comp-score ${mpa.consensusColor}">${mpa.compositeScore > 0 ? "+" : ""}${mpa.compositeScore}</span>
          <span class="multi-comp-dominant">主导: ${mpa.dominantPeriod}</span>
        </div>
        <div class="multi-details">${detailsHtml}</div>
        <div class="multi-advice ${mpa.actionColor}">
          <div class="multi-advice-action">
            <span class="advice-icon">${icon}</span>
            <span class="advice-text">${mpa.action}</span>
            <span class="advice-risk risk-${mpa.riskLevel}">风险:${mpa.riskLevel}</span>
          </div>
          <div class="multi-advice-text">${mpa.advice}</div>
        </div>
        <div class="multi-method">决策原则: 大周期定方向，小周期找买点</div>
      </div>
    `;

    // 只更新自己的 .multi-panel，不影响 .signal-summary / .signal-items
    const existingMulti = panel.querySelector(".multi-panel");
    if (existingMulti) {
      existingMulti.outerHTML = html;
    } else {
      // 锚点：插在 .signal-summary 之前；若还没有则放最前
      const summary = panel.querySelector(".signal-summary");
      if (summary) {
        summary.insertAdjacentHTML("beforebegin", html);
      } else {
        panel.insertAdjacentHTML("afterbegin", html);
      }
    }
  },

  // 分时周期下，用分时数据本身算买卖点
  refreshSignalsForMinute() {
    if (!this.intraday || !this.intraday.points || this.intraday.points.length < 20) {
      this.renderSignalPanelEmpty('分时数据不足');
      return;
    }
    try {
      this.signalResult = Signals.analyzeIntraday(this.intraday);
      this.renderSignalPanel(true);  // true = 分时模式
    } catch (e) {
      console.error('分时信号计算失败', e);
      this.renderSignalPanelEmpty('信号加载失败');
    }
  },

  renderSignalPanelEmpty(msg) {
    const panel = document.getElementById('signal-list');
    if (!panel) return;
    panel.innerHTML = `
      <div class="signal-summary">
        <div class="signal-score neutral">
          <div class="score-label">综合评分</div>
          <div class="score-value">--</div>
          <div class="score-hint">${msg}</div>
        </div>
      </div>
    `;
  },

  // ====== 股票头部信息 ======
  updateStockHeader() {
    const q = this.quote;
    if (!q) return;
    const isUp = q.change >= 0;
    const color = isUp ? 'var(--up-color)' : 'var(--down-color)';

    const header = document.getElementById('stock-header');
    header.innerHTML = `
      <div class="stock-header-left">
        <div class="header-name-wrap">
          <span class="header-name">${q.name}</span>
          <span class="header-code">${q.code}</span>
        </div>
      </div>
      <div class="stock-header-center">
        <span class="header-price" style="color:${color}">${q.price.toFixed(2)}</span>
        <span class="header-change" style="color:${color}">
          ${isUp ? '+' : ''}${q.change.toFixed(2)}
          ${isUp ? '+' : ''}${q.changePct.toFixed(2)}%
        </span>
      </div>
      <div class="stock-header-right">
        <span class="header-item">开 <b>${q.open.toFixed(2)}</b></span>
        <span class="header-item">高 <b style="color:var(--up-color)">${q.high.toFixed(2)}</b></span>
        <span class="header-item">低 <b style="color:var(--down-color)">${q.low.toFixed(2)}</b></span>
        <span class="header-item">昨 <b>${q.prevClose.toFixed(2)}</b></span>
      </div>
      <div class="stock-header-meta">
        <span>成交量 <b>${(q.volume / 10000).toFixed(0)}手</b></span>
        <span>成交额 <b>${(q.amount / 100000000).toFixed(2)}亿</b></span>
        <span>换手 <b>${q.turnover.toFixed(2)}%</b></span>
        <span>振幅 <b>${q.amplitude.toFixed(2)}%</b></span>
        <span>PE <b>${q.pe.toFixed(2)}</b></span>
        <span>PB <b>${q.pb.toFixed(2)}</b></span>
        <span>流通市值 <b>${q.circMarketCap.toFixed(2)}亿</b></span>
        <span>总市值 <b>${q.totalMarketCap.toFixed(2)}亿</b></span>
        <span>更新时间 <b id="header-update-time">${this.formatTime(q.time)}</b></span>
      </div>
    `;
  },

  formatTime(t) {
    if (!t || t.length < 12) return '--';
    return `${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
  },

  // ====== 信号面板 =====
  // 分三段独立更新：.multi-panel（多周期共振）/.signal-summary（顶部建议+综合评分）/.signal-items（子项列表）
  // 每段单独 outerHTML 替换，互不擦除，避免 1 秒轮询时把多周期面板闪没
  renderSignalPanel(isMinuteMode = false) {
    const sig = this.signalResult;
    if (!sig) return;
    this.renderSignalTop(sig, isMinuteMode);
    this.renderSignalList(sig);
  },

  renderSignalTop(sig, isMinuteMode) {
    const panel = document.getElementById('signal-list');
    if (!panel) return;
    const score = sig.score || 0;
    const scoreClass = score > 20 ? 'up' : score < -20 ? 'down' : 'neutral';

    // ===== 顶部操作建议 =====
    let adviceHtml = '';
    if (isMinuteMode) {
      const advice = sig.advice || Signals.intradayAdvice(score);
      const color = advice.color || (score > 10 ? 'up' : score < -10 ? 'down' : 'neutral');
      adviceHtml = `
        <div class="signal-advice ${color}">
          <span class="advice-icon">${color === 'up' ? '▲' : color === 'down' ? '▼' : '◆'}</span>
          <span class="advice-text">${advice.text || advice.action || '观望'}</span>
          ${advice.position ? `<span class="advice-position">${advice.position}</span>` : ''}
          ${advice.risk ? `<span class="advice-risk risk-${advice.risk}">风险:${advice.risk}</span>` : ''}
        </div>
      `;
    } else if (sig.advice) {
      const a = sig.advice;
      const color = score > 10 ? 'up' : score < -10 ? 'down' : 'neutral';
      const icon = color === 'up' ? '▲' : color === 'down' ? '▼' : '◆';
      adviceHtml = `
        <div class="signal-advice ${color}">
          <span class="advice-icon">${icon}</span>
          <span class="advice-text">${a.action}</span>
          <span class="advice-position">${a.position}</span>
          <span class="advice-risk risk-${a.risk}">风险:${a.risk}</span>
        </div>
        ${(a.stopLoss || a.target) ? `
        <div class="advice-detail">
          ${a.stopLoss ? `<span class="detail-item">止损: <b class="down">${a.stopLoss}</b></span>` : ''}
          ${a.target ? `<span class="detail-item">目标: <b class="up">${a.target}</b></span>` : ''}
        </div>` : ''}
        <div class="advice-rationale">${a.rationale}</div>
      `;
    }

    // ===== 趋势环境标签 =====
    let envHtml = '';
    if (sig.trendEnv) {
      const envText = sig.trendEnv.env === 'uptrend' ? '上涨趋势' : sig.trendEnv.env === 'downtrend' ? '下跌趋势' : '震荡市';
      const envClass = sig.trendEnv.env === 'uptrend' ? 'up' : sig.trendEnv.env === 'downtrend' ? 'down' : 'neutral';
      envHtml = `<span class="env-tag ${envClass}">${envText}</span>`;
    }

    // ===== 统计信息 =====
    let statsHtml = '';
    if (sig.stats) {
      statsHtml = `<span class="stats-tag">买入${sig.stats.buyCount} / 卖出${sig.stats.sellCount}</span>`;
    }

    const html = `
      <div class="signal-summary">
        ${adviceHtml}
        <div class="signal-score ${scoreClass}">
          <div class="score-label">
            综合评分${isMinuteMode ? ' <span style="font-size:10px;color:#888;">(分时)</span>' : ''}
            ${envHtml}
            ${statsHtml}
          </div>
          <div class="score-value">${score > 0 ? '+' : ''}${score.toFixed(0)}</div>
          <div class="score-bar">
            <div class="score-bar-fill" style="width:${Math.abs(score)}%;background:${score > 0 ? 'var(--up-color)' : 'var(--down-color)'}"></div>
          </div>
          <div class="score-hint">${sig.summary || (score > 30 ? '强势看多' : score > 10 ? '偏多' : score > -10 ? '震荡' : score > -30 ? '偏空' : '强势看空')}</div>
        </div>
      </div>
    `;

    // 只替换 .signal-summary，保留 .multi-panel
    const existing = panel.querySelector('.signal-summary');
    if (existing) {
      existing.outerHTML = html;
    } else {
      const multi = panel.querySelector('.multi-panel');
      if (multi) {
        multi.insertAdjacentHTML('afterend', html);
      } else {
        panel.insertAdjacentHTML('afterbegin', html);
      }
    }
  },

  renderSignalList(sig) {
    const panel = document.getElementById('signal-list');
    if (!panel) return;

    // 信号列表
    let itemsHtml = '';
    if (sig.signals && sig.signals.length > 0) {
      const catLabels = {
        trend: '趋势', momentum: '动量', oscillator: '超买超卖', boll: '布林',
        volume: '量价', pattern: '形态', sr: '支撑阻力', position: '位置',
        bias: '乖离', gap: '缺口', divergence: '背离', confluence: '共振',
        avg: '均价', prevclose: '昨收', tail: '尾盘', voldiv: '量价',
      };
      itemsHtml = sig.signals.map(s => {
        const catLabel = catLabels[s.category] || '';
        const displayScore = s.adjustedScore !== undefined ? s.adjustedScore : s.score;
        const trendTag = s.multiplier && s.multiplier !== 1.0
          ? `<span class="trend-tag ${s.multiplier > 1 ? 'up' : 'down'}">${s.multiplier > 1 ? '顺势↑' : '逆势↓'}</span>`
          : '';
        return `
        <div class="signal-item ${s.type}">
          <div class="signal-icon">${s.type === 'buy' ? '↑' : s.type === 'sell' ? '↓' : '○'}</div>
          <div class="signal-body">
            <div class="signal-name">${s.name} ${catLabel ? `<span class="cat-tag">${catLabel}</span>` : ''} ${trendTag}</div>
            <div class="signal-desc">${s.desc}</div>
          </div>
          <div class="signal-score-cell ${s.type}">${displayScore > 0 ? '+' : ''}${displayScore.toFixed(0)}</div>
        </div>
      `;
      }).join('');
    } else {
      itemsHtml = '<div class="signal-empty">暂无明显信号</div>';
    }

    const html = `<div class="signal-items">${itemsHtml}</div>`;
    const existing = panel.querySelector('.signal-items');
    if (existing) {
      existing.outerHTML = html;
    } else {
      panel.insertAdjacentHTML('beforeend', html);
    }
  },

  // ====== 自选股列表 ======
  renderWatchlist() {
    const list = document.getElementById('watchlist');
    const countEl = document.getElementById('watchlist-count');
    if (countEl) countEl.textContent = DataStore.watchlist.length;

    if (DataStore.watchlist.length === 0) {
      list.innerHTML = '<div class="empty-list">暂无自选股<br><span class="hint">搜索添加股票</span></div>';
      return;
    }

    list.innerHTML = DataStore.watchlist.map(s => {
      const q = DataStore.quotes[s.code];
      const isActive = s.code === this.currentCode;
      if (!q) {
        return `
          <div class="watchlist-item ${isActive ? 'active' : ''}" data-code="${s.code}">
            <div class="item-name">${s.name || s.code}</div>
            <div class="item-code">${DataStore.displayCode(s.code)}</div>
            <div class="item-price loading">--</div>
            <button class="item-delete" data-code="${s.code}">×</button>
          </div>
        `;
      }
      const isUp = q.change >= 0;
      return `
        <div class="watchlist-item ${isActive ? 'active' : ''}" data-code="${s.code}">
          <div class="item-row1">
            <span class="item-name">${q.name}</span>
            <span class="item-code">${q.code}</span>
          </div>
          <div class="item-row2">
            <span class="item-price ${isUp ? 'up' : 'down'}">${q.price.toFixed(2)}</span>
            <span class="item-change ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${q.changePct.toFixed(2)}%</span>
          </div>
          <button class="item-delete" data-code="${s.code}">×</button>
        </div>
      `;
    }).join('');

    // 绑定点击
    list.querySelectorAll('.watchlist-item').forEach(item => {
      const code = item.dataset.code;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('item-delete')) return;
        this.selectStock(code);
      });
    });
    list.querySelectorAll('.item-delete').forEach(btn => {
      const code = btn.dataset.code;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`确定删除 ${code}？`)) {
          DataStore.removeStock(code);
          this.renderWatchlist();
          if (this.currentCode === code) {
            const next = DataStore.watchlist[0];
            if (next) this.selectStock(next.code);
          }
        }
      });
    });
  },

  // ====== Loading 状态 ======
  showLoading(loading) {
    this.loading = loading;
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = loading ? 'flex' : 'none';
  },

  // 分时数据重拉（轻量版）：只拉分时数据+重画分时图，不重算信号
  // 用于 1 秒轮询里的 3 秒一次触发，避免每 3 秒都重算分时信号导致主建议闪烁
  async reloadIntradayOnly() {
    if (!this.currentCode) return;
    try {
      const intraday = await DataStore.loadIntraday(this.currentCode);
      this.intraday = intraday;
      Charts.render({
        type: 'minute',
        klines: intraday.points,
        prevClose: intraday.prevClose || (this.quote && this.quote.prevClose),
        currentPrice: intraday.lastPrice,
      });
    } catch (e) {
      console.error('分时数据重拉失败', e);
    }
  },

  // ====== 实时轮询 ======
  startRealtimeUpdate() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    let tickCount = 0;
    const indicator = document.getElementById('live-indicator');
    const indicatorText = indicator ? indicator.querySelector('.live-text') : null;

    const setIndicator = (state, text) => {
      if (!indicator) return;
      indicator.classList.remove('active', 'error');
      if (state) indicator.classList.add(state);
      if (indicatorText && text) indicatorText.textContent = text;
    };

    const setHeaderTime = (q) => {
      const el = document.getElementById('header-update-time');
      if (!el) return;
      // q.time 来自腾讯（数据源时间），用它显示最新行情时刻；
      // 旁边加本地时钟，让老板看清轮询在跑
      const remote = this.formatTime(q.time);
      const local = new Date().toTimeString().slice(0, 8);
      el.textContent = `${remote}`;
      el.title = `数据源: ${remote}  本地: ${local}`;
    };

    this.tickTimer = setInterval(async () => {
      tickCount++;
      const tickStart = Date.now();
      try {
        setIndicator('active', `轮询 #${tickCount}`);
        await this.refreshAllQuotes();
        this.renderWatchlist();

        if (this.currentCode) {
          const q = DataStore.quotes[this.currentCode];
          if (q) {
            this.quote = q;
            this.updateStockHeader();
            setHeaderTime(q);

            if (this.currentPeriod === 'minute') {
              // 1 秒：实时延伸分时图最后一点
              Charts.updateMinuteLastPoint(q.price);
              // 3 秒：仅重拉分时数据（轻量，不重算信号）
              if (tickCount % 3 === 0 && this.intraday) {
                this.reloadIntradayOnly();
              }
              // 30 秒：才重算分时信号，避免建议每秒/每 3 秒闪烁
              if (tickCount % 30 === 0) {
                this.refreshSignalsForMinute();
              }
            } else {
              // K 线模式：每 10 秒重算一次信号
              if (tickCount % 10 === 0 && this.signalResult && this.klines) {
                this.signalResult = Signals.analyze(this.klines, this.indicators);
                this.renderSignalPanel();
              }
            }
          }
        }
        const ms = Date.now() - tickStart;
        setIndicator('active', `实时 ${ms}ms`);
      } catch (e) {
        console.error('实时更新失败', e);
        setIndicator('error', '更新失败');
      }
    }, 1000);
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
