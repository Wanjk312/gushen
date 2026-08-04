/**
 * 图表渲染 - 基于 ECharts
 * 输入：K线数据 + 指标 + 信号
 * 支持：分时 / 五日 / 日K / 周K / 月K
 */

const Charts = {
  chart: null,
  currentType: 'day',  // 'minute' | '5day' | 'day' | 'week' | 'month'

  // 颜色常量（中国股市：涨红跌绿）
  COLOR_UP: '#ef232a',
  COLOR_DOWN: '#14b143',
  COLOR_MA5: '#ffa726',
  COLOR_MA10: '#29b6f6',
  COLOR_MA20: '#ab47bc',
  COLOR_MA60: '#7e57c2',
  COLOR_BOLL_UP: '#5b9bd5',
  COLOR_BOLL_MID: '#fd7e14',
  COLOR_BOLL_LOW: '#5b9bd5',
  COLOR_VOL_MA: '#ffa726',
  COLOR_MACD_DIF: '#ffa726',
  COLOR_MACD_DEA: '#29b6f6',

  init(domId) {
    const dom = document.getElementById(domId);
    if (!dom) {
      console.error('找不到图表容器', domId);
      return;
    }
    this.chart = echarts.init(dom, null, { renderer: 'canvas' });
    window.addEventListener('resize', () => this.chart && this.chart.resize());
  },

  // 通用渲染入口
  // data: { type, klines, prevClose, indicators, signals, currentPrice, name }
  render(data) {
    this.currentType = data.type;
    let option;
    if (data.type === 'minute') {
      option = this.buildMinuteOption(data);
    } else {
      option = this.buildKlineOption(data);
    }
    this.chart.setOption(option, true);
  },

  // 分时图实时延伸：直接更新最后一点的价格（不重拉接口）
  updateMinuteLastPoint(price) {
    if (!this.chart || this.currentType !== 'minute') return;
    const option = this.chart.getOption();
    const series = option.series;
    if (!series || !series[0]) return;

    const priceData = series[0].data;  // 分时价
    const avgData = series[1] ? series[1].data : [];  // 均价
    if (priceData && priceData.length > 0) {
      // 只更新最后一点（保持前面的真实分时数据不动）
      priceData[priceData.length - 1] = price;
      this.chart.setOption({ series: [{ data: priceData }, { data: avgData }] }, false, true);
    }
  },

  // 更新最后一根 K 线（实时）
  updateLastBar(kline, signals) {
    if (!this.chart) return;
    const option = this.chart.getOption();
    const series = option.series;
    if (this.currentType === 'minute') {
      // 分时图：用 line 渲染，不更新最后一根，而是平滑追加
      return;
    }
    // K线图：更新 series[0]（candlestick）的最后一根
    if (series[0] && series[0].type === 'candlestick') {
      const data = series[0].data;
      if (data.length > 0) {
        data[data.length - 1] = [kline.open, kline.close, kline.low, kline.high];
      }
    }
    // 更新成交量最后一根
    if (series[2] && series[2].type === 'bar') {
      const volData = series[2].data;
      if (volData.length > 0) {
        const lastVol = volData[volData.length - 1];
        if (Array.isArray(lastVol)) {
          volData[volData.length - 1] = [lastVol[0], kline.volume, kline.close >= kline.open ? 1 : -1];
        }
      }
    }
    this.chart.setOption({ series: [{ data: series[0].data }, { data: series[1].data }, { data: series[2].data }] });
  },

  // ====== 分时图（折线 + 均价 + 昨收）======
  buildMinuteOption(data) {
    const points = data.klines || [];  // [{time, price, volume, ...}]
    const prevClose = data.prevClose;
    const times = points.map(p => p.time);
    const prices = points.map(p => p.price);
    // 均价 = 累计成交额 / 累计成交量
    const avgPrices = points.map(p => p.cumVolume > 0 ? (p.cumAmount / p.cumVolume / 100) : 0);
    const volumes = points.map(p => p.volume);

    const lastPrice = data.currentPrice || (prices[prices.length - 1] || prevClose);
    const maxPrice = Math.max(...prices, prevClose, lastPrice);
    const minPrice = Math.min(...prices, prevClose, lastPrice);
    const padding = (maxPrice - minPrice) * 0.1 || prevClose * 0.01;

    return {
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        data: ['分时', '均价', '昨收'],
        textStyle: { color: '#d4d4d4', fontSize: 11 },
        top: 5,
        right: 20,
        itemWidth: 16,
        itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: '#666' } },
        backgroundColor: 'rgba(20, 20, 30, 0.95)',
        borderColor: '#444',
        textStyle: { color: '#fff' },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const idx = params[0].dataIndex;
          const p = points[idx];
          if (!p) return '';
          const change = (p.price - prevClose).toFixed(2);
          const changePct = prevClose > 0 ? ((p.price - prevClose) / prevClose * 100).toFixed(2) : '0.00';
          const color = p.price >= prevClose ? this.COLOR_UP : this.COLOR_DOWN;
          return `
            <div style="font-size:12px;line-height:1.6">
              <div style="color:#888">${p.time}</div>
              <div>最新价 <b style="color:${color}">${p.price.toFixed(2)}</b></div>
              <div>均价 <b style="color:#fd7e14">${(avgPrices[idx] || 0).toFixed(2)}</b></div>
              <div>涨跌 <b style="color:${color}">${change} (${changePct}%)</b></div>
              <div>成交量 <b>${(p.volume * 100 / 10000).toFixed(2)}手</b></div>
            </div>
          `;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#555' },
      },
      grid: [
        { left: 60, right: 30, top: 40, height: '60%' },
        { left: 60, right: 30, top: '74%', height: '18%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: times,
          scale: true,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: {
            color: '#888',
            fontSize: 10,
            formatter: (v) => {
              // 09:30 10:30 11:30 13:00 14:00 15:00
              if (['0930', '1030', '1130', '1300', '1400', '1500'].includes(v)) return v;
              return '';
            },
          },
          splitLine: { show: false },
          axisPointer: { z: 100 },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: times,
          scale: true,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          min: minPrice - padding,
          max: maxPrice + padding,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: {
            color: '#888',
            fontSize: 10,
            formatter: (v) => v.toFixed(2),
          },
          splitLine: { lineStyle: { color: '#262626', type: 'dashed' } },
          axisPointer: { label: { formatter: (p) => p.value.toFixed(2) } },
        },
        {
          gridIndex: 1,
          splitNumber: 2,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: {
            color: '#888',
            fontSize: 10,
            formatter: (v) => v >= 10000 ? (v / 10000).toFixed(1) + '万' : v,
          },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: [0, 1],
          start: 0,
          end: 100,
        },
      ],
      series: [
        {
          name: '分时',
          type: 'line',
          data: prices,
          smooth: false,
          symbol: 'none',
          lineStyle: {
            color: this.COLOR_UP,
            width: 1.5,
          },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(239, 35, 42, 0.25)' },
                { offset: 1, color: 'rgba(239, 35, 42, 0)' },
              ],
            },
          },
          markLine: {
            symbol: 'none',
            label: { show: true, position: 'end', color: '#888', fontSize: 10 },
            lineStyle: { color: '#888', type: 'dashed', width: 1 },
            data: [
              {
                yAxis: prevClose,
                name: `昨收 ${prevClose.toFixed(2)}`,
                label: { formatter: `昨收 ${prevClose.toFixed(2)}`, color: '#888' },
              },
            ],
          },
        },
        {
          name: '均价',
          type: 'line',
          data: avgPrices,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#fd7e14', width: 1.2, type: 'solid' },
        },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes.map((v, i) => {
            const up = i === 0 || prices[i] >= prices[i - 1];
            return { value: v, itemStyle: { color: up ? this.COLOR_UP : this.COLOR_DOWN } };
          }),
        },
      ],
    };
  },

  // ====== K线图（蜡烛 + 均线 + BOLL + 成交量 + MACD）======
  buildKlineOption(data) {
    const klines = data.klines;
    const ind = data.indicators;
    const sig = data.signals || {};

    const dates = klines.map(k => k.date);
    // 蜡烛图数据格式：[open, close, low, high]
    const candleData = klines.map(k => [k.open, k.close, k.low, k.high]);
    const volumes = klines.map((k, i) => ({
      value: k.volume,
      itemStyle: { color: k.close >= k.open ? this.COLOR_UP : this.COLOR_DOWN },
    }));

    // 找最近的有效指标值索引
    const lastIdx = klines.length - 1;

    return {
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        data: ['MA5', 'MA10', 'MA20', 'MA60', 'BOLL上', 'BOLL中', 'BOLL下', 'DIF', 'DEA', 'MACD'],
        textStyle: { color: '#d4d4d4', fontSize: 11 },
        top: 5,
        right: 20,
        itemWidth: 16,
        itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: '#666' } },
        backgroundColor: 'rgba(20, 20, 30, 0.95)',
        borderColor: '#444',
        textStyle: { color: '#fff' },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const idx = params[0].dataIndex;
          const k = klines[idx];
          if (!k) return '';
          const change = k.close - k.open;
          const changePct = (change / k.open * 100).toFixed(2);
          const color = change >= 0 ? this.COLOR_UP : this.COLOR_DOWN;
          const ma5 = ind.MA5 ? ind.MA5[idx] : null;
          const ma10 = ind.MA10 ? ind.MA10[idx] : null;
          const ma20 = ind.MA20 ? ind.MA20[idx] : null;
          const ma60 = ind.MA60 ? ind.MA60[idx] : null;
          const rsi = ind.RSI ? ind.RSI[idx] : null;
          const kdj_k = ind.KDJ ? ind.KDJ.K[idx] : null;
          const kdj_d = ind.KDJ ? ind.KDJ.D[idx] : null;
          const kdj_j = ind.KDJ ? ind.KDJ.J[idx] : null;
          return `
            <div style="font-size:12px;line-height:1.7;min-width:180px">
              <div style="color:#888;margin-bottom:4px">${k.date}</div>
              <div>开 <b>${k.open.toFixed(2)}</b> 收 <b style="color:${color}">${k.close.toFixed(2)}</b></div>
              <div>高 <b>${k.high.toFixed(2)}</b> 低 <b>${k.low.toFixed(2)}</b></div>
              <div>涨跌 <b style="color:${color}">${change.toFixed(2)} (${changePct}%)</b></div>
              <div>量 <b>${(k.volume / 100).toFixed(0)}手</b></div>
              <div style="border-top:1px solid #444;margin-top:4px;padding-top:4px">
                MA5 <b>${ma5 ? ma5.toFixed(2) : '--'}</b> MA10 <b>${ma10 ? ma10.toFixed(2) : '--'}</b><br>
                MA20 <b>${ma20 ? ma20.toFixed(2) : '--'}</b> MA60 <b>${ma60 ? ma60.toFixed(2) : '--'}</b>
              </div>
              <div>RSI <b>${rsi ? rsi.toFixed(2) : '--'}</b></div>
              <div>KDJ <b>${kdj_k ? kdj_k.toFixed(1) : '--'}</b> / <b>${kdj_d ? kdj_d.toFixed(1) : '--'}</b> / <b>${kdj_j ? kdj_j.toFixed(1) : '--'}</b></div>
            </div>
          `;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#555' },
      },
      grid: [
        { left: 60, right: 30, top: 40, height: '52%' },
        { left: 60, right: 30, top: '66%', height: '12%' },
        { left: 60, right: 30, top: '82%', height: '12%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          scale: true,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: { color: '#888', fontSize: 10 },
          splitLine: { show: false },
          axisPointer: { z: 100 },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: dates,
          scale: true,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        {
          type: 'category',
          gridIndex: 2,
          data: dates,
          scale: true,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: { color: '#888', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: {
            color: '#888',
            fontSize: 10,
            formatter: (v) => v.toFixed(2),
          },
          splitLine: { lineStyle: { color: '#262626', type: 'dashed' } },
        },
        {
          gridIndex: 1,
          splitNumber: 2,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: {
            color: '#888',
            fontSize: 10,
            formatter: (v) => v >= 10000 ? (v / 10000).toFixed(1) + '万' : v,
          },
          splitLine: { show: false },
        },
        {
          gridIndex: 2,
          splitNumber: 2,
          axisLine: { lineStyle: { color: '#3a3a3a' } },
          axisLabel: { color: '#888', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: [0, 1, 2],
          start: 60,
          end: 100,
        },
        {
          type: 'slider',
          xAxisIndex: [0, 1, 2],
          start: 60,
          end: 100,
          height: 18,
          bottom: 3,
          backgroundColor: 'rgba(40, 40, 50, 0.4)',
          fillerColor: 'rgba(120, 120, 200, 0.3)',
          borderColor: '#3a3a3a',
          textStyle: { color: '#888', fontSize: 10 },
          handleStyle: { color: '#5b9bd5' },
        },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: candleData,
          itemStyle: {
            color: this.COLOR_UP,
            color0: this.COLOR_DOWN,
            borderColor: this.COLOR_UP,
            borderColor0: this.COLOR_DOWN,
          },
          markPoint: this.buildSignalMarks(sig, klines),
        },
        {
          name: 'MA',
          type: 'line',
          data: ind.MA5 || [],
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 1 },
          showSymbol: false,
        },
        {
          name: 'BOLL',
          type: 'line',
          data: ind.BOLL ? ind.BOLL.upper : [],
          smooth: true,
          symbol: 'none',
          lineStyle: { color: this.COLOR_BOLL_UP, width: 1, type: 'solid' },
        },
        {
          name: 'BOLL中',
          type: 'line',
          data: ind.BOLL ? ind.BOLL.mid : [],
          smooth: true,
          symbol: 'none',
          lineStyle: { color: this.COLOR_BOLL_MID, width: 1, type: 'dashed' },
        },
        {
          name: 'BOLL下',
          type: 'line',
          data: ind.BOLL ? ind.BOLL.lower : [],
          smooth: true,
          symbol: 'none',
          lineStyle: { color: this.COLOR_BOLL_LOW, width: 1, type: 'solid' },
        },
        // 占位 legend
        { name: 'MA5', type: 'line', data: ind.MA5 || [], symbol: 'none', lineStyle: { color: this.COLOR_MA5, width: 1 } },
        { name: 'MA10', type: 'line', data: ind.MA10 || [], symbol: 'none', lineStyle: { color: this.COLOR_MA10, width: 1 } },
        { name: 'MA20', type: 'line', data: ind.MA20 || [], symbol: 'none', lineStyle: { color: this.COLOR_MA20, width: 1 } },
        { name: 'MA60', type: 'line', data: ind.MA60 || [], symbol: 'none', lineStyle: { color: this.COLOR_MA60, width: 1 } },
        // 成交量
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
        },
        {
          name: 'VOL-MA5',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: ind.VOL_MA5 || [],
          symbol: 'none',
          smooth: true,
          lineStyle: { color: this.COLOR_VOL_MA, width: 1 },
        },
        // MACD
        {
          name: 'DIF',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.MACD ? ind.MACD.dif : [],
          symbol: 'none',
          smooth: true,
          lineStyle: { color: this.COLOR_MACD_DIF, width: 1 },
        },
        {
          name: 'DEA',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.MACD ? ind.MACD.dea : [],
          symbol: 'none',
          smooth: true,
          lineStyle: { color: this.COLOR_MACD_DEA, width: 1 },
        },
        {
          name: 'MACD',
          type: 'bar',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.MACD ? ind.MACD.hist.map(v => ({
            value: v,
            itemStyle: { color: v >= 0 ? this.COLOR_UP : this.COLOR_DOWN },
          })) : [],
        },
      ],
    };
  },

  // 把买卖信号标注到K线上
  buildSignalMarks(sig, klines) {
    if (!sig || !sig.signals || sig.signals.length === 0) {
      return { data: [] };
    }
    const marks = [];
    // 只标注最近的若干个
    sig.signals.slice(0, 5).forEach(s => {
      if (s.index === undefined) return;
      const k = klines[s.index];
      if (!k) return;
      marks.push({
        name: s.type === 'buy' ? 'B' : 'S',
        coord: [k.date, s.type === 'buy' ? k.low : k.high],
        value: s.type === 'buy' ? 'B' : 'S',
        itemStyle: {
          color: s.type === 'buy' ? this.COLOR_UP : this.COLOR_DOWN,
          borderColor: '#fff',
          borderWidth: 1,
        },
        label: {
          color: '#fff',
          fontSize: 10,
          fontWeight: 'bold',
          formatter: s.type === 'buy' ? 'B' : 'S',
        },
        symbol: 'circle',
        symbolSize: 18,
      });
    });
    return { data: marks, symbol: 'circle', symbolSize: 18, label: { fontSize: 10 } };
  },
};
