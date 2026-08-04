/**
 * 专业级买卖信号系统 v2.0
 * 
 * 架构：趋势环境定调 → 多维度信号扫描 → 共振过滤 → 操作建议输出
 * 
 * 信号维度：
 *   1. 趋势 (均线排列/交叉/价格位置)
 *   2. 动量 (MACD金叉死叉/零轴/背离)
 *   3. 超买超卖 (KDJ/RSI + 背离)
 *   4. 波动率 (布林带突破/收窄/中轨)
 *   5. 量价 (放量缩量/量价背离/换手率)
 *   6. K线形态 (吞没/早晨之星/红三兵等经典组合)
 *   7. 支撑阻力 (前高前低突破/回踩)
 *   8. 位置评估 (N日高低位分位)
 *   9. 乖离率 (价格偏离MA20)
 *  10. 缺口信号
 *  11. 共振加权 (多信号同向加分/矛盾减分)
 *  12. 趋势环境乘数 (顺势加权/逆势减权)
 */
const Signals = {

  // ============================================================
  //  趋势环境判断 —— 先定调，再决定信号权重
  // ============================================================
  detectTrendEnv(data, ind) {
    const last = data.length - 1;
    const close = data[last].close;
    const ma5 = ind.MA5[last], ma10 = ind.MA10[last], ma20 = ind.MA20[last], ma60 = ind.MA60[last];
    const boll = ind.BOLL;

    let trendScore = 0; // 正=上涨趋势, 负=下跌趋势, 接近0=震荡

    // 1. 均线排列
    if (ma5 && ma10 && ma20 && ma60) {
      if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) trendScore += 3;
      else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) trendScore -= 3;
      else trendScore += 0; // 纠缠=震荡
    }

    // 2. 价格与MA20的关系
    if (ma20) {
      const devPct = (close - ma20) / ma20 * 100;
      if (devPct > 3) trendScore += 1;
      else if (devPct < -3) trendScore -= 1;
    }

    // 3. MA20斜率（方向）
    if (ma20 && ind.MA20[last - 5]) {
      const slope = (ma20 - ind.MA20[last - 5]) / ind.MA20[last - 5] * 100;
      if (slope > 0.5) trendScore += 1;
      else if (slope < -0.5) trendScore -= 1;
    }

    // 4. 价格与MA60
    if (ma60) {
      if (close > ma60 * 1.02) trendScore += 1;
      else if (close < ma60 * 0.98) trendScore -= 1;
    }

    // 5. 布林带宽度（窄=震荡, 宽=趋势）
    let bollWidth = 0, bollWidthRatio = 0;
    if (boll && boll.upper[last] && boll.lower[last] && boll.mid[last]) {
      bollWidth = (boll.upper[last] - boll.lower[last]) / boll.mid[last] * 100;
      // 对比10天前的宽度
      if (boll.upper[last - 10] && boll.lower[last - 10] && boll.mid[last - 10]) {
        const prevWidth = (boll.upper[last - 10] - boll.lower[last - 10]) / boll.mid[last - 10] * 100;
        bollWidthRatio = bollWidth / prevWidth;
      }
    }

    // 判定
    let env;
    if (trendScore >= 3) env = 'uptrend';
    else if (trendScore <= -3) env = 'downtrend';
    else env = 'sideways';

    return { env, score: trendScore, bollWidth, bollWidthRatio };
  },

  // 趋势环境乘数：顺势信号加权，逆势信号减权
  trendMultiplier(signalType, trendEnv) {
    if (trendEnv.env === 'uptrend') {
      return signalType === 'buy' ? 1.2 : 0.7; // 上涨趋势中卖出信号打7折
    } else if (trendEnv.env === 'downtrend') {
      return signalType === 'sell' ? 1.2 : 0.7; // 下跌趋势中买入信号打7折
    } else {
      return 1.0; // 震荡市不变
    }
  },

  // ============================================================
  //  背离检测 —— 专业交易最看重的信号之一
  // ============================================================
  detectDivergence(data, ind) {
    const signals = [];
    const last = data.length - 1;
    // 找最近两个局部高点和低点（简化：取最近60根内的最高最低）
    const lookback = Math.min(60, data.length - 1);
    const segment = data.slice(last - lookback + 1);
    const segLast = segment.length - 1;

    // ---- MACD 顶背离：价格创新高，MACD(DIF)未创新高 ----
    const macd = ind.MACD;
    if (macd && macd.dif) {
      // 找最近60根的最高价和对应的DIF
      let priceHighIdx = 0, priceHigh = -Infinity;
      let difHighIdx = 0, difHigh = -Infinity;
      for (let i = 0; i < segment.length; i++) {
        if (segment[i].high > priceHigh) { priceHigh = segment[i].high; priceHighIdx = i; }
        const di = macd.dif[last - lookback + 1 + i];
        if (di !== null && di > difHigh) { difHigh = di; difHighIdx = i; }
      }
      // 当前价格接近最高点（前90%），但DIF明显低于前高DIF
      const curDif = macd.dif[last];
      if (curDif !== null && segLast - priceHighIdx > 10 && priceHighIdx < segLast - 5) {
        // 当前是近期高点且DIF低于前高DIF的80%
        if (curDif < difHigh * 0.7 && difHigh > 0 && data[last].close > data[last - 1].close) {
          signals.push({
            type: 'sell',
            name: 'MACD 顶背离',
            desc: `价格创近期新高但DIF(${curDif.toFixed(3)})远低于前高DIF(${difHigh.toFixed(3)})，上涨动能衰竭，见顶风险大`,
            score: -20,
            category: 'divergence',
          });
        }
      }

      // ---- MACD 底背离：价格创新低，DIF未创新低 ----
      let priceLowIdx = 0, priceLow = Infinity;
      let difLowIdx = 0, difLow = Infinity;
      for (let i = 0; i < segment.length; i++) {
        if (segment[i].low < priceLow) { priceLow = segment[i].low; priceLowIdx = i; }
        const di = macd.dif[last - lookback + 1 + i];
        if (di !== null && di < difLow) { difLow = di; difLowIdx = i; }
      }
      if (curDif !== null && segLast - priceLowIdx > 10 && priceLowIdx < segLast - 5) {
        if (curDif > difLow * 1.3 && difLow < 0 && data[last].close < data[last - 1].close) {
          signals.push({
            type: 'buy',
            name: 'MACD 底背离',
            desc: `价格创近期新低但DIF(${curDif.toFixed(3)})明显高于前低DIF(${difLow.toFixed(3)})，下跌动能衰竭，反弹在即`,
            score: 20,
            category: 'divergence',
          });
        }
      }
    }

    // ---- RSI 背离 ----
    const rsi = ind.RSI12;
    if (rsi) {
      let priceHighIdx = 0, priceHigh = -Infinity;
      let rsiHighIdx = 0, rsiHigh = -Infinity;
      let priceLowIdx = 0, priceLow = Infinity;
      let rsiLowIdx = 0, rsiLow = Infinity;

      for (let i = 0; i < segment.length; i++) {
        if (segment[i].high > priceHigh) { priceHigh = segment[i].high; priceHighIdx = i; }
        const ri = rsi[last - lookback + 1 + i];
        if (ri !== null && ri > rsiHigh) { rsiHigh = ri; rsiHighIdx = i; }
        if (segment[i].low < priceLow) { priceLow = segment[i].low; priceLowIdx = i; }
        if (ri !== null && ri < rsiLow) { rsiLow = ri; rsiLowIdx = i; }
      }
      const curRsi = rsi[last];
      if (curRsi !== null) {
        // 顶背离
        if (segLast - priceHighIdx > 10 && priceHighIdx < segLast - 5 && curRsi < rsiHigh * 0.85 && data[last].close > data[last - 1].close) {
          signals.push({
            type: 'sell',
            name: 'RSI 顶背离',
            desc: `价格新高但RSI(${curRsi.toFixed(1)})低于前高(${rsiHigh.toFixed(1)})，多头力量减弱`,
            score: -15,
            category: 'divergence',
          });
        }
        // 底背离
        if (segLast - priceLowIdx > 10 && priceLowIdx < segLast - 5 && curRsi > rsiLow * 1.15 && data[last].close < data[last - 1].close) {
          signals.push({
            type: 'buy',
            name: 'RSI 底背离',
            desc: `价格新低但RSI(${curRsi.toFixed(1)})高于前低(${rsiLow.toFixed(1)})，空头力量减弱`,
            score: 15,
            category: 'divergence',
          });
        }
      }
    }

    return signals;
  },

  // ============================================================
  //  K线形态识别 —— 经典组合形态
  // ============================================================
  detectKLinePatterns(data) {
    const signals = [];
    const last = data.length - 1;
    if (last < 2) return signals;

    const c0 = data[last], c1 = data[last - 1], c2 = data[last - 2];
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);
    const range0 = c0.high - c0.low;
    const range1 = c1.high - c1.low;
    const upperShadow0 = c0.high - Math.max(c0.open, c0.close);
    const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low;

    // ---- 单根形态 ----
    if (range0 > 0) {
      // 十字星
      if (body0 / range0 < 0.1) {
        // 看位置：高位十字星偏空，低位十字星偏多
        const isHigh = c0.close > c1.close;
        signals.push({
          type: isHigh ? 'sell' : 'buy',
          name: isHigh ? '高位十字星' : '低位十字星',
          desc: `${isHigh ? '高位' : '低位'}出现十字星，变盘信号`,
          score: isHigh ? -8 : 8,
          category: 'pattern',
        });
      }
      // 锤子线（下影长，上影短，实体小，出现在下跌后）
      if (lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5 && c0.close < c1.close) {
        signals.push({
          type: 'buy', name: '锤子线',
          desc: '长下影+小实体，下跌中出现，看涨反转形态',
          score: 10, category: 'pattern',
        });
      }
      // 上吊线（同锤子形态，但出现在上涨后）
      if (lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5 && c0.close > c1.close) {
        signals.push({
          type: 'sell', name: '上吊线',
          desc: '长下影+小实体，上涨末段出现，看跌反转形态',
          score: -10, category: 'pattern',
        });
      }
      // 射击之星（上影长，下影短，实体小）
      const upperShadow1 = c0.high - Math.max(c0.open, c0.close);
      const lowerShadow1 = Math.min(c0.open, c0.close) - c0.low;
      if (upperShadow1 > body0 * 2 && lowerShadow1 < body0 * 0.5 && c0.close > c1.close) {
        signals.push({
          type: 'sell', name: '射击之星',
          desc: '长上影+小实体，高位出现，看跌反转',
          score: -10, category: 'pattern',
        });
      }
      // 大阳线/大阴线
      if (body0 > range0 * 0.7) {
        if (c0.close > c0.open) {
          const pct = ((c0.close - c0.open) / c0.open * 100);
          signals.push({
            type: 'buy', name: pct > 5 ? '超大阳线' : '大阳线',
            desc: `涨幅 ${pct.toFixed(2)}%，多头强势`,
            score: pct > 5 ? 12 : 8, category: 'pattern',
          });
        } else {
          const pct = ((c0.open - c0.close) / c0.open * 100);
          signals.push({
            type: 'sell', name: pct > 5 ? '超大阴线' : '大阴线',
            desc: `跌幅 ${pct.toFixed(2)}%，空头强势`,
            score: pct > 5 ? -12 : -8, category: 'pattern',
          });
        }
      }
    }

    // ---- 双根形态 ----
    // 看涨吞没：前阴后阳，阳线实体完全包住阴线实体
    if (c1.close < c1.open && c0.close > c0.open) {
      if (c0.close > c1.open && c0.open < c1.close) {
        signals.push({
          type: 'buy', name: '看涨吞没',
          desc: '阳线完全包住前根阴线，多头强力反包，反转信号',
          score: 15, category: 'pattern',
        });
      }
    }
    // 看跌吞没：前阳后阴，阴线实体完全包住阳线实体
    if (c1.close > c1.open && c0.close < c0.open) {
      if (c0.open > c1.close && c0.close < c1.open) {
        signals.push({
          type: 'sell', name: '看跌吞没',
          desc: '阴线完全包住前根阳线，空头强力反包，反转信号',
          score: -15, category: 'pattern',
        });
      }
    }
    // 乌云盖顶：前阳后阴，阴线开盘高于阳线最高价，收盘低于阳线实体中点
    if (c1.close > c1.open && c0.close < c0.open) {
      if (c0.open > c1.high && c0.close < (c1.open + c1.close) / 2) {
        signals.push({
          type: 'sell', name: '乌云盖顶',
          desc: '高开后收跌至前阳中点下方，见顶反转形态',
          score: -15, category: 'pattern',
        });
      }
    }
    // 刺透形态：前阴后阳，阳线开盘低于阴线最低价，收盘高于阴线实体中点
    if (c1.close < c1.open && c0.close > c0.open) {
      if (c0.open < c1.low && c0.close > (c1.open + c1.close) / 2) {
        signals.push({
          type: 'buy', name: '刺透形态',
          desc: '低开后收涨至前阴中点上方，见底反转形态',
          score: 15, category: 'pattern',
        });
      }
    }

    // ---- 三根形态 ----
    if (last >= 2) {
      // 早晨之星：第一根大阴，第二根小实体（星），第三根大阳收复第一根大部分
      if (c2.close < c2.open && body1 < range1 * 0.3 && c0.close > c0.open && c0.close > (c2.open + c2.close) / 2) {
        signals.push({
          type: 'buy', name: '早晨之星',
          desc: '大阴→十字星→大阳收复，经典底部反转形态',
          score: 20, category: 'pattern',
        });
      }
      // 黄昏之星：第一根大阳，第二根小实体（星），第三根大阴吞没第一根大部分
      if (c2.close > c2.open && body1 < range1 * 0.3 && c0.close < c0.open && c0.close < (c2.open + c2.close) / 2) {
        signals.push({
          type: 'sell', name: '黄昏之星',
          desc: '大阳→十字星→大阴吞没，经典顶部反转形态',
          score: -20, category: 'pattern',
        });
      }
      // 红三兵：连续三根阳线，每根收盘递增
      if (c2.close > c2.open && c1.close > c1.open && c0.close > c0.open && c0.close > c1.close && c1.close > c2.close) {
        signals.push({
          type: 'buy', name: '红三兵',
          desc: '连续三阳递增，多头稳步推进，强势上攻信号',
          score: 15, category: 'pattern',
        });
      }
      // 黑三鸦：连续三根阴线，每根收盘递减
      if (c2.close < c2.open && c1.close < c1.open && c0.close < c0.open && c0.close < c1.close && c1.close < c2.close) {
        signals.push({
          type: 'sell', name: '黑三鸦',
          desc: '连续三阴递减，空头稳步下压，弱势下跌信号',
          score: -15, category: 'pattern',
        });
      }
      // 两阳夹一阴：多头炮
      if (c2.close > c2.open && c1.close < c1.open && c0.close > c0.open && c0.close > c2.close && c1.close > c2.open) {
        signals.push({
          type: 'buy', name: '多头炮（两阳夹一阴）',
          desc: '两根阳线夹一根阴线，多头蓄势后发力，看涨中继',
          score: 12, category: 'pattern',
        });
      }
      // 两阴夹一阳：空头炮
      if (c2.close < c2.open && c1.close > c1.open && c0.close < c0.open && c0.close < c2.close && c1.close < c2.open) {
        signals.push({
          type: 'sell', name: '空头炮（两阴夹一阳）',
          desc: '两根阴线夹一根阳线，空头蓄势后发力，看跌中继',
          score: -12, category: 'pattern',
        });
      }
    }

    return signals;
  },

  // ============================================================
  //  量价分析
  // ============================================================
  detectVolumeSignals(data, ind) {
    const signals = [];
    const last = data.length - 1;
    const vol = data[last].volume;
    const volMA5 = ind.VOL_MA5[last];
    const volMA10 = ind.VOL_MA10[last];
    if (!volMA5 || volMA5 <= 0) return signals;

    const volRatio = vol / volMA5;
    const close = data[last].close;
    const prevClose = data[last - 1].close;
    const changePct = (close - prevClose) / prevClose * 100;

    // 1. 放量上涨 / 放量下跌
    if (volRatio > 2 && changePct > 2) {
      signals.push({
        type: 'buy', name: '放量暴涨',
        desc: `量比${volRatio.toFixed(1)}倍，涨${changePct.toFixed(2)}%，主力资金强势介入`,
        score: 18, category: 'volume',
      });
    } else if (volRatio > 2 && changePct > 0.5) {
      signals.push({
        type: 'buy', name: '放量上涨',
        desc: `量比${volRatio.toFixed(1)}倍，涨${changePct.toFixed(2)}%，量价配合良好`,
        score: 12, category: 'volume',
      });
    } else if (volRatio > 2 && changePct < -2) {
      signals.push({
        type: 'sell', name: '放量暴跌',
        desc: `量比${volRatio.toFixed(1)}倍，跌${changePct.toFixed(2)}%，恐慌性抛售`,
        score: -18, category: 'volume',
      });
    } else if (volRatio > 2 && changePct < -0.5) {
      signals.push({
        type: 'sell', name: '放量下跌',
        desc: `量比${volRatio.toFixed(1)}倍，跌${changePct.toFixed(2)}%，空头力量增强`,
        score: -12, category: 'volume',
      });
    }

    // 2. 量价背离（价升量缩 / 价跌量增）
    if (changePct > 1 && volRatio < 0.6) {
      signals.push({
        type: 'sell', name: '量价背离(价升量缩)',
        desc: `涨${changePct.toFixed(2)}%但量比仅${volRatio.toFixed(2)}，上涨无量支撑，警惕诱多`,
        score: -10, category: 'volume',
      });
    } else if (changePct < -1 && volRatio > 1.5) {
      signals.push({
        type: 'sell', name: '量价齐跌',
        desc: `跌${changePct.toFixed(2)}%且量比${volRatio.toFixed(1)}，放量下跌势头凶猛`,
        score: -12, category: 'volume',
      });
    } else if (changePct < -0.5 && volRatio < 0.5) {
      signals.push({
        type: 'buy', name: '缩量下跌',
        desc: `跌${changePct.toFixed(2)}%但量比仅${volRatio.toFixed(2)}，下跌动能不足，有支撑`,
        score: 8, category: 'volume',
      });
    }

    // 3. 连续放量（3日内持续放量）
    if (last >= 3 && volMA5 > 0) {
      let consecUp = true, consecVol = true;
      for (let i = 0; i < 3; i++) {
        if (data[last - i].volume < volMA5 * 1.2) consecVol = false;
        if (data[last - i].close < data[last - i - 1].close) consecUp = false;
      }
      if (consecVol && consecUp) {
        signals.push({
          type: 'buy', name: '连续放量上攻',
          desc: '近3日持续放量上涨，主力资金持续流入',
          score: 15, category: 'volume',
        });
      }
      let consecDown = true;
      consecVol = true;
      for (let i = 0; i < 3; i++) {
        if (data[last - i].volume < volMA5 * 1.2) consecVol = false;
        if (data[last - i].close > data[last - i - 1].close) consecDown = false;
      }
      if (consecVol && consecDown) {
        signals.push({
          type: 'sell', name: '连续放量下杀',
          desc: '近3日持续放量下跌，主力资金持续流出',
          score: -15, category: 'volume',
        });
      }
    }

    // 4. 地量（极端缩量）
    if (volRatio < 0.3) {
      signals.push({
        type: 'neutral', name: '地量',
        desc: `量比仅${volRatio.toFixed(2)}，成交极度萎缩，变盘在即`,
        score: 0, category: 'volume',
      });
    }

    return signals;
  },

  // ============================================================
  //  支撑阻力位分析
  // ============================================================
  detectSupportResistance(data) {
    const signals = [];
    const last = data.length - 1;
    const close = data[last].close;
    const lookback = Math.min(60, data.length);

    // 找近期高点（阻力）和低点（支撑）
    let recentHigh = -Infinity, recentLow = Infinity;
    let highIdx = 0, lowIdx = 0;
    for (let i = last - lookback + 1; i <= last; i++) {
      if (data[i].high > recentHigh) { recentHigh = data[i].high; highIdx = i; }
      if (data[i].low < recentLow) { recentLow = data[i].low; lowIdx = i; }
    }

    // 突破前高
    const prevClose = data[last - 1].close;
    if (prevClose < recentHigh * 0.99 && close > recentHigh * 1.01 && highIdx < last - 1) {
      signals.push({
        type: 'buy', name: '突破前高',
        desc: `突破${lookback}日内高点${recentHigh.toFixed(2)}，打开上行空间`,
        score: 15, category: 'sr',
      });
    }
    // 跌破前低
    if (prevClose > recentLow * 1.01 && close < recentLow * 0.99 && lowIdx < last - 1) {
      signals.push({
        type: 'sell', name: '跌破前低',
        desc: `跌破${lookback}日内低点${recentLow.toFixed(2)}，打开下行空间`,
        score: -15, category: 'sr',
      });
    }
    // 回踩支撑反弹
    if (close > recentLow * 0.98 && close < recentLow * 1.02 && lowIdx < last - 3 && close > prevClose) {
      signals.push({
        type: 'buy', name: '支撑位反弹',
        desc: `在前低${recentLow.toFixed(2)}附近获得支撑反弹`,
        score: 10, category: 'sr',
      });
    }
    // 阻力位受阻
    if (close < recentHigh * 1.02 && close > recentHigh * 0.98 && highIdx < last - 3 && close < prevClose) {
      signals.push({
        type: 'sell', name: '阻力位受阻',
        desc: `在前高${recentHigh.toFixed(2)}附近遇阻回落`,
        score: -10, category: 'sr',
      });
    }

    return { signals, recentHigh, recentLow };
  },

  // ============================================================
  //  位置评估 —— 当前价格在N日区间的分位
  // ============================================================
  detectPosition(data) {
    const signals = [];
    const last = data.length - 1;
    const close = data[last].close;
    const lookback = Math.min(120, data.length);

    let high = -Infinity, low = Infinity;
    for (let i = last - lookback + 1; i <= last; i++) {
      if (data[i].high > high) high = data[i].high;
      if (data[i].low < low) low = data[i].low;
    }
    const position = high > low ? (close - low) / (high - low) * 100 : 50;

    if (position < 10) {
      signals.push({
        type: 'buy', name: '处于低位区',
        desc: `当前价格位于${lookback}日区间底部${position.toFixed(0)}%，安全边际较高`,
        score: 10, category: 'position',
      });
    } else if (position > 90) {
      signals.push({
        type: 'sell', name: '处于高位区',
        desc: `当前价格位于${lookback}日区间顶部${position.toFixed(0)}%，追高风险较大`,
        score: -8, category: 'position',
      });
    }

    return { signals, position };
  },

  // ============================================================
  //  乖离率（BIAS）
  // ============================================================
  detectBias(data, ind) {
    const signals = [];
    const last = data.length - 1;
    const close = data[last].close;
    const ma20 = ind.MA20[last];
    if (!ma20 || ma20 <= 0) return { signals, bias: 0 };

    const bias = (close - ma20) / ma20 * 100;

    if (bias > 8) {
      signals.push({
        type: 'sell', name: '乖离过大(超买)',
        desc: `价格偏离MA20达${bias.toFixed(2)}%，过度偏离有回归需求`,
        score: -8, category: 'bias',
      });
    } else if (bias < -8) {
      signals.push({
        type: 'buy', name: '乖离过大(超卖)',
        desc: `价格偏离MA20达${bias.toFixed(2)}%，过度偏离有反弹需求`,
        score: 8, category: 'bias',
      });
    }

    return { signals, bias };
  },

  // ============================================================
  //  缺口分析
  // ============================================================
  detectGap(data) {
    const signals = [];
    const last = data.length - 1;
    if (last < 1) return signals;
    const c0 = data[last], c1 = data[last - 1];
    const gapUp = c0.low - c1.high;
    const gapDown = c1.low - c0.high;

    if (gapUp > 0) {
      // 向上跳空缺口
      const gapPct = gapUp / c1.close * 100;
      signals.push({
        type: 'buy', name: '向上跳空缺口',
        desc: `跳空${gapPct.toFixed(2)}%，多头强势突破`,
        score: gapPct > 2 ? 12 : 8, category: 'gap',
      });
    } else if (gapDown > 0) {
      const gapPct = gapDown / c1.close * 100;
      signals.push({
        type: 'sell', name: '向下跳空缺口',
        desc: `跳空${gapPct.toFixed(2)}%，空头强势突破`,
        score: gapPct > 2 ? -12 : -8, category: 'gap',
      });
    }

    return signals;
  },

  // ============================================================
  //  MACD 信号
  // ============================================================
  detectMACD(data, ind) {
    const signals = [];
    const macd = ind.MACD;
    if (!macd || !macd.dif) return signals;
    const last = data.length - 1;
    const prev = last - 1;

    const difCur = macd.dif[last], deaCur = macd.dea[last];
    const difPrev = macd.dif[prev], deaPrev = macd.dea[prev];
    if (difCur === null || deaCur === null || difPrev === null || deaPrev === null) return signals;

    // 金叉/死叉
    if (difPrev <= deaPrev && difCur > deaCur) {
      if (difCur < 0) {
        signals.push({
          type: 'buy', name: 'MACD 零轴下金叉',
          desc: `DIF上穿DEA，在零轴下方金叉，底部反转信号强`,
          score: 25, category: 'momentum',
        });
      } else {
        signals.push({
          type: 'buy', name: 'MACD 零轴上金叉',
          desc: `DIF上穿DEA，在零轴上方金叉，多头加速`,
          score: 15, category: 'momentum',
        });
      }
    }
    if (difPrev >= deaPrev && difCur < deaCur) {
      if (difCur > 0) {
        signals.push({
          type: 'sell', name: 'MACD 零轴上死叉',
          desc: `DIF下穿DEA，在零轴上方死叉，顶部风险信号`,
          score: -25, category: 'momentum',
        });
      } else {
        signals.push({
          type: 'sell', name: 'MACD 零轴下死叉',
          desc: `DIF下穿DEA，在零轴下方死叉，空头加速`,
          score: -15, category: 'momentum',
        });
      }
    }

    // 柱状图变化
    if (macd.hist[prev] !== null && macd.hist[last] !== null) {
      if (macd.hist[prev] < 0 && macd.hist[last] > 0) {
        signals.push({
          type: 'buy', name: 'MACD 柱翻红',
          desc: '红柱出现，多头动能开始释放',
          score: 8, category: 'momentum',
        });
      } else if (macd.hist[prev] > 0 && macd.hist[last] < 0) {
        signals.push({
          type: 'sell', name: 'MACD 柱翻绿',
          desc: '绿柱出现，空头动能开始释放',
          score: -8, category: 'momentum',
        });
      }
      // 红柱连续缩短 = 动能衰减
      if (macd.hist[last] > 0 && macd.hist[prev] > 0 && macd.hist[last] < macd.hist[prev] * 0.6 && last >= 2) {
        let shrinking = true;
        for (let i = 1; i <= 3; i++) {
          if (macd.hist[last - i] === null || macd.hist[last - i] <= 0) { shrinking = false; break; }
        }
        if (shrinking && macd.hist[last] < macd.hist[last - 1] && macd.hist[last - 1] < macd.hist[last - 2]) {
          signals.push({
            type: 'sell', name: 'MACD 红柱三连缩',
            desc: '红柱连续3根缩短，上涨动能明显衰减',
            score: -10, category: 'momentum',
          });
        }
      }
    }

    // DIF穿越零轴
    if (difPrev < 0 && difCur >= 0) {
      signals.push({
        type: 'buy', name: 'DIF 突破零轴',
        desc: 'DIF由负转正，中期趋势转多',
        score: 12, category: 'momentum',
      });
    } else if (difPrev > 0 && difCur <= 0) {
      signals.push({
        type: 'sell', name: 'DIF 跌破零轴',
        desc: 'DIF由正转负，中期趋势转空',
        score: -12, category: 'momentum',
      });
    }

    return signals;
  },

  // ============================================================
  //  KDJ + RSI 信号
  // ============================================================
  detectOscillator(data, ind) {
    const signals = [];
    const last = data.length - 1;
    const prev = last - 1;

    // ---- KDJ ----
    const kdj = ind.KDJ;
    if (kdj && kdj.K) {
      const k = kdj.K[last], d = kdj.D[last], j = kdj.J[last];
      const kP = kdj.K[prev], dP = kdj.D[prev];
      if (k !== null && d !== null && kP !== null && dP !== null) {
        if (kP <= dP && k > d) {
          if (j < 20) {
            signals.push({
              type: 'buy', name: 'KDJ 超卖金叉',
              desc: `J=${j.toFixed(1)}极度超卖区金叉，强烈反弹信号`,
              score: 18, category: 'oscillator',
            });
          } else if (j < 50) {
            signals.push({
              type: 'buy', name: 'KDJ 低位金叉',
              desc: `J=${j.toFixed(1)}低位金叉，短期看多`,
              score: 12, category: 'oscillator',
            });
          } else {
            signals.push({
              type: 'buy', name: 'KDJ 金叉',
              desc: `J=${j.toFixed(1)}金叉，短期偏多`,
              score: 8, category: 'oscillator',
            });
          }
        }
        if (kP >= dP && k < d) {
          if (j > 80) {
            signals.push({
              type: 'sell', name: 'KDJ 超买死叉',
              desc: `J=${j.toFixed(1)}极度超买区死叉，强烈回调信号`,
              score: -18, category: 'oscillator',
            });
          } else if (j > 50) {
            signals.push({
              type: 'sell', name: 'KDJ 高位死叉',
              desc: `J=${j.toFixed(1)}高位死叉，短期看空`,
              score: -12, category: 'oscillator',
            });
          } else {
            signals.push({
              type: 'sell', name: 'KDJ 死叉',
              desc: `J=${j.toFixed(1)}死叉，短期偏空`,
              score: -8, category: 'oscillator',
            });
          }
        }
        // J值极端
        if (j < -5) {
          signals.push({
            type: 'buy', name: 'J值极度超卖',
            desc: `J=${j.toFixed(1)}，极度超卖，反弹概率大`,
            score: 12, category: 'oscillator',
          });
        } else if (j > 105) {
          signals.push({
            type: 'sell', name: 'J值极度超买',
            desc: `J=${j.toFixed(1)}，极度超买，回调概率大`,
            score: -12, category: 'oscillator',
          });
        }
      }
    }

    // ---- RSI ----
    const rsi12 = ind.RSI12;
    const rsi6 = ind.RSI6;
    if (rsi12) {
      const r = rsi12[last];
      if (r !== null) {
        if (r > 80) {
          signals.push({
            type: 'sell', name: 'RSI 超买',
            desc: `RSI=${r.toFixed(1)}，超买区，警惕回调`,
            score: -12, category: 'oscillator',
          });
        } else if (r < 20) {
          signals.push({
            type: 'buy', name: 'RSI 超卖',
            desc: `RSI=${r.toFixed(1)}，超卖区，反弹机会`,
            score: 12, category: 'oscillator',
          });
        }
        // RSI中轴穿越
        const rPrev = rsi12[prev];
        if (rPrev !== null) {
          if (rPrev < 50 && r >= 50) {
            signals.push({
              type: 'buy', name: 'RSI 站上中轴',
              desc: `RSI从${rPrev.toFixed(1)}升至${r.toFixed(1)}，多头转强`,
              score: 5, category: 'oscillator',
            });
          } else if (rPrev > 50 && r <= 50) {
            signals.push({
              type: 'sell', name: 'RSI 跌破中轴',
              desc: `RSI从${rPrev.toFixed(1)}降至${r.toFixed(1)}，多头转弱`,
              score: -5, category: 'oscillator',
            });
          }
        }
      }
    }

    return signals;
  },

  // ============================================================
  //  均线趋势信号
  // ============================================================
  detectTrendSignals(data, ind) {
    const signals = [];
    const last = data.length - 1;
    const prev = last - 1;
    const close = data[last].close;
    const prevClose = data[prev].close;
    const ma5 = ind.MA5[last], ma10 = ind.MA10[last], ma20 = ind.MA20[last], ma60 = ind.MA60[last];
    const pma5 = ind.MA5[prev], pma10 = ind.MA10[prev], pma20 = ind.MA20[prev], pma60 = ind.MA60[prev];

    // 1. 均线交叉
    if (ma5 !== null && ma10 !== null && pma5 !== null && pma10 !== null) {
      if (pma5 <= pma10 && ma5 > ma10) {
        signals.push({
          type: 'buy', name: 'MA5上穿MA10',
          desc: '短期均线金叉，短期看多',
          score: 10, category: 'trend',
        });
      }
      if (pma5 >= pma10 && ma5 < ma10) {
        signals.push({
          type: 'sell', name: 'MA5下穿MA10',
          desc: '短期均线死叉，短期看空',
          score: -10, category: 'trend',
        });
      }
    }
    if (ma10 !== null && ma20 !== null && pma10 !== null && pma20 !== null) {
      if (pma10 <= pma20 && ma10 > ma20) {
        signals.push({
          type: 'buy', name: 'MA10上穿MA20',
          desc: '中期均线金叉，中期趋势转多',
          score: 15, category: 'trend',
        });
      }
      if (pma10 >= pma20 && ma10 < ma20) {
        signals.push({
          type: 'sell', name: 'MA10下穿MA20',
          desc: '中期均线死叉，中期趋势转空',
          score: -15, category: 'trend',
        });
      }
    }

    // 2. 均线排列
    if (ma5 !== null && ma10 !== null && ma20 !== null && ma60 !== null) {
      if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) {
        signals.push({
          type: 'buy', name: '均线完美多头排列',
          desc: 'MA5>MA10>MA20>MA60，强势多头格局，持股为主',
          score: 20, category: 'trend',
        });
      } else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) {
        signals.push({
          type: 'sell', name: '均线完美空头排列',
          desc: 'MA5<MA10<MA20<MA60，弱势空头格局，持币为主',
          score: -20, category: 'trend',
        });
      }
    }

    // 3. 价格突破/跌破关键均线
    if (ma20 !== null) {
      if (prevClose < ma20 && close > ma20) {
        signals.push({
          type: 'buy', name: '突破20日均线',
          desc: `股价站上MA20(${ma20.toFixed(2)})，短期转强`,
          score: 12, category: 'trend',
        });
      } else if (prevClose > ma20 && close < ma20) {
        signals.push({
          type: 'sell', name: '跌破20日均线',
          desc: `股价跌破MA20(${ma20.toFixed(2)})，短期转弱`,
          score: -12, category: 'trend',
        });
      }
    }
    if (ma60 !== null) {
      if (prevClose < ma60 && close > ma60) {
        signals.push({
          type: 'buy', name: '突破60日均线',
          desc: `股价站上MA60(${ma60.toFixed(2)})，中期向好`,
          score: 15, category: 'trend',
        });
      } else if (prevClose > ma60 && close < ma60) {
        signals.push({
          type: 'sell', name: '跌破60日均线',
          desc: `股价跌破MA60(${ma60.toFixed(2)})，中期看空`,
          score: -15, category: 'trend',
        });
      }
    }

    return signals;
  },

  // ============================================================
  //  布林带信号
  // ============================================================
  detectBollSignals(data, ind) {
    const signals = [];
    const boll = ind.BOLL;
    if (!boll) return signals;
    const last = data.length - 1;
    const close = data[last].close;
    const upper = boll.upper[last], lower = boll.lower[last], mid = boll.mid[last];
    if (upper === null || lower === null || mid === null) return signals;

    // 触及/突破上下轨
    if (close > upper) {
      signals.push({
        type: 'sell', name: '突破布林上轨',
        desc: `价格${close.toFixed(2)}突破上轨${upper.toFixed(2)}，短期超买`,
        score: -8, category: 'boll',
      });
    } else if (close < lower) {
      signals.push({
        type: 'buy', name: '跌破布林下轨',
        desc: `价格${close.toFixed(2)}跌破下轨${lower.toFixed(2)}，短期超卖`,
        score: 8, category: 'boll',
      });
    }

    // 中轨穿越
    const prevClose = data[last - 1].close;
    if (prevClose < mid && close > mid) {
      signals.push({
        type: 'buy', name: '突破布林中轨',
        desc: `站上布林中轨${mid.toFixed(2)}，偏多`,
        score: 8, category: 'boll',
      });
    } else if (prevClose > mid && close < mid) {
      signals.push({
        type: 'sell', name: '跌破布林中轨',
        desc: `跌破布林中轨${mid.toFixed(2)}，偏空`,
        score: -8, category: 'boll',
      });
    }

    // 布林带收窄（变盘预警）
    if (last > 20) {
      const widthNow = (upper - lower) / mid * 100;
      const widthPrev = (boll.upper[last - 10] - boll.lower[last - 10]) / boll.mid[last - 10] * 100;
      if (widthPrev > 0 && widthNow < widthPrev * 0.5) {
        signals.push({
          type: 'neutral', name: '布林带极度收窄',
          desc: `带宽从${widthPrev.toFixed(1)}%收窄至${widthNow.toFixed(1)}%，变盘在即`,
          score: 0, category: 'boll',
        });
      }
    }

    return signals;
  },

  // ============================================================
  //  主分析函数：K线信号
  // ============================================================
  analyze(data, ind) {
    if (!data || data.length < 30) {
      return { signals: [], score: 0, summary: '数据不足', advice: { action: '数据不足' } };
    }

    // 第一步：趋势环境判断
    const trendEnv = this.detectTrendEnv(data, ind);

    // 第二步：多维度信号扫描
    let allSignals = [];

    // 趋势信号
    allSignals = allSignals.concat(this.detectTrendSignals(data, ind));
    // MACD动量信号
    allSignals = allSignals.concat(this.detectMACD(data, ind));
    // 超买超卖信号
    allSignals = allSignals.concat(this.detectOscillator(data, ind));
    // 布林带信号
    allSignals = allSignals.concat(this.detectBollSignals(data, ind));
    // 量价信号
    allSignals = allSignals.concat(this.detectVolumeSignals(data, ind));
    // K线形态
    allSignals = allSignals.concat(this.detectKLinePatterns(data));
    // 支撑阻力
    const sr = this.detectSupportResistance(data);
    allSignals = allSignals.concat(sr.signals);
    // 位置评估
    const pos = this.detectPosition(data);
    allSignals = allSignals.concat(pos.signals);
    // 乖离率
    const bias = this.detectBias(data, ind);
    allSignals = allSignals.concat(bias.signals);
    // 缺口
    allSignals = allSignals.concat(this.detectGap(data));
    // 背离
    allSignals = allSignals.concat(this.detectDivergence(data, ind));

    // 第三步：趋势环境乘数 + 累计评分
    let totalScore = 0;
    let buyCount = 0, sellCount = 0;
    const processedSignals = [];

    allSignals.forEach(sig => {
      const multiplier = this.trendMultiplier(sig.type, trendEnv);
      const adjustedScore = Math.round(sig.score * multiplier);
      totalScore += adjustedScore;
      if (sig.type === 'buy') buyCount++;
      if (sig.type === 'sell') sellCount++;
      processedSignals.push({
        ...sig,
        rawScore: sig.score,
        adjustedScore,
        multiplier,
      });
    });

    // 第四步：共振加权
    // 多信号同向共振
    if (buyCount >= 5) {
      totalScore += 15;
      processedSignals.push({
        type: 'buy', name: '多重共振(5+买入信号)',
        desc: `${buyCount}个买入信号共振，高可信度看多`,
        score: 15, category: 'confluence', adjustedScore: 15,
      });
    } else if (buyCount >= 3 && sellCount <= 1) {
      totalScore += 8;
      processedSignals.push({
        type: 'buy', name: '买入信号共振',
        desc: `${buyCount}个买入信号共振，偏多`,
        score: 8, category: 'confluence', adjustedScore: 8,
      });
    }
    if (sellCount >= 5) {
      totalScore -= 15;
      processedSignals.push({
        type: 'sell', name: '多重共振(5+卖出信号)',
        desc: `${sellCount}个卖出信号共振，高可信度看空`,
        score: -15, category: 'confluence', adjustedScore: -15,
      });
    } else if (sellCount >= 3 && buyCount <= 1) {
      totalScore -= 8;
      processedSignals.push({
        type: 'sell', name: '卖出信号共振',
        desc: `${sellCount}个卖出信号共振，偏空`,
        score: -8, category: 'confluence', adjustedScore: -8,
      });
    }
    // 信号矛盾惩罚
    if (buyCount >= 3 && sellCount >= 3) {
      totalScore = Math.round(totalScore * 0.6);
      processedSignals.push({
        type: 'neutral', name: '信号矛盾',
        desc: `买入${buyCount}个 vs 卖出${sellCount}个，多空分歧大，方向不明`,
        score: 0, category: 'confluence', adjustedScore: 0,
      });
    }

    // 限制范围
    totalScore = Math.max(-100, Math.min(100, totalScore));

    // 第五步：构建操作建议
    const advice = this.buildAdvice(totalScore, trendEnv, processedSignals, data, sr, pos);

    // 按绝对分值排序（重要信号排前面）
    processedSignals.sort((a, b) => Math.abs(b.adjustedScore) - Math.abs(a.adjustedScore));

    return {
      signals: processedSignals.slice(0, 15),
      score: totalScore,
      summary: this.scoreToSummary(totalScore),
      trendEnv,
      advice,
      stats: { buyCount, sellCount, total: allSignals.length },
    };
  },

  // ============================================================
  //  操作建议构建（仓位/止损/目标位/风险等级）
  // ============================================================
  buildAdvice(score, trendEnv, signals, data, sr, pos) {
    const last = data.length - 1;
    const close = data[last].close;
    const recentLow = sr ? sr.recentLow : close * 0.95;
    const recentHigh = sr ? sr.recentHigh : close * 1.05;
    const ma20 = close; // fallback

    let action, position, risk, stopLoss, target, rationale;

    if (score >= 40) {
      action = '强烈买入';
      position = '7-8成仓';
      risk = '中';
      stopLoss = recentLow;
      target = recentHigh > close * 1.1 ? recentHigh : close * 1.1;
      rationale = '多维度信号强烈共振，趋势+动量+量价全面看多';
    } else if (score >= 20) {
      action = '买入';
      position = '5-6成仓';
      risk = '中';
      stopLoss = recentLow;
      target = recentHigh > close ? recentHigh : close * 1.05;
      rationale = '买入信号占优，可逢低布局';
    } else if (score >= 10) {
      action = '偏多/可加仓';
      position = '3-4成仓';
      risk = '中低';
      stopLoss = recentLow;
      target = recentHigh > close ? recentHigh : close * 1.03;
      rationale = '偏多但信号不够强，轻仓试探';
    } else if (score > -10) {
      action = '观望';
      position = '保持现有仓位';
      risk = '中';
      stopLoss = null;
      target = null;
      rationale = '多空信号均衡，方向不明，建议等待';
    } else if (score > -20) {
      action = '偏空/可减仓';
      position = '减至3-4成';
      risk = '中高';
      stopLoss = null;
      target = recentLow;
      rationale = '卖出信号占优，逢高减仓';
    } else if (score > -40) {
      action = '卖出';
      position = '减至1-2成';
      risk = '高';
      stopLoss = null;
      target = recentLow < close * 0.9 ? recentLow : close * 0.9;
      rationale = '多维度信号偏空，及时止盈止损';
    } else {
      action = '强烈卖出';
      position = '清仓';
      risk = '高';
      stopLoss = null;
      target = recentLow < close * 0.85 ? recentLow : close * 0.85;
      rationale = '多维度信号强烈共振看空，趋势+动量+量价全面走弱';
    }

    // 趋势环境附加提示
    let envHint = '';
    if (trendEnv.env === 'uptrend') envHint = '（当前为上涨趋势，顺势做多）';
    else if (trendEnv.env === 'downtrend') envHint = '（当前为下跌趋势，逆势做多需谨慎）';
    else envHint = '（当前为震荡市，高抛低吸）';

    return {
      action,
      position,
      risk,
      stopLoss: stopLoss ? stopLoss.toFixed(2) : null,
      target: target ? target.toFixed(2) : null,
      rationale: rationale + envHint,
    };
  },

  scoreToSummary(score) {
    if (score >= 40) return '强烈看多';
    if (score >= 20) return '看多';
    if (score >= 10) return '偏多';
    if (score > -10) return '震荡';
    if (score > -20) return '偏空';
    if (score > -40) return '看空';
    return '强烈看空';
  },

  // ============================================================
  //  分时专用信号 v2.0
  // ============================================================
  analyzeIntraday(intraday) {
    if (!intraday || !intraday.points || intraday.points.length < 20) {
      return { signals: [], score: 0, summary: '数据不足', advice: { action: '数据不足' } };
    }
    const points = intraday.points;
    const prevClose = intraday.prevClose || points[0].price;
    const last = points.length - 1;
    const cur = points[last];
    const curPrice = cur.price;

    // 计算均价数组
    const avgPrices = points.map(p => p.cumVolume > 0 ? p.cumAmount / p.cumVolume / 100 : 0);
    const curAvg = avgPrices[last];

    const signals = [];
    let totalScore = 0;

    // ===== 1. 价格 vs 均价线（最核心）=====
    if (curAvg > 0) {
      const vsAvgPct = (curPrice - curAvg) / curAvg * 100;
      const prevPrice = points[last - 1].price;
      const prevAvg = avgPrices[last - 1];
      // 突破/跌破均价线
      if (prevPrice <= prevAvg && curPrice > curAvg) {
        signals.push({
          type: 'buy', name: '突破均价线',
          desc: `价格上穿均价${curAvg.toFixed(2)}，多头启动`,
          score: 20, category: 'avg',
        });
        totalScore += 20;
      } else if (prevPrice >= prevAvg && curPrice < curAvg) {
        signals.push({
          type: 'sell', name: '跌破均价线',
          desc: `价格下穿均价${curAvg.toFixed(2)}，空头占优`,
          score: -20, category: 'avg',
        });
        totalScore -= 20;
      }
      // 持续位置
      if (vsAvgPct > 2) {
        signals.push({
          type: 'buy', name: '强势站上均价',
          desc: `高出均价${vsAvgPct.toFixed(2)}%，多头控盘`,
          score: 15, category: 'avg',
        });
        totalScore += 15;
      } else if (vsAvgPct > 0.5) {
        signals.push({
          type: 'buy', name: '站稳均价上方',
          desc: `高出均价${vsAvgPct.toFixed(2)}%，偏多`,
          score: 8, category: 'avg',
        });
        totalScore += 8;
      } else if (vsAvgPct < -2) {
        signals.push({
          type: 'sell', name: '深陷均价下方',
          desc: `低于均价${Math.abs(vsAvgPct).toFixed(2)}%，空头控盘`,
          score: -15, category: 'avg',
        });
        totalScore -= 15;
      } else if (vsAvgPct < -0.5) {
        signals.push({
          type: 'sell', name: '运行于均价下方',
          desc: `低于均价${Math.abs(vsAvgPct).toFixed(2)}%，偏空`,
          score: -8, category: 'avg',
        });
        totalScore -= 8;
      }
    }

    // ===== 2. 价格 vs 昨收 =====
    const vsPrevPct = prevClose > 0 ? (curPrice - prevClose) / prevClose * 100 : 0;
    if (vsPrevPct > 5) {
      signals.push({
        type: 'buy', name: '强势大涨',
        desc: `较昨收+${vsPrevPct.toFixed(2)}%，强势特征明显`,
        score: 15, category: 'prevclose',
      });
      totalScore += 15;
    } else if (vsPrevPct > 2) {
      signals.push({
        type: 'buy', name: '涨幅扩大',
        desc: `较昨收+${vsPrevPct.toFixed(2)}%，多头占优`,
        score: 10, category: 'prevclose',
      });
      totalScore += 10;
    } else if (vsPrevPct > 0.5) {
      signals.push({
        type: 'buy', name: '温和上涨',
        desc: `较昨收+${vsPrevPct.toFixed(2)}%，偏多`,
        score: 5, category: 'prevclose',
      });
      totalScore += 5;
    } else if (vsPrevPct < -5) {
      signals.push({
        type: 'sell', name: '弱势大跌',
        desc: `较昨收${vsPrevPct.toFixed(2)}%，弱势特征明显`,
        score: -15, category: 'prevclose',
      });
      totalScore -= 15;
    } else if (vsPrevPct < -2) {
      signals.push({
        type: 'sell', name: '跌幅扩大',
        desc: `较昨收${vsPrevPct.toFixed(2)}%，空头占优`,
        score: -10, category: 'prevclose',
      });
      totalScore -= 10;
    } else if (vsPrevPct < -0.5) {
      signals.push({
        type: 'sell', name: '温和下跌',
        desc: `较昨收${vsPrevPct.toFixed(2)}%，偏空`,
        score: -5, category: 'prevclose',
      });
      totalScore -= 5;
    }

    // ===== 3. 日内形态分析 =====
    let dayHigh = 0, dayLow = Infinity, highIdx = 0, lowIdx = 0;
    points.forEach((p, i) => {
      if (p.price > dayHigh) { dayHigh = p.price; highIdx = i; }
      if (p.price < dayLow) { dayLow = p.price; lowIdx = i; }
    });
    const amplitude = prevClose > 0 ? (dayHigh - dayLow) / prevClose * 100 : 0;
    const morningEndIdx = points.findIndex(p => parseInt(p.time) >= 1130);
    const morningEnd = morningEndIdx > 0 ? morningEndIdx : Math.floor(points.length * 0.5);
    const isAfternoon = last > morningEnd;

    // 早盘冲高回落
    if (highIdx < morningEnd && dayHigh > prevClose * 1.015 && last > highIdx + 10) {
      const fallPct = (dayHigh - curPrice) / dayHigh * 100;
      if (fallPct > 2) {
        signals.push({
          type: 'sell', name: '冲高回落',
          desc: `早盘最高${dayHigh.toFixed(2)}回落${fallPct.toFixed(2)}%，见顶风险`,
          score: -12, category: 'pattern',
        });
        totalScore -= 12;
      } else if (fallPct > 1) {
        signals.push({
          type: 'sell', name: '冲高小幅回落',
          desc: `早盘最高${dayHigh.toFixed(2)}回落${fallPct.toFixed(2)}%，上攻乏力`,
          score: -6, category: 'pattern',
        });
        totalScore -= 6;
      }
    }

    // V型反转
    if (lowIdx < morningEnd && dayLow < prevClose * 0.985 && last > lowIdx + 10) {
      const risePct = (curPrice - dayLow) / dayLow * 100;
      if (risePct > 2 && curPrice > dayLow * 1.015) {
        signals.push({
          type: 'buy', name: 'V型反转',
          desc: `早盘最低${dayLow.toFixed(2)}反弹${risePct.toFixed(2)}%，有资金承接`,
          score: 12, category: 'pattern',
        });
        totalScore += 12;
      }
    }

    // 早盘杀跌尾盘拉升（U型）
    if (lowIdx < morningEnd && curPrice > prevClose * 1.005 && isAfternoon) {
      signals.push({
        type: 'buy', name: '低开高走(U型)',
        desc: '早盘下探后尾盘收红，多头逐步控盘',
        score: 10, category: 'pattern',
      });
      totalScore += 10;
    }

    // 高开低走
    if (highIdx < morningEnd && curPrice < prevClose * 0.995 && isAfternoon) {
      signals.push({
        type: 'sell', name: '高开低走',
        desc: '早盘冲高后持续走弱，多头乏力',
        score: -10, category: 'pattern',
      });
      totalScore -= 10;
    }

    // 振幅
    if (amplitude > 6) {
      signals.push({
        type: 'neutral', name: '剧烈波动',
        desc: `振幅${amplitude.toFixed(2)}%，多空博弈激烈`,
        score: 0, category: 'pattern',
      });
    }

    // ===== 4. 尾盘异动（最后30分钟）=====
    const tailStart = Math.max(0, last - 30);
    const tailStartPrice = points[tailStart].price;
    const tailChangePct = tailStartPrice > 0 ? (curPrice - tailStartPrice) / tailStartPrice * 100 : 0;
    if (tailChangePct > 1.5) {
      signals.push({
        type: 'buy', name: '尾盘强势拉升',
        desc: `尾盘30分钟+${tailChangePct.toFixed(2)}%，资金抢筹`,
        score: 12, category: 'tail',
      });
      totalScore += 12;
    } else if (tailChangePct > 0.5) {
      signals.push({
        type: 'buy', name: '尾盘小幅走高',
        desc: `尾盘30分钟+${tailChangePct.toFixed(2)}%，偏多`,
        score: 5, category: 'tail',
      });
      totalScore += 5;
    } else if (tailChangePct < -1.5) {
      signals.push({
        type: 'sell', name: '尾盘跳水',
        desc: `尾盘30分钟${tailChangePct.toFixed(2)}%，资金出逃`,
        score: -12, category: 'tail',
      });
      totalScore -= 12;
    } else if (tailChangePct < -0.5) {
      signals.push({
        type: 'sell', name: '尾盘走弱',
        desc: `尾盘30分钟${tailChangePct.toFixed(2)}%，偏空`,
        score: -5, category: 'tail',
      });
      totalScore -= 5;
    }

    // ===== 5. 尾盘放量 =====
    const tailVol = cur.cumVolume - points[tailStart].cumVolume;
    const avgVolPerMin = cur.cumVolume / (last + 1);
    const tailVolRatio = avgVolPerMin > 0 ? tailVol / (avgVolPerMin * 30) : 0;
    if (tailVolRatio > 2.5 && Math.abs(tailChangePct) > 0.5) {
      if (tailChangePct > 0) {
        signals.push({
          type: 'buy', name: '尾盘放量拉升',
          desc: `尾盘量比${tailVolRatio.toFixed(1)}倍+涨幅${tailChangePct.toFixed(2)}%，主力抢筹`,
          score: 10, category: 'tail',
        });
        totalScore += 10;
      } else {
        signals.push({
          type: 'sell', name: '尾盘放量杀跌',
          desc: `尾盘量比${tailVolRatio.toFixed(1)}倍+跌幅${tailChangePct.toFixed(2)}%，主力出逃`,
          score: -10, category: 'tail',
        });
        totalScore -= 10;
      }
    }

    // ===== 6. 量价背离检测（最近30分钟）=====
    if (last >= 30 && cur.cumVolume > 0 && points[last - 30].cumVolume > 0) {
      const recentVol = cur.cumVolume - points[last - 30].cumVolume;
      const recentPriceChange = curPrice - points[last - 30].price;
      const recentPricePct = points[last - 30].price > 0 ? recentPriceChange / points[last - 30].price * 100 : 0;
      if (recentPricePct > 0.5 && recentVol < avgVolPerMin * 30 * 0.6) {
        signals.push({
          type: 'sell', name: '上涨缩量(诱多)',
          desc: `30分钟涨${recentPricePct.toFixed(2)}%但量能萎缩至均量60%以下，警惕诱多`,
          score: -10, category: 'voldiv',
        });
        totalScore -= 10;
      } else if (recentPricePct < -0.5 && recentVol < avgVolPerMin * 30 * 0.6) {
        signals.push({
          type: 'buy', name: '下跌缩量(抗跌)',
          desc: `30分钟跌${Math.abs(recentPricePct).toFixed(2)}%但量能萎缩，下方有支撑`,
          score: 8, category: 'voldiv',
        });
        totalScore += 8;
      }
    }

    // ===== 7. 分时趋势（5分钟均线方向）=====
    if (last >= 10) {
      const ma5Min = points.slice(last - 4, last + 1).reduce((s, p) => s + p.price, 0) / 5;
      const ma5MinPrev = points.slice(last - 9, last - 4).reduce((s, p) => s + p.price, 0) / 5;
      if (ma5Min > ma5MinPrev * 1.002) {
        signals.push({
          type: 'buy', name: '分时均线走平向上',
          desc: '5分钟均价上翘，短期趋势转多',
          score: 8, category: 'trend',
        });
        totalScore += 8;
      } else if (ma5Min < ma5MinPrev * 0.998) {
        signals.push({
          type: 'sell', name: '分时均线走平向下',
          desc: '5分钟均价下弯，短期趋势转空',
          score: -8, category: 'trend',
        });
        totalScore -= 8;
      }
    }

    // ===== 8. 共振加权 =====
    const buyCount = signals.filter(s => s.type === 'buy').length;
    const sellCount = signals.filter(s => s.type === 'sell').length;
    if (buyCount >= 5) {
      totalScore += 10;
      signals.push({ type: 'buy', name: '多重共振', desc: `${buyCount}个买入信号共振`, score: 10, category: 'confluence' });
    } else if (sellCount >= 5) {
      totalScore -= 10;
      signals.push({ type: 'sell', name: '多重共振', desc: `${sellCount}个卖出信号共振`, score: -10, category: 'confluence' });
    }

    totalScore = Math.max(-100, Math.min(100, totalScore));

    // 信号排序
    signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

    return {
      signals: signals.slice(0, 12),
      score: totalScore,
      summary: this.scoreToSummary(totalScore),
      advice: this.intradayAdvice(totalScore),
      stats: { buyCount, sellCount },
    };
  },

  /**
   * 分时模式下的建议文字
   */
  intradayAdvice(score) {
    if (score >= 40) return { text: '强烈买入', color: 'up', position: '7-8成仓', risk: '中' };
    if (score >= 20) return { text: '买入', color: 'up', position: '5-6成仓', risk: '中' };
    if (score >= 10) return { text: '偏多/可加仓', color: 'up', position: '3-4成仓', risk: '中低' };
    if (score > -10) return { text: '观望', color: 'neutral', position: '保持仓位', risk: '中' };
    if (score > -20) return { text: '偏空/可减仓', color: 'down', position: '减至3-4成', risk: '中高' };
    if (score > -40) return { text: '卖出', color: 'down', position: '减至1-2成', risk: '高' };
    return { text: '强烈卖出', color: 'down', position: '清仓', risk: '高' };
  },
  multiPeriodAdvice(periodScores, currentPeriod) {
    const weights = {
      minute: 0.5,
      "5day": 0.7,
      day: 1.0,
      week: 1.3,
      month: 1.5,
    };

    let totalWeight = 0;
    let weightedScore = 0;
    const details = [];

    Object.keys(periodScores).forEach(period => {
      const score = periodScores[period];
      if (score === null || score === undefined) return;
      const w = weights[period] || 1.0;
      weightedScore += score * w;
      totalWeight += w;

      const strength = this.scoreToStrength(score);
      details.push({
        period: period,
        periodName: this.periodName(period),
        score: Math.round(score),
        weight: w,
        strength: strength.text,
        strengthColor: strength.color,
        current: period === currentPeriod,
      });
    });

    const compositeScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const validScores = details.map(d => d.score);
    const maxScore = Math.max.apply(null, validScores);
    const minScore = Math.min.apply(null, validScores);
    const spread = maxScore - minScore;

    let consensus, consensusColor, action, actionColor, advice, riskLevel;

    if (spread < 30) {
      consensus = "\u5468\u671f\u5171\u632f";
      consensusColor = compositeScore > 0 ? "up" : "down";
      if (compositeScore >= 20) {
        action = "\u5f3a\u70c8\u4e70\u5165"; actionColor = "up";
        advice = "\u591a\u5468\u671f\u5171\u632f\u770b\u591a\uff0c\u53ef\u91cd\u4ed3\u5e72"; riskLevel = "\u4e2d";
      } else if (compositeScore >= 10) {
        action = "\u4e70\u5165"; actionColor = "up";
        advice = "\u591a\u5468\u671f\u504f\u591a\uff0c\u53ef\u52a0\u4ed3"; riskLevel = "\u4e2d\u4f4e";
      } else if (compositeScore > -10) {
        action = "\u89c2\u671b"; actionColor = "neutral";
        advice = "\u591a\u5468\u671f\u65b9\u5411\u4e0d\u660e\uff0c\u8c28\u614e\u53c2\u4e0e"; riskLevel = "\u4e2d";
      } else if (compositeScore > -20) {
        action = "\u5356\u51fa"; actionColor = "down";
        advice = "\u591a\u5468\u671f\u504f\u7a7a\uff0c\u53ef\u51cf\u4ed3"; riskLevel = "\u4e2d\u9ad8";
      } else {
        action = "\u5f3a\u70c8\u5356\u51fa"; actionColor = "down";
        advice = "\u591a\u5468\u671f\u5171\u632f\u770b\u7a7a\uff0c\u5efa\u8bae\u6e05\u4ed3"; riskLevel = "\u9ad8";
      }
    } else if (minScore < -15 && maxScore > 15) {
      consensus = "\u5468\u671f\u51b2\u7a81";
      consensusColor = "neutral";
      action = "\u5efa\u8bae\u89c2\u671b"; actionColor = "neutral";
      advice = "\u5468\u671f\u4fe1\u53f7\u4e25\u91cd\u77db\u76fe\uff0c\u5efa\u8bae\u7b49\u5927\u5468\u671f\u660e\u6717";
      riskLevel = "\u4e2d\u9ad8";
    } else if (compositeScore > 0 && minScore < -10) {
      consensus = "\u9006\u53cd\u53cd\u5f39";
      consensusColor = "neutral";
      action = "\u53cd\u5f39\u8c28\u614e"; actionColor = "neutral";
      advice = "\u5927\u5468\u671f\u7a7a\u5934\uff0c\u77ed\u671f\u53cd\u5f39\uff0c\u5feb\u8fdb\u5feb\u51fa";
      riskLevel = "\u4e2d\u9ad8";
    } else if (compositeScore < 0 && maxScore > 10) {
      consensus = "\u5f3a\u52bf\u6d17\u76d8";
      consensusColor = "up";
      action = "\u53ef\u8003\u8651\u4f4e\u5438"; actionColor = "up";
      advice = "\u5927\u5468\u671f\u591a\u5934\uff0c\u77ed\u671f\u56de\u8c03\uff0c\u662f\u4e70\u70b9";
      riskLevel = "\u4e2d\u4f4e";
    } else {
      consensus = "\u4e00\u822c\u51b2\u7a81";
      consensusColor = "neutral";
      action = compositeScore > 0 ? "\u8f7b\u4ed3\u8bd5\u63a2" : "\u51cf\u4ed3\u89c2\u671b";
      actionColor = "neutral";
      advice = "\u5468\u671f\u4fe1\u53f7\u77db\u76fe\uff0c\u5efa\u8bae\u89c2\u671b\u7b49\u5f85\u660e\u6717";
      riskLevel = "\u4e2d";
    }

    const dominant = details.reduce((max, d) => {
      const importance = Math.abs(d.score) * d.weight;
      const maxImportance = Math.abs(max.score) * max.weight;
      return importance > maxImportance ? d : max;
    });

    return {
      compositeScore: Math.round(compositeScore),
      consensus: consensus,
      consensusColor: consensusColor,
      action: action,
      actionColor: actionColor,
      advice: advice,
      riskLevel: riskLevel,
      details: details.sort((a, b) => Math.abs(b.score) * b.weight - Math.abs(a.score) * a.weight),
      dominantPeriod: dominant.periodName,
      spread: Math.round(spread),
    };
  },

  scoreToStrength(score) {
    if (score >= 40) return { text: "\u5f3a\u70c8\u4e70\u5165", color: "up" };
    if (score >= 20) return { text: "\u4e70\u5165", color: "up" };
    if (score >= 10) return { text: "\u504f\u591a", color: "up" };
    if (score > -10) return { text: "\u9707\u8361", color: "neutral" };
    if (score > -20) return { text: "\u504f\u7a7a", color: "down" };
    if (score > -40) return { text: "\u5356\u51fa", color: "down" };
    return { text: "\u5f3a\u70c8\u5356\u51fa", color: "down" };
  },

  periodName(period) {
    const map = { minute: "\u5206\u65f6", "5day": "5\u65e5", day: "\u65e5K", week: "\u5468K", month: "\u6708K" };
    return map[period] || period;
  },

  scoreToSummary(score) {
    if (score >= 40) return "\u5f3a\u52bf\u770b\u591a";
    if (score >= 20) return "\u504f\u591a";
    if (score >= 10) return "\u6e29\u548c\u770b\u591a";
    if (score > -10) return "\u9707\u8361";
    if (score > -20) return "\u504f\u7a7a";
    if (score > -40) return "\u6e29\u548c\u770b\u7a7a";
    return "\u5f3a\u52bf\u770b\u7a7a";
  },
};
