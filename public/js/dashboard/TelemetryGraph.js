// TelemetryGraph — a tiny SVG sparkline. Purely presentational: given an
// array of 0-100 values it returns markup. No timers, no animation loop.
export function telemetryGraph(values, { label = 'history', width = 120, height = 28 } = {}) {
  if (!values || values.length < 2) {
    return `<svg class="cc-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}: collecting data"><line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" class="cc-spark-base"/></svg>`;
  }
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (Math.max(0, Math.min(100, v)) / 100) * (height - 4)).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="cc-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}: latest ${last} percent"><polyline points="${pts}" class="cc-spark-line"/></svg>`;
}
