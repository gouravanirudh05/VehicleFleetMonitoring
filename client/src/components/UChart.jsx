import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export const AXIS = {
  stroke: '#75604F',
  grid: { stroke: 'rgba(28,28,28,.07)', width: 1 },
  ticks: { stroke: 'rgba(28,28,28,.16)', width: 1 },
  font: '11px "IBM Plex Mono", ui-monospace, monospace',
};

/**
 * Thin uPlot wrapper. uPlot draws to canvas and handles tens of thousands of points, so live
 * charts can be fed new data several times a second without React re-rendering any SVG.
 * `makeOptions(width)` is called once; later data changes only call setData.
 */
export default function UChart({ makeOptions, data, height = 180, deps = [] }) {
  const el = useRef(null);
  const plot = useRef(null);

  useEffect(() => {
    const node = el.current;
    const opts = { height, width: node.clientWidth || 300, ...makeOptions() };
    opts.axes = (opts.axes || [{}, {}]).map((a) => ({ ...AXIS, ...a }));
    plot.current = new uPlot(opts, data, node);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: node.clientWidth, height }));
    ro.observe(node);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, ...deps]);

  useEffect(() => {
    if (plot.current && data) plot.current.setData(data);
  }, [data]);

  return <div ref={el} className="uchart" />;
}
