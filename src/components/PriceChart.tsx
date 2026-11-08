import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../lib/api';
import type { Candle, QuoteSymbol } from '../lib/types';
import { clsx, fmtNum, fmtUsd } from '../lib/format';

const INTERVALS: [string, number][] = [
  ['1m', 60],
  ['5m', 300],
  ['15m', 900],
  ['1h', 3600],
  ['4h', 14400],
  ['1d', 86400],
];

export function PriceChart({ coinId, quote, refreshKey }: { coinId: string; quote: QuoteSymbol; refreshKey: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const fitted = useRef(false);
  const [interval, setIntervalSec] = useState(300);
  const [unit, setUnit] = useState<'usd' | 'quote'>('usd');
  const [count, setCount] = useState<number | null>(null);

  // create chart once
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#7b7468', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
      grid: { vertLines: { color: '#f1ece1' }, horzLines: { color: '#f1ece1' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#e7e1d5', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: '#e7e1d5', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScale: { axisPressedMouseMove: true },
    });
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: '#1f9d6b',
      downColor: '#d24b54',
      wickUpColor: '#1f9d6b',
      wickDownColor: '#d24b54',
      borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    volSeries.current = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: '#d9a44155',
    });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      candleSeries.current = null;
      volSeries.current = null;
    };
  }, []);

  // formatter depends on unit
  useEffect(() => {
    chart.current?.applyOptions({
      localization: {
        priceFormatter: (p: number) => (unit === 'usd' ? fmtUsd(p) : `${fmtNum(p, p < 10 ? 3 : 1)} ${quote}`),
      },
    });
  }, [unit, quote]);

  // reset zoom when the series identity changes
  useEffect(() => {
    fitted.current = false;
  }, [coinId, interval, unit]);

  // load data
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ candles: Candle[] }>(`/coins/${coinId}/candles?interval=${interval}&unit=${unit}`, { signal: ctrl.signal })
      .then((r) => {
        setCount(r.candles.length);
        candleSeries.current?.setData(
          r.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
        );
        volSeries.current?.setData(
          r.candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? '#1f9d6b44' : '#d24b5444',
          })),
        );
        if (!fitted.current && r.candles.length) {
          chart.current?.timeScale().fitContent();
          fitted.current = true;
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [coinId, interval, unit, refreshKey]);

  return (
    <div className="card chart-card">
      <div className="chart-toolbar">
        {INTERVALS.map(([label, sec]) => (
          <button key={label} className={clsx('chip', interval === sec && 'on')} onClick={() => setIntervalSec(sec)}>
            {label}
          </button>
        ))}
        <span className="right" />
        <div className="seg" style={{ minWidth: 150 }} role="group" aria-label="Chart units">
          <button className={clsx(unit === 'usd' && 'on')} onClick={() => setUnit('usd')}>USD</button>
          <button className={clsx(unit === 'quote' && 'on')} onClick={() => setUnit('quote')}>{quote}</button>
        </div>
      </div>
      <div className="chart-box">
        <div ref={el} style={{ position: 'absolute', inset: 0 }} />
        {count === 0 && <div className="chart-empty">No trades yet</div>}
      </div>
      <div className="xs muted" style={{ padding: '6px 4px 4px' }}>Market cap · candles are built from this coin's trades.</div>
    </div>
  );
}
