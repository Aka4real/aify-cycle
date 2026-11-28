/**
 * AifyCycle Ops - Interactive Zero-Dependency SVG Charting Suite
 * Renders smooth multi-series area/line charts, combo user-growth charts,
 * interactive donut charts, horizontal adoption bars, 7x24 activity heatmaps,
 * circular health gauges, and inline KPI sparklines with live hover tooltips.
 */

import { escapeHtml } from './dom-utils.js';

function niceMax(val, minFloor = 4) {
  const n = Math.max(minFloor, Number(val) || 0);
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const frac = n / base;
  let nice;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function buildSmoothPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    // Clamp control point Y to avoid overshoot below baseline
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    const c1y = Math.max(minY, Math.min(maxY, cp1y));
    const c2y = Math.max(minY, Math.min(maxY, cp2y));
    d += ` C ${cp1x.toFixed(1)} ${c1y.toFixed(1)}, ${cp2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function formatAxisTime(iso, rangeKey) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (rangeKey === '1h' || rangeKey === '6h' || rangeKey === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatFullTime(iso, isDateOnly = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  if (isDateOnly) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ensureTooltip(container) {
  let tip = container.querySelector('.adm-chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'adm-chart-tooltip';
    container.appendChild(tip);
  }
  return tip;
}

function positionTooltip(container, tip, clientX, clientY) {
  const rect = container.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const tipW = tip.offsetWidth || 160;
  const tipH = tip.offsetHeight || 72;
  const left = x + tipW + 18 > rect.width ? Math.max(8, x - tipW - 14) : x + 14;
  const top = Math.max(8, Math.min(rect.height - tipH - 8, y - tipH / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/**
 * 1. Interactive Multi-Series Area/Line Chart (Online Concurrency & Gemini Latency)
 */
export function renderAreaLineChart(container, {
  data = [],
  series = [],
  rangeKey = '24h',
  height = 240,
  unit = '',
  emptyMessage = 'No telemetry data recorded in this window yet.'
} = {}) {
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = `<div class="adm-empty">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  const width = 680;
  const pad = { top: 18, right: 16, bottom: 30, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let rawMax = 0;
  for (const row of data) {
    for (const s of series) {
      const v = Number(row[s.key]) || 0;
      if (v > rawMax) rawMax = v;
    }
  }
  const yMax = niceMax(rawMax, 4);
  const yTicks = 4;

  const xFor = (i) => pad.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yFor = (v) => pad.top + plotH - ((Math.max(0, Number(v) || 0) / yMax) * plotH);

  const gradId = `adm_grad_${Math.random().toString(36).slice(2, 8)}`;

  // Grid & Y labels
  let gridSvg = '';
  for (let i = 0; i <= yTicks; i++) {
    const val = Math.round((yMax / yTicks) * i);
    const y = yFor(val);
    gridSvg += `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"
        stroke="var(--adm-border-subtle)" stroke-width="1" ${i > 0 ? 'stroke-dasharray="3 3"' : ''} />
      <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end"
        fill="var(--adm-text-muted)" font-size="10.5" font-family="var(--admin-font-mono)">${val}${escapeHtml(unit)}</text>
    `;
  }

  // X labels (up to 6 evenly spaced)
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  let xLabelsSvg = '';
  for (let i = 0; i < data.length; i += labelStep) {
    const x = xFor(i);
    const label = data[i].label || formatAxisTime(data[i].timestamp, rangeKey);
    xLabelsSvg += `
      <text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle"
        fill="var(--adm-text-muted)" font-size="10.5" font-family="var(--admin-font-mono)">${escapeHtml(label)}</text>
    `;
  }
  // Always ensure last point label isn't clipped if far from previous
  if ((data.length - 1) % labelStep !== 0 && data.length > 2) {
    const lastIdx = data.length - 1;
    xLabelsSvg += `
      <text x="${(xFor(lastIdx) - 4).toFixed(1)}" y="${height - 8}" text-anchor="end"
        fill="var(--adm-text-muted)" font-size="10.5" font-family="var(--admin-font-mono)">Now</text>
    `;
  }

  // Series paths
  let pathsSvg = '';
  series.forEach((s, idx) => {
    const pts = data.map((row, i) => ({ x: xFor(i), y: yFor(row[s.key]) }));
    const linePath = buildSmoothPath(pts);
    if (s.fill || idx === 0) {
      const firstX = pts[0].x.toFixed(1);
      const lastX = pts[pts.length - 1].x.toFixed(1);
      const baseY = (pad.top + plotH).toFixed(1);
      pathsSvg += `<path d="${linePath} L ${lastX} ${baseY} L ${firstX} ${baseY} Z" fill="url(#${gradId}_${idx})" />`;
    }
    pathsSvg += `<path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.2}"
      stroke-linecap="round" stroke-linejoin="round" ${s.dashed ? 'stroke-dasharray="5 4"' : ''} />`;
  });

  // Gradients
  let defsSvg = '';
  series.forEach((s, idx) => {
    defsSvg += `
      <linearGradient id="${gradId}_${idx}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="${idx === 0 ? '0.24' : '0.12'}" />
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0.01" />
      </linearGradient>
    `;
  });

  // Hover indicator markers
  const markersSvg = series.map((s, idx) =>
    `<circle class="adm-hover-dot" data-sidx="${idx}" cx="-20" cy="-20" r="4" fill="${s.color}" stroke="var(--adm-surface)" stroke-width="2" style="display:none;" />`
  ).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Time-series chart">
      <defs>${defsSvg}</defs>
      ${gridSvg}
      ${pathsSvg}
      <line class="adm-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}"
        stroke="var(--adm-border-strong)" stroke-width="1" stroke-dasharray="3 3" style="display:none;" />
      ${markersSvg}
      ${xLabelsSvg}
      <rect class="adm-hit-area" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="transparent" />
    </svg>
  `;

  const svg = container.querySelector('svg');
  const hit = svg.querySelector('.adm-hit-area');
  const crosshair = svg.querySelector('.adm-crosshair');
  const dots = [...svg.querySelectorAll('.adm-hover-dot')];
  const tip = ensureTooltip(container);

  const onMove = (e) => {
    const svgRect = svg.getBoundingClientRect();
    const relX = ((e.clientX - svgRect.left) / svgRect.width) * width;
    const clamped = Math.max(pad.left, Math.min(width - pad.right, relX));
    const idx = data.length <= 1
      ? 0
      : Math.round(((clamped - pad.left) / plotW) * (data.length - 1));
    const row = data[Math.max(0, Math.min(data.length - 1, idx))];
    const px = xFor(idx);

    crosshair.setAttribute('x1', px.toFixed(1));
    crosshair.setAttribute('x2', px.toFixed(1));
    crosshair.style.display = '';

    series.forEach((s, sIdx) => {
      const py = yFor(row[s.key]);
      if (dots[sIdx]) {
        dots[sIdx].setAttribute('cx', px.toFixed(1));
        dots[sIdx].setAttribute('cy', py.toFixed(1));
        dots[sIdx].style.display = '';
      }
    });

    const rowsHtml = series.map(s => `
      <div class="adm-tooltip-row">
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span class="adm-legend-swatch" style="background:${s.color};"></span>
          ${escapeHtml(s.label)}
        </span>
        <span class="adm-tooltip-val">${Number(row[s.key]) || 0}${escapeHtml(unit)}</span>
      </div>
    `).join('');

    tip.innerHTML = `
      <div class="adm-tooltip-title">${escapeHtml(formatFullTime(row.timestamp))}</div>
      ${rowsHtml}
    `;
    tip.classList.add('visible');
    positionTooltip(container, tip, e.clientX, e.clientY);
  };

  const onLeave = () => {
    crosshair.style.display = 'none';
    dots.forEach(d => { d.style.display = 'none'; });
    tip.classList.remove('visible');
  };

  hit.addEventListener('mousemove', onMove);
  hit.addEventListener('mouseleave', onLeave);
}

/**
 * 2. Combined User Growth Chart (Daily New Signups Bars + Cumulative Users & DAU Lines)
 */
export function renderComboGrowthChart(container, data = [], { height = 240 } = {}) {
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="adm-empty">No user growth records available yet.</div>';
    return;
  }

  const width = 680;
  const pad = { top: 18, right: 42, bottom: 30, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxTotal = niceMax(Math.max(...data.map(d => Math.max(d.totalUsers || 0, d.dau || 0))), 5);
  const maxSignups = niceMax(Math.max(...data.map(d => d.newSignups || 0)), 4);

  const stepW = plotW / Math.max(1, data.length);
  const barW = Math.max(4, Math.min(18, stepW * 0.52));

  const xFor = (i) => pad.left + stepW * i + stepW / 2;
  const yTotal = (v) => pad.top + plotH - ((Math.max(0, Number(v) || 0) / maxTotal) * plotH);
  const yBar = (v) => pad.top + plotH - ((Math.max(0, Number(v) || 0) / maxSignups) * (plotH * 0.65));

  const gradId = `adm_growth_${Math.random().toString(36).slice(2, 8)}`;

  let gridSvg = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxTotal / 4) * i);
    const y = yTotal(val);
    gridSvg += `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"
        stroke="var(--adm-border-subtle)" stroke-width="1" ${i > 0 ? 'stroke-dasharray="3 3"' : ''} />
      <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end"
        fill="var(--adm-text-muted)" font-size="10.5" font-family="var(--admin-font-mono)">${val}</text>
    `;
  }

  // Bars for Daily New Signups
  const barsSvg = data.map((row, i) => {
    const cx = xFor(i);
    const topY = yBar(row.newSignups);
    const h = Math.max(0, (pad.top + plotH) - topY);
    if (h <= 0.5) return '';
    return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${topY.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
      rx="3" fill="var(--adm-sage)" opacity="0.52" />`;
  }).join('');

  // Line + area for Cumulative Total Users
  const totalPts = data.map((row, i) => ({ x: xFor(i), y: yTotal(row.totalUsers) }));
  const totalLine = buildSmoothPath(totalPts);
  const totalArea = `${totalLine} L ${totalPts[totalPts.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${totalPts[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;

  // Line for DAU
  const dauPts = data.map((row, i) => ({ x: xFor(i), y: yTotal(row.dau) }));
  const dauLine = buildSmoothPath(dauPts);

  // X Labels
  const step = Math.max(1, Math.ceil(data.length / 6));
  let xLabelsSvg = '';
  for (let i = 0; i < data.length; i += step) {
    const dt = new Date(`${data[i].date}T00:00:00Z`);
    const label = dt.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    xLabelsSvg += `
      <text x="${xFor(i).toFixed(1)}" y="${height - 8}" text-anchor="middle"
        fill="var(--adm-text-muted)" font-size="10.5" font-family="var(--admin-font-mono)">${escapeHtml(label)}</text>
    `;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="User growth chart">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--adm-rose)" stop-opacity="0.2" />
          <stop offset="100%" stop-color="var(--adm-rose)" stop-opacity="0.01" />
        </linearGradient>
      </defs>
      ${gridSvg}
      <path d="${totalArea}" fill="url(#${gradId})" />
      ${barsSvg}
      <path d="${totalLine}" fill="none" stroke="var(--adm-rose)" stroke-width="2.4" stroke-linecap="round" />
      <path d="${dauLine}" fill="none" stroke="var(--adm-blue)" stroke-width="1.9" stroke-dasharray="4 3" stroke-linecap="round" />
      <line class="adm-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}"
        stroke="var(--adm-border-strong)" stroke-width="1" stroke-dasharray="3 3" style="display:none;" />
      <circle class="adm-dot-total" cx="-20" cy="-20" r="4" fill="var(--adm-rose)" stroke="var(--adm-surface)" stroke-width="2" style="display:none;" />
      <circle class="adm-dot-dau" cx="-20" cy="-20" r="3.5" fill="var(--adm-blue)" stroke="var(--adm-surface)" stroke-width="2" style="display:none;" />
      ${xLabelsSvg}
      <rect class="adm-hit-area" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="transparent" />
    </svg>
  `;

  const svg = container.querySelector('svg');
  const hit = svg.querySelector('.adm-hit-area');
  const crosshair = svg.querySelector('.adm-crosshair');
  const dotTotal = svg.querySelector('.adm-dot-total');
  const dotDau = svg.querySelector('.adm-dot-dau');
  const tip = ensureTooltip(container);

  hit.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const idx = Math.max(0, Math.min(data.length - 1, Math.floor((relX - pad.left) / stepW)));
    const row = data[idx];
    const px = xFor(idx);

    crosshair.setAttribute('x1', px.toFixed(1));
    crosshair.setAttribute('x2', px.toFixed(1));
    crosshair.style.display = '';

    dotTotal.setAttribute('cx', px.toFixed(1));
    dotTotal.setAttribute('cy', yTotal(row.totalUsers).toFixed(1));
    dotTotal.style.display = '';

    dotDau.setAttribute('cx', px.toFixed(1));
    dotDau.setAttribute('cy', yTotal(row.dau).toFixed(1));
    dotDau.style.display = '';

    tip.innerHTML = `
      <div class="adm-tooltip-title">${escapeHtml(formatFullTime(`${row.date}T00:00:00Z`, true))}</div>
      <div class="adm-tooltip-row">
        <span><span class="adm-legend-swatch" style="background:var(--adm-rose);"></span> Total Users</span>
        <span class="adm-tooltip-val">${row.totalUsers}</span>
      </div>
      <div class="adm-tooltip-row">
        <span><span class="adm-legend-swatch" style="background:var(--adm-sage);"></span> New Signups</span>
        <span class="adm-tooltip-val">+${row.newSignups}</span>
      </div>
      <div class="adm-tooltip-row">
        <span><span class="adm-legend-swatch" style="background:var(--adm-blue);"></span> Daily Active</span>
        <span class="adm-tooltip-val">${row.dau}</span>
      </div>
    `;
    tip.classList.add('visible');
    positionTooltip(container, tip, e.clientX, e.clientY);
  });

  hit.addEventListener('mouseleave', () => {
    crosshair.style.display = 'none';
    dotTotal.style.display = 'none';
    dotDau.style.display = 'none';
    tip.classList.remove('visible');
  });
}

