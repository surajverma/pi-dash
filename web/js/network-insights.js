/* Optional readings are deliberately separate from DNS availability. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiDashInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const known = value => typeof value === 'number' && Number.isFinite(value);
  function duration(seconds) {
    if (!known(seconds) || seconds < 0) return 'Unavailable';
    if (seconds < 60) return '<1 min';
    const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
  }
  function age(stamp, now = Date.now()) {
    if (!known(stamp) || stamp <= 0 || stamp * 1000 > now + 60000) return 'Unavailable';
    const seconds = Math.max(0, (now - stamp * 1000) / 1000);
    return seconds < 60 ? 'Just now' : `${duration(seconds)} ago`;
  }
  function deviceValues(data = {}) {
    return {
      cpu_percent: known(data.cpu_percent) ? `${data.cpu_percent.toFixed(1)}%` : 'Unavailable',
      ram_percent: known(data.ram_percent) ? `${data.ram_percent.toFixed(1)}%` : 'Unavailable',
      temperature: known(data.temperature) ? `${data.temperature.toFixed(1)}°${data.temperature_unit || 'C'}` : 'Unavailable',
      uptime_seconds: duration(data.uptime_seconds),
    };
  }
  function node(doc, tag, className, text) {
    const result = doc.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function coverage(data, noun) {
    if (!data?.contributors) return `${noun} unavailable or hidden by Pi-hole privacy settings`;
    if (data.limited) return 'Partial ranking · source limit reached';
    if (data.partial) return `Partial data · ${data.contributors} of ${data.instances} reporting`;
    return '';
  }
  function renderRanking(target, status, data, noun) {
    const doc = target.ownerDocument;
    target.replaceChildren();
    for (const item of data?.items || []) {
      const row = node(doc, 'li');
      const button = node(doc, 'button', 'ranking-row');
      button.type = 'button';
      button.title = item.label === item.id ? item.label : `${item.label} (${item.id})`;
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', `${button.title}: ${item.count.toLocaleString()} queries, ${item.share.toFixed(1)} percent. Expand name`);
      button.append(node(doc, 'span', 'rank-name', item.label), node(doc, 'span', 'rank-count', item.count.toLocaleString()));
      const identity = node(doc, 'span', 'rank-identity', item.id === item.label ? '' : item.id);
      button.append(identity);
      button.addEventListener('click', () => button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') !== 'true')));
      row.append(button); target.append(row);
    }
    status.textContent = coverage(data, noun) || (!data?.items?.length ? `No ${noun.toLowerCase()} in the reporting window` : '');
  }
  function renderHistory(target, status, data) {
    const doc = target.ownerDocument;
    const points = (data?.points || []).filter(p => known(p.timestamp) && known(p.total) && known(p.blocked));
    target.replaceChildren();
    status.textContent = coverage(data, 'Activity');
    if (points.length < 2) {
      target.append(node(doc, 'p', 'insight-empty', data?.contributors ? 'Not enough history yet' : 'Activity unavailable'));
      return;
    }
    const first = points[0].timestamp, last = points[points.length - 1].timestamp;
    const max = Math.max(1, ...points.map(p => p.total), ...points.map(p => p.blocked));
    const svgNode = tag => doc.createElementNS('http://www.w3.org/2000/svg', tag);
    const svg = svgNode('svg');
    svg.setAttribute('viewBox', '0 0 320 108');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Combined query activity. Peak ${max.toLocaleString()} queries per 10 minutes. ${status.textContent}`);
    const grid = svgNode('path');
    grid.setAttribute('d', 'M2 18 H318 M2 54 H318 M2 90 H318');
    grid.setAttribute('class', 'history-grid'); svg.append(grid);
    const scale = svgNode('text');
    scale.setAttribute('x', '2'); scale.setAttribute('y', '10');
    scale.setAttribute('class', 'history-scale');
    scale.textContent = `Peak ${max.toLocaleString()} / 10 min`; svg.append(scale);
    for (const [field, className] of [['total', 'history-total'], ['blocked', 'history-blocked']]) {
      let segment = [];
      const draw = () => {
        if (!segment.length) return;
        const line = svgNode('polyline');
        line.setAttribute('points', segment.join(' '));
        line.setAttribute('class', className);
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(line); segment = [];
      };
      points.forEach((point, index) => {
        if (index && point.timestamp - points[index - 1].timestamp > 900) draw();
        segment.push(`${2 + (point.timestamp - first) / (last - first) * 316},${90 - point[field] / max * 72}`);
      });
      draw();
    }
    target.append(svg);
    const axes = node(doc, 'div', 'history-axis');
    const spansDay = new Date(first * 1000).toDateString() !== new Date(last * 1000).toDateString();
    const time = stamp => new Date(stamp * 1000).toLocaleString([], { ...(spansDay ? {month:'short',day:'numeric'} : {}), hour: '2-digit', minute: '2-digit' });
    axes.append(node(doc, 'span', '', time(first)), node(doc, 'span', '', time(last))); target.append(axes);
    const legend = node(doc, 'p', 'history-legend');
    legend.append(node(doc, 'span', 'legend-total', 'Queries'), node(doc, 'span', 'legend-blocked', 'Blocked'), node(doc, 'span', '', 'per 10 min'));
    target.append(legend);
    if (data?.partial && data.contributors === data.instances) status.textContent = 'Partial history · some time buckets are missing';
  }
  return { duration, age, deviceValues, renderRanking, renderHistory };
});