/**
 * 3. Sleek SVG Ring Donut Chart
 */
export function renderDonutChart(container, items = [], {
  centerLabel = 'Total',
  centerValue = null,
  colors = ['var(--adm-rose)', 'var(--adm-sage)', 'var(--adm-blue)', 'var(--adm-amber)', 'var(--adm-coral)']
} = {}) {
  if (!container) return;
  const total = items.reduce((acc, it) => acc + (Number(it.count) || 0), 0);
  const displayCenter = centerValue !== null ? centerValue : total;

  const r = 60;
  const c = 2 * Math.PI * r;
  let offset = 0;

  let ringsSvg = '';
  if (total === 0) {
    ringsSvg = `<circle cx="82" cy="82" r="${r}" fill="none" stroke="var(--adm-bg-subtle)" stroke-width="16" />`;
  } else {
    items.forEach((it, idx) => {
      const val = Number(it.count) || 0;
      if (val <= 0) return;
      const frac = val / total;
      const len = Math.max(2, frac * c - (items.length > 1 ? 3 : 0));
      const color = it.color || colors[idx % colors.length];
      ringsSvg += `
        <circle cx="82" cy="82" r="${r}" fill="none" stroke="${color}" stroke-width="16"
          stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 82 82)" />
      `;
      offset += frac * c;
    });
  }

  const legendHtml = items.map((it, idx) => {
    const val = Number(it.count) || 0;
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    const color = it.color || colors[idx % colors.length];
    return `
      <div class="adm-donut-legend-row">
        <div class="adm-donut-legend-left">
          <span class="adm-legend-swatch" style="background:${color};"></span>
          <span>${escapeHtml(it.label)}</span>
        </div>
        <div class="adm-donut-legend-val">${val} <span style="color:var(--adm-text-muted);font-weight:500;font-size:11.5px;">(${pct}%)</span></div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="adm-donut-wrap">
      <div class="adm-donut-svg-wrap">
        <svg viewBox="0 0 164 164" role="img" aria-label="${escapeHtml(centerLabel)} distribution">
          <circle cx="82" cy="82" r="${r}" fill="none" stroke="var(--adm-bg-subtle)" stroke-width="16" />
          ${ringsSvg}
          <text x="82" y="79" text-anchor="middle" fill="var(--adm-text)" font-size="24" font-weight="700" font-family="var(--admin-font-num)">${escapeHtml(String(displayCenter))}</text>
          <text x="82" y="98" text-anchor="middle" fill="var(--adm-text-muted)" font-size="11" font-weight="600">${escapeHtml(centerLabel)}</text>
        </svg>
      </div>
      <div class="adm-donut-legend">${legendHtml || '<div class="adm-empty">No entries</div>'}</div>
    </div>
  `;
}

/**
 * 4. Horizontal Adoption / Distribution Bars
 */
export function renderHorizontalBars(container, items = [], {
  color = 'var(--adm-rose)',
  emptyMessage = 'No activity captured yet.'
} = {}) {
  if (!container) return;
  if (!items || items.length === 0) {
    container.innerHTML = `<div class="adm-empty">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  const maxVal = Math.max(1, ...items.map(i => Number(i.value) || 0));
  const total = items.reduce((a, b) => a + (Number(b.value) || 0), 0);

  container.innerHTML = `
    <div class="adm-bar-list">
      ${items.map(it => {
        const val = Number(it.value) || 0;
        const pctWidth = Math.max(val > 0 ? 4 : 0, Math.round((val / maxVal) * 100));
        const sharePct = total > 0 ? Math.round((val / total) * 100) : 0;
        const fillColor = it.color || color;
        return `
          <div class="adm-bar-row">
            <div class="adm-bar-meta">
              <span style="font-weight:600;">${escapeHtml(it.label)}</span>
              <span class="num" style="color:var(--adm-text-secondary);">${val} <span style="color:var(--adm-text-muted);font-size:11px;">(${sharePct}%)</span></span>
            </div>
            <div class="adm-bar-track">
              <div class="adm-bar-fill" style="width:${pctWidth}%;background:${fillColor};"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * 5. 7x24 Activity Intensity Heatmap
 */
export function renderActivityHeatmap(container, heatmap) {
  if (!container) return;
  if (!heatmap || !Array.isArray(heatmap.matrix)) {
    container.innerHTML = '<div class="adm-empty">No session activity recorded yet.</div>';
    return;
  }

  const max = Math.max(1, Number(heatmap.max) || 0);
  const days = heatmap.days || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let html = '<div class="adm-heatmap-wrap"><div class="adm-heatmap-grid">';
  html += '<div></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="adm-heatmap-hour">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>`;
  }

  for (let d = 0; d < 7; d++) {
    html += `<div class="adm-heatmap-day">${escapeHtml(days[d])}</div>`;
    for (let h = 0; h < 24; h++) {
      const val = Number(heatmap.matrix[d]?.[h]) || 0;
      let lvl = '';
      if (val > 0) {
        const ratio = val / max;
        if (ratio > 0.75) lvl = 'lvl-4';
        else if (ratio > 0.45) lvl = 'lvl-3';
        else if (ratio > 0.2) lvl = 'lvl-2';
        else lvl = 'lvl-1';
      }
      const title = `${days[d]} ${String(h).padStart(2, '0')}:00 UTC — ${val} activity signal${val === 1 ? '' : 's'}`;
      html += `<div class="adm-heatmap-cell ${lvl}" title="${escapeHtml(title)}"></div>`;
    }
  }
  html += '</div></div>';
  container.innerHTML = html;
}

/**
 * 6. Circular Health / Integrity Score Gauge (0-100)
 */
export function renderHealthGauge(container, score = 0, label = 'Score') {
  if (!container) return;
  const clamped = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const r = 44;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const color = clamped >= 85 ? 'var(--adm-sage)' : clamped >= 60 ? 'var(--adm-amber)' : 'var(--adm-red)';

  container.innerHTML = `
    <svg class="adm-gauge-svg" viewBox="0 0 112 112" role="img" aria-label="${escapeHtml(label)} ${clamped} out of 100">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--adm-bg-subtle)" stroke-width="10" />
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="${color}" stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(-90 56 56)" />
      <text x="56" y="55" text-anchor="middle" fill="var(--adm-text)" font-size="25" font-weight="700" font-family="var(--admin-font-num)">${clamped}</text>
      <text x="56" y="72" text-anchor="middle" fill="var(--adm-text-muted)" font-size="10.5" font-weight="600">${escapeHtml(label)}</text>
    </svg>
  `;
}

/**
 * 7. Inline KPI Sparkline SVG String
 */
export function renderSparklineSvg(values = [], color = 'var(--adm-rose)') {
  if (!values || values.length < 2) return '';
  const w = 68;
  const h = 24;
  const max = Math.max(1, ...values.map(v => Number(v) || 0));
  const min = Math.min(0, ...values.map(v => Number(v) || 0));
  const span = Math.max(1, max - min);

  const pts = values.map((v, i) => ({
    x: 2 + (i / (values.length - 1)) * (w - 4),
    y: h - 3 - (((Number(v) || 0) - min) / span) * (h - 6)
  }));
  const path = buildSmoothPath(pts);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" />
  </svg>`;
}
