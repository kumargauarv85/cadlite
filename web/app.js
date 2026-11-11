/* CADLite – viewer UI: rendering, layers, layouts, measuring, export. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const ACCENT = '#ffb020';
const MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const UNIT_LABEL = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft', none: '' };
const INSUNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const HINTS = {
  pan: 'Drag to pan · scroll to zoom · double-click to fit',
  dist: 'Distance: click two points',
  path: 'Path: click points · Enter or double-click to finish · Backspace removes the last point',
  area: 'Area: click the corners · Enter or double-click to finish',
  angle: 'Angle: click a point on the first side, then the corner, then the second side',
  radius: 'Radius: click a circle or arc',
};

const S = {
  doc: null, orig: null, spaces: [], cur: 0, model: null, layerOn: [], layerInit: [],
  view: { cx: 0, cy: 0, k: 1 }, tool: 'pan', snap: true, dark: true,
  pending: null, hover: null, drawUnit: 'mm', mmPerUnit: 1, dispUnit: 'mm', dispTouched: false, calib: false, prec: 2,
  server: location.protocol.indexOf('http') === 0, info: null, W: 0, H: 0, dpr: 1,
};

/* ---------- small helpers ---------- */
const api = (p) => 'api/' + p;
function toast(msg, err, ms) {
  const t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms || (err ? 9000 : 5000));
}
function busy(msg) { $('busy').hidden = !msg; if (msg) $('busyText').textContent = msg; }
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const inv = (M) => { const d = M[0] * M[3] - M[1] * M[2]; return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d]; };
const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const space = () => S.spaces[S.cur];

const mcv = document.createElement('canvas').getContext('2d');
mcv.font = '100px Arial, "Liberation Sans", "DejaVu Sans", sans-serif';
DXF.setMeasure((s) => mcv.measureText(s).width / 72);

/* ---------- colours ---------- */
const cssCache = new Map();
function css(c) {
  const key = c + (S.dark ? 0.5 : 0.25);
  let v = cssCache.get(key);
  if (v) return v;
  if (c < 0) v = S.dark ? '#e8eaed' : '#111111';
  else {
    let r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (S.dark && lum < 55) { const f = 55 - lum; r = Math.min(255, r + f * 1.6); g = Math.min(255, g + f * 1.6); b = Math.min(255, b + f * 2.2); }
    else if (!S.dark && lum > 200) { const f = 150 / lum; r *= f; g *= f; b *= f; }
    v = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  cssCache.set(key, v);
  return v;
}

/* ---------- rendering ---------- */
const DASH = [[], [8, 5], [14, 4, 2, 4], [2, 4]];
const FONT = '100px Arial, "Liberation Sans", "DejaVu Sans", sans-serif';
function hidden(p, frozen) {
  const on = S.layerOn;
  if (!on[p.li] || (p.l2 >= 0 && !on[p.l2])) return true;
  return !!frozen && (frozen.has(p.li) || frozen.has(p.l2));
}
function drawPrims(c, prims, T, frozen, scr) {
  const I = inv(T), dpr = S.dpr;
  let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity;
  for (const q of [[scr[0], scr[1]], [scr[2], scr[1]], [scr[2], scr[3]], [scr[0], scr[3]]]) {
    const p = ap(I, q[0], q[1]); vx0 = Math.min(vx0, p[0]); vx1 = Math.max(vx1, p[0]); vy0 = Math.min(vy0, p[1]); vy1 = Math.max(vy1, p[1]);
  }
  const a = T[0], b = T[1], cc = T[2], d = T[3], e = T[4], f = T[5];
  const s = Math.hypot(a, b), phi = Math.atan2(b, a);
  let key = null, open = false, cnt = 0;
  const texts = [];
  const flush = () => { if (open) { c.stroke(); open = false; } };
  c.lineWidth = 1; c.lineJoin = 'round';
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i], bb = p.bb;
    if (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1) continue;
    if (hidden(p, frozen)) continue;
    const size = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * s;
    if (p.k === 3) { if (p.h * s >= 2.5) texts.push(p); continue; }
    if (p.k === 2) {
      if (size < 1.5) continue;
      flush(); key = null;
      c.beginPath();
      for (const l of p.loops) {
        c.moveTo(a * l[0] + cc * l[1] + e, b * l[0] + d * l[1] + f);
        for (let k = 2; k < l.length; k += 2) c.lineTo(a * l[k] + cc * l[k + 1] + e, b * l[k] + d * l[k + 1] + f);
        c.closePath();
      }
      c.globalAlpha = p.solid ? 0.85 : 0.16; c.fillStyle = css(p.c); c.fill('evenodd'); c.globalAlpha = 1;
      continue;
    }
    const kk = p.c * 4 + p.d;
    if (kk !== key || cnt > 4000) { flush(); c.strokeStyle = css(p.c); c.setLineDash(DASH[p.d]); c.beginPath(); open = true; key = kk; cnt = 0; }
    cnt++;
    if (size < 0.9 && p.k !== 4) {
      const x = a * bb[0] + cc * bb[1] + e, y = b * bb[0] + d * bb[1] + f;
      c.moveTo(x, y); c.lineTo(x + 0.9, y); continue;
    }
    if (p.k === 0) {
      const q = p.p;
      c.moveTo(a * q[0] + cc * q[1] + e, b * q[0] + d * q[1] + f);
      for (let k = 2; k < q.length; k += 2) c.lineTo(a * q[k] + cc * q[k + 1] + e, b * q[k] + d * q[k + 1] + f);
      if (p.cl) c.closePath();
    } else if (p.k === 1) {
      const x = a * p.x + cc * p.y + e, y = b * p.x + d * p.y + f, r = p.r * s;
      c.moveTo(x + r * Math.cos(phi - p.a0), y + r * Math.sin(phi - p.a0));
      c.arc(x, y, r, phi - p.a0, phi - p.a1, true);
    } else if (p.k === 4) {
      const x = a * p.x + cc * p.y + e, y = b * p.x + d * p.y + f;
      c.moveTo(x - 2, y); c.lineTo(x + 2, y); c.moveTo(x, y - 2); c.lineTo(x, y + 2);
    }
  }
  flush(); c.setLineDash([]);
  if (texts.length) {
    c.font = FONT;
    for (const p of texts) {
      const cr = Math.cos(p.rot), sr = Math.sin(p.rot);
      const ux = (a * cr + cc * sr) / s, uy = (b * cr + d * sr) / s, sc = p.h * s / 72;
      c.setTransform(dpr * ux * sc * p.wf, dpr * uy * sc * p.wf, -dpr * uy * sc, dpr * ux * sc, dpr * (a * p.x + cc * p.y + e), dpr * (b * p.x + d * p.y + f));
      c.fillStyle = css(p.c);
      c.textAlign = p.ha === 1 ? 'center' : p.ha === 2 ? 'right' : 'left';
      c.textBaseline = p.va === 1 ? 'bottom' : p.va === 2 ? 'middle' : p.va === 3 ? 'top' : 'alphabetic';
      if (p.va === 3) c.translate(0, -17); // canvas "top" sits above cap height
      c.fillText(p.s, 0, 0);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
const viewM = (W, H, v) => [v.k, 0, 0, -v.k, W / 2 - v.cx * v.k, H / 2 + v.cy * v.k];

function render(c, W, H, v, withOverlay) {
  c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  c.fillStyle = S.dark ? '#14161a' : '#ffffff';
  c.fillRect(0, 0, W, H);
  const sp = space(); if (!sp) return;
  const V = viewM(W, H, v);
  drawPrims(c, sp.prims, V, null, [0, 0, W, H]);
  for (const vp of sp.vps) {
    const x0 = vp.e.cx - vp.e.w / 2, y0 = vp.e.cy - vp.e.hh / 2, x1 = x0 + vp.e.w, y1 = y0 + vp.e.hh;
    const p0 = ap(V, x0, y1), p1 = ap(V, x1, y0);
    if (p1[0] < 0 || p0[0] > W || p1[1] < 0 || p0[1] > H) continue;
    c.save(); c.beginPath(); c.rect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]); c.clip();
    drawPrims(c, S.model.prims, DXF.mul(V, vp.M), vp.e.frozenIdx, [Math.max(0, p0[0]), Math.max(0, p0[1]), Math.min(W, p1[0]), Math.min(H, p1[1])]);
    c.restore();
    c.strokeStyle = S.dark ? '#5d6673' : '#9aa3ad'; c.lineWidth = 1; c.setLineDash([3, 3]);
    c.strokeRect(p0[0] + 0.5, p0[1] + 0.5, p1[0] - p0[0], p1[1] - p0[1]); c.setLineDash([]);
  }
  if (withOverlay) drawOverlay(c, V);
}
let rafPending = false;
function redraw() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(ctx, S.W, S.H, S.view, true); }); }

function resize() {
  const r = $('stage').getBoundingClientRect();
  S.dpr = window.devicePixelRatio || 1; S.W = Math.max(50, r.width); S.H = Math.max(50, r.height);
  cv.width = Math.round(S.W * S.dpr); cv.height = Math.round(S.H * S.dpr);
  redraw();
}
function fit() {
  const sp = space(); if (!sp) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sp.prims) { if (hidden(p, null)) continue; const b = p.bb; if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
  for (const vp of sp.vps) { x0 = Math.min(x0, vp.e.cx - vp.e.w / 2); y0 = Math.min(y0, vp.e.cy - vp.e.hh / 2); x1 = Math.max(x1, vp.e.cx + vp.e.w / 2); y1 = Math.max(y1, vp.e.cy + vp.e.hh / 2); }
  if (!isFinite(x0)) { x0 = sp.bbox[0]; y0 = sp.bbox[1]; x1 = sp.bbox[2]; y1 = sp.bbox[3]; }
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  S.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: Math.min(S.W / w, S.H / h) * 0.93 };
  redraw();
}

/* ---------- units & formatting ---------- */
function fmtNum(v) { return v.toLocaleString('en-US', { minimumFractionDigits: S.prec, maximumFractionDigits: S.prec }); }
function unitFactor() { // drawing units -> display unit
  return { f: S.mmPerUnit / MM[S.dispUnit], u: UNIT_LABEL[S.dispUnit] };
}
function fmtLen(v, paper) { if (paper) return fmtNum(v) + ' (paper units)'; const u = unitFactor(); return fmtNum(v * u.f) + (u.u ? ' ' + u.u : ''); }
function fmtArea(v, paper) { if (paper) return fmtNum(v) + ' (paper units²)'; const u = unitFactor(); return fmtNum(v * u.f * u.f) + (u.u ? ' ' + u.u + '²' : ' sq. units'); }

/* ---------- snapping ---------- */
function snapIn(prims, x, y, tol, frozen) {
  let bp = null, bn = null; const segs = [];
  const pt = (px, py, t) => { const dd = Math.hypot(px - x, py - y); if (dd <= tol && (!bp || dd < bp.d)) bp = { x: px, y: py, t, d: dd }; };
  const near = (px, py) => { const dd = Math.hypot(px - x, py - y); if (dd <= tol && (!bn || dd < bn.d)) bn = { x: px, y: py, t: 'near', d: dd }; };
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i], bb = p.bb;
    if (x < bb[0] - tol || x > bb[2] + tol || y < bb[1] - tol || y > bb[3] + tol) continue;
    if (p.k === 3 || hidden(p, frozen)) continue;
    if (p.k === 4) { pt(p.x, p.y, 'node'); continue; }
    if (p.k === 1) {
      pt(p.x, p.y, 'cen');
      const dx = x - p.x, dy = y - p.y, dd = Math.hypot(dx, dy);
      const inArc = (ang) => { if (p.full) return true; let t = ((ang - p.a0) % TAU + TAU) % TAU; return t <= p.a1 - p.a0; };
      if (!p.full) { pt(p.x + p.r * Math.cos(p.a0), p.y + p.r * Math.sin(p.a0), 'end'); pt(p.x + p.r * Math.cos(p.a1), p.y + p.r * Math.sin(p.a1), 'end'); }
      for (let q = 0; q < 4; q++) if (inArc(q * Math.PI / 2)) pt(p.x + p.r * Math.cos(q * Math.PI / 2), p.y + p.r * Math.sin(q * Math.PI / 2), 'quad');
      if (dd > 0 && inArc(Math.atan2(dy, dx))) near(p.x + dx / dd * p.r, p.y + dy / dd * p.r);
      continue;
    }
    const lists = p.k === 2 ? p.loops : [p.p];
    for (const q of lists) {
      const n = q.length, closed = p.k === 2 || p.cl, big = n > 8000;
      if (p.ends) for (let k = 0; k < p.ends.length; k += 2) pt(p.ends[k], p.ends[k + 1], 'end');
      const last = closed ? n : n - 2;
      for (let k = 0; k < n; k += 2) {
        const x1 = q[k], y1 = q[k + 1];
        if (!p.ends) pt(x1, y1, 'end');
        if (k >= last) continue;
        const x2 = q[(k + 2) % n], y2 = q[(k + 3) % n];
        if (Math.max(x1, x2) < x - tol || Math.min(x1, x2) > x + tol || Math.max(y1, y2) < y - tol || Math.min(y1, y2) > y + tol) continue;
        if (!p.ends && !big) pt((x1 + x2) / 2, (y1 + y2) / 2, 'mid');
        const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
        let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const nx = x1 + t * dx, ny = y1 + t * dy;
        if (Math.hypot(nx - x, ny - y) <= tol) { near(nx, ny); if (segs.length < 60) segs.push([x1, y1, x2, y2]); }
      }
    }
  }
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j];
    const d1x = A[2] - A[0], d1y = A[3] - A[1], d2x = B[2] - B[0], d2y = B[3] - B[1], den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12 * (Math.abs(d1x * d2x) + Math.abs(d1y * d2y) + 1e-300)) continue;
    const t = ((B[0] - A[0]) * d2y - (B[1] - A[1]) * d2x) / den, u = ((B[0] - A[0]) * d1y - (B[1] - A[1]) * d1x) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
    pt(A[0] + t * d1x, A[1] + t * d1y, 'int');
  }
  return bp || bn;
}
function vpAt(sp, x, y) {
  let best = null;
  for (const vp of sp.vps) {
    const e = vp.e;
    if (Math.abs(x - e.cx) <= e.w / 2 && Math.abs(y - e.cy) <= e.hh / 2 && (!best || e.w * e.hh < best.e.w * best.e.hh)) best = vp;
  }
  return best;
}
// Returns a measuring point: position in the current tab's space (x,y) and, when inside a viewport, the real model position (mx,my).
function pick(sx, sy) {
  const sp = space(), v = S.view;
  const x = v.cx + (sx - S.W / 2) / v.k, y = v.cy - (sy - S.H / 2) / v.k;
  const tol = 11 / v.k;
  const vp = vpAt(sp, x, y);
  const res = { x, y, vp: vp || null, mx: x, my: y, t: null };
  if (vp) { const m = ap(vp.I, x, y); res.mx = m[0]; res.my = m[1]; }
  if (!S.snap) return res;
  let best = snapIn(sp.prims, x, y, tol, null), bestVp = null;
  if (vp) {
    const m = snapIn(S.model.prims, res.mx, res.my, tol / vp.k, vp.e.frozenIdx);
    if (m) {
      const pp = ap(vp.M, m.x, m.y), dd = Math.hypot(pp[0] - x, pp[1] - y);
      const better = !best || (m.t !== 'near' && best.t === 'near') || ((m.t === 'near') === (best.t === 'near') && dd < best.d);
      if (better) { best = { x: pp[0], y: pp[1], t: m.t, d: dd }; bestVp = m; }
    }
  }
  if (best) {
    res.x = best.x; res.y = best.y; res.t = best.t;
    if (bestVp) { res.mx = bestVp.x; res.my = bestVp.y; }
    else if (vp) { const m = ap(vp.I, best.x, best.y); res.mx = m[0]; res.my = m[1]; }
    else { res.mx = best.x; res.my = best.y; }
  }
  return res;
}
function pickArc(sx, sy) {
  const sp = space(), v = S.view;
  const x = v.cx + (sx - S.W / 2) / v.k, y = v.cy - (sy - S.H / 2) / v.k, tol = 9 / v.k;
  const search = (prims, px, py, tl, frozen) => {
    let b = null;
    for (const p of prims) {
      if (p.k !== 1 || hidden(p, frozen)) continue;
      const dd = Math.abs(Math.hypot(px - p.x, py - p.y) - p.r);
      if (dd > tl) continue;
      if (!p.full) { const t = ((Math.atan2(py - p.y, px - p.x) - p.a0) % TAU + TAU) % TAU; if (t > p.a1 - p.a0) continue; }
      if (!b || dd < b.d) b = { p, d: dd };
    }
    return b;
  };
  const vp = vpAt(sp, x, y);
  let hit = search(sp.prims, x, y, tol, null);
  if (hit) return { x: hit.p.x, y: hit.p.y, rs: hit.p.r, r: hit.p.r, paper: !sp.layout.isModel };
  if (vp) {
    const m = ap(vp.I, x, y); hit = search(S.model.prims, m[0], m[1], tol / vp.k, vp.e.frozenIdx);
    if (hit) { const c = ap(vp.M, hit.p.x, hit.p.y); return { x: c[0], y: c[1], rs: hit.p.r * vp.k, r: hit.p.r, paper: false, vp }; }
  }
  return null;
}

/* ---------- measurements ---------- */
function calibrate(m) {
  S.calib = false; $('btnCal').classList.remove('on');
  const vp0 = m.pts[0].vp, same = !!vp0 && m.pts.every((p) => p.vp === vp0);
  if (!space().layout.isModel && !same) { toast('Calibrate on the Model tab or inside one viewport, not across the sheet.', true); return; }
  const q = m.pts.map((p) => same ? [p.mx, p.my] : [p.x, p.y]);
  const raw = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  if (!(raw > 0)) return;
  const ans = window.prompt('Real length between these two points, in ' + S.dispUnit + ':', '');
  const val = ans === null ? NaN : parseFloat(String(ans).replace(/,/g, ''));
  if (!(val > 0)) { toast('Calibration cancelled.'); return; }
  S.mmPerUnit = val * MM[S.dispUnit] / raw; S.drawUnit = 'custom';
  const o = $('selDraw').querySelector('[value=custom]'); o.hidden = false;
  o.textContent = (+S.mmPerUnit.toPrecision(5)) + ' mm (calibrated)'; $('selDraw').value = 'custom';
  toast('Scale set: 1 drawing unit = ' + (+S.mmPerUnit.toPrecision(5)) + ' mm');
}
function evalMeas(m, extra) {
  const sp = space();
  const pts = extra ? m.pts.concat([extra]) : m.pts;
  if (m.type === 'radius') return { main: 'R ' + fmtLen(m.r, m.paper), sub: ['Diameter ' + fmtLen(m.r * 2, m.paper), 'Circumference ' + fmtLen(m.r * TAU, m.paper)], paper: m.paper };
  const vp0 = pts.length ? pts[0].vp : null;
  const same = !!vp0 && pts.every((p) => p.vp === vp0);
  const paper = !sp.layout.isModel && !same;
  const q = pts.map((p) => same ? [p.mx, p.my] : [p.x, p.y]);
  const sub = [];
  if (same) sub.push('Model units via viewport ' + scaleLabel(vp0.k));
  let main = '';
  if (m.type === 'dist' || m.type === 'path') {
    let len = 0; for (let i = 1; i < q.length; i++) len += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
    main = fmtLen(len, paper);
    if (q.length === 2) {
      const dx = q[1][0] - q[0][0], dy = q[1][1] - q[0][1];
      sub.unshift('ΔX ' + fmtLen(Math.abs(dx), paper) + ' · ΔY ' + fmtLen(Math.abs(dy), paper) + ' · ' + fmtNum(((Math.atan2(dy, dx) / DEG) + 360) % 360) + '°');
    } else if (q.length > 2) sub.unshift((q.length - 1) + ' segments');
  } else if (m.type === 'area') {
    let a = 0, per = 0;
    for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; per += Math.hypot(n[0] - p[0], n[1] - p[1]); }
    main = fmtArea(Math.abs(a) / 2, paper); sub.unshift('Perimeter ' + fmtLen(per, paper));
  } else if (m.type === 'angle') {
    if (q.length === 3) {
      const a1 = Math.atan2(q[0][1] - q[1][1], q[0][0] - q[1][0]), a2 = Math.atan2(q[2][1] - q[1][1], q[2][0] - q[1][0]);
      let d = Math.abs(a2 - a1) / DEG; if (d > 180) d = 360 - d;
      main = fmtNum(d) + '°'; sub.unshift('Reflex ' + fmtNum(360 - d) + '°');
    } else main = '…';
  }
  return { main, sub, paper };
}
function scaleLabel(k) {
  if (k <= 0) return '';
  const r = 1 / k, n = (v) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2));
  return k <= 1 ? '1:' + n(r) : n(k) + ':1';
}
const TITLE = { dist: 'Distance', path: 'Path', area: 'Area', angle: 'Angle', radius: 'Radius' };
function refreshMeasList() {
  const sp = space(), ul = $('measList'); ul.textContent = '';
  const list = sp ? sp.meas : [];
  $('measEmpty').hidden = list.length > 0;
  list.forEach((m, i) => {
    const r = evalMeas(m), li = document.createElement('li'), v = document.createElement('div'), x = document.createElement('button');
    v.className = 'v';
    const b = document.createElement('b'); b.textContent = r.main; v.append(TITLE[m.type] + ' ', b);
    for (const s of r.sub) { const sn = document.createElement('span'); sn.textContent = s; v.append(sn); }
    x.textContent = '×'; x.title = 'Remove'; x.setAttribute('aria-label', 'Remove measurement');
    x.onclick = () => { list.splice(i, 1); refreshMeasList(); redraw(); };
    li.append(v, x); ul.append(li);
  });
}
function label(c, x, y, text) {
  c.font = '600 12px system-ui, sans-serif';
  const w = c.measureText(text).width + 12;
  x = Math.max(4, Math.min(S.W - w - 4, x - w / 2)); y = Math.max(4, Math.min(S.H - 24, y - 10));
  c.fillStyle = 'rgba(15,17,20,0.88)'; c.beginPath(); c.roundRect(x, y, w, 20, 4); c.fill();
  c.strokeStyle = ACCENT; c.lineWidth = 1; c.stroke();
  c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(text, x + 6, y + 10.5);
}
function drawMeas(c, V, m, extra) {
  const pts = (extra ? m.pts.concat([extra]) : m.pts).map((p) => ap(V, p.x, p.y));
  if (!pts.length) return;
  const r = evalMeas(m, extra);
  c.strokeStyle = ACCENT; c.fillStyle = ACCENT; c.lineWidth = 1.6; c.setLineDash([]);
  if (m.type === 'radius') {
    c.beginPath(); c.arc(pts[0][0], pts[0][1], m.rs * S.view.k, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[0][0] + m.rs * S.view.k, pts[0][1]); c.stroke();
    label(c, pts[0][0] + m.rs * S.view.k / 2, pts[0][1] - 14, r.main); return;
  }
  c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  if (m.type === 'area' && pts.length > 2) { c.closePath(); c.globalAlpha = 0.16; c.fill(); c.globalAlpha = 1; }
  c.stroke();
  for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], 3, 0, TAU); c.fill(); }
  if (pts.length < 2) return;
  let lx, ly;
  if (m.type === 'area') { lx = 0; ly = 0; for (const p of pts) { lx += p[0]; ly += p[1]; } lx /= pts.length; ly /= pts.length; }
  else if (m.type === 'angle') { lx = pts[1][0]; ly = pts[1][1] - 18; }
  else if (pts.length === 2) { lx = (pts[0][0] + pts[1][0]) / 2; ly = (pts[0][1] + pts[1][1]) / 2 - 14; }
  else { lx = pts[pts.length - 1][0]; ly = pts[pts.length - 1][1] - 18; }
  label(c, lx, ly, r.main);
}
function drawOverlay(c, V) {
  const sp = space();
  for (const m of sp.meas) drawMeas(c, V, m, null);
  if (S.pending) drawMeas(c, V, S.pending, S.hover);
  if (S.hover && S.hover.t && S.tool !== 'pan' && S.tool !== 'radius') {
    const p = ap(V, S.hover.x, S.hover.y), t = S.hover.t, x = p[0], y = p[1];
    c.strokeStyle = '#3df58a'; c.lineWidth = 2; c.beginPath();
    if (t === 'end' || t === 'node') c.rect(x - 6, y - 6, 12, 12);
    else if (t === 'mid') { c.moveTo(x, y - 7); c.lineTo(x + 7, y + 6); c.lineTo(x - 7, y + 6); c.closePath(); }
    else if (t === 'cen') c.arc(x, y, 7, 0, TAU);
    else if (t === 'quad') { c.moveTo(x, y - 8); c.lineTo(x + 8, y); c.lineTo(x, y + 8); c.lineTo(x - 8, y); c.closePath(); }
    else if (t === 'int') { c.moveTo(x - 6, y - 6); c.lineTo(x + 6, y + 6); c.moveTo(x + 6, y - 6); c.lineTo(x - 6, y + 6); }
    else { c.moveTo(x - 6, y - 6); c.lineTo(x + 6, y - 6); c.lineTo(x - 6, y + 6); c.lineTo(x + 6, y + 6); c.closePath(); }
    c.stroke();
  }
}
function finishPending(force) {
  const m = S.pending; if (!m) return;
  const pts = m.pts;
  while (pts.length > 1 && Math.hypot(pts[pts.length - 1].x - pts[pts.length - 2].x, pts[pts.length - 1].y - pts[pts.length - 2].y) * S.view.k < 1.5) pts.pop();
  const need = m.type === 'area' ? 3 : m.type === 'angle' ? 3 : 2;
  S.pending = null;
  if (pts.length >= need) { space().meas.push(m); if (S.calib && m.type === 'dist') calibrate(m); refreshMeasList(); }
  else if (force && pts.length) toast('Not enough points – measurement dropped.');
  redraw();
}
function setTool(t) {
  if (S.pending) finishPending(false);
  S.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  cv.classList.toggle('measure', t !== 'pan');
  $('hint').textContent = S.doc ? HINTS[t] : '';
  redraw();
}

/* ---------- pointer interaction ---------- */
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  if (!S.doc) return;
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.offsetX, y: e.offsetY, cx: S.view.cx, cy: S.view.cy, moved: false, btn: e.button };
});
cv.addEventListener('pointermove', (e) => {
  if (!S.doc) return;
  if (drag) {
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; cv.style.cursor = 'grabbing'; }
    if (drag.moved) { S.view.cx = drag.cx - dx / S.view.k; S.view.cy = drag.cy + dy / S.view.k; redraw(); return; }
  }
  const pk = S.tool === 'pan' || S.tool === 'radius' ? pick0(e.offsetX, e.offsetY) : pick(e.offsetX, e.offsetY);
  S.hover = pk;
  showCoords(pk);
  if (S.tool !== 'pan') redraw();
});
function pick0(sx, sy) { const s = S.snap; S.snap = false; const r = pick(sx, sy); S.snap = s; return r; }
function showCoords(p) {
  if (!p) { $('coords').textContent = ''; return; }
  const f = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 3, minimumFractionDigits: 3 });
  $('coords').textContent = (p.vp ? 'Model (viewport ' + scaleLabel(p.vp.k) + ')  ' : space().layout.isModel ? '' : 'Paper  ') + 'X ' + f(p.mx) + '   Y ' + f(p.my);
}
cv.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; cv.style.cursor = '';
  if (d.moved || !S.doc) return;
  if (d.btn === 2) { if (S.pending) finishPending(true); return; }
  if (d.btn !== 0 || S.tool === 'pan') return;
  if (S.tool === 'radius') {
    const a = pickArc(e.offsetX, e.offsetY);
    if (!a) { toast('No circle or arc under the pointer.'); return; }
    space().meas.push({ type: 'radius', pts: [{ x: a.x, y: a.y }], r: a.r, rs: a.rs, paper: a.paper });
    refreshMeasList(); redraw(); return;
  }
  const p = pick(e.offsetX, e.offsetY);
  if (!S.pending) S.pending = { type: S.tool, pts: [] };
  S.pending.pts.push(p);
  const m = S.pending;
  if ((m.type === 'dist' && m.pts.length === 2) || (m.type === 'angle' && m.pts.length === 3)) finishPending(false);
  redraw();
});
cv.addEventListener('dblclick', () => { if (!S.doc) return; if (S.tool === 'pan') fit(); else if (S.pending) finishPending(true); });
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  e.preventDefault(); if (!S.doc) return;
  const v = S.view, f = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0016);
  const x = v.cx + (e.offsetX - S.W / 2) / v.k, y = v.cy - (e.offsetY - S.H / 2) / v.k;
  const k = Math.max(1e-9, Math.min(1e9, v.k * f));
  v.cx = x - (e.offsetX - S.W / 2) / k; v.cy = y + (e.offsetY - S.H / 2) / k; v.k = k;
  redraw();
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || $('dlgExport').open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('file').click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (S.pending) { S.pending = null; redraw(); } else setTool('pan'); }
  else if (k === 'enter') finishPending(true);
  else if (k === 'backspace' && S.pending) { S.pending.pts.pop(); if (!S.pending.pts.length) S.pending = null; redraw(); }
  else if (k === 'd') setTool('dist'); else if (k === 'p') setTool('path'); else if (k === 'a') setTool('area');
  else if (k === 'g') setTool('angle'); else if (k === 'r') setTool('radius');
  else if (k === 'f') fit(); else if (k === 's') $('btnSnap').click(); else if (k === 'b') $('btnBg').click();
});

/* ---------- layers & tabs ---------- */
function buildLayers() {
  const ul = $('layerList'), flt = $('layerFilter').value.trim().toLowerCase(); ul.textContent = '';
  const order = S.doc.layers.map((L, i) => i).sort((a, b) => S.doc.layers[a].name.localeCompare(S.doc.layers[b].name, undefined, { numeric: true }));
  let shown = 0;
  for (const i of order) {
    const L = S.doc.layers[i];
    if (flt && L.name.toLowerCase().indexOf(flt) < 0) continue;
    shown++;
    const li = document.createElement('li'), cb = document.createElement('input'), sw = document.createElement('span'), nm = document.createElement('span'), ct = document.createElement('span');
    cb.type = 'checkbox'; cb.checked = S.layerOn[i]; cb.setAttribute('aria-label', 'Show layer ' + L.name);
    sw.className = 'sw'; sw.style.background = css(L.tc !== null ? (L.tc & 0xffffff) : (L.color === 7 ? -1 : DXF.aciToRgb(L.color)));
    nm.className = 'nm'; nm.textContent = L.name; nm.title = L.name + ' — double-click to show only this layer';
    ct.className = 'ct'; ct.textContent = L.count || '';
    li.className = S.layerOn[i] ? '' : 'off';
    li.append(cb, sw, nm, ct);
    li.onclick = (ev) => { if (ev.target !== cb) cb.checked = !cb.checked; S.layerOn[i] = cb.checked; li.className = cb.checked ? '' : 'off'; redraw(); };
    li.ondblclick = () => { S.layerOn = S.layerOn.map((v, j) => j === i); buildLayers(); redraw(); };
    ul.append(li);
  }
  $('layerCount').textContent = flt ? shown + ' of ' + S.doc.layers.length : String(S.doc.layers.length);
}
function bulkLayers(fn) {
  if (!S.doc) return;
  const flt = $('layerFilter').value.trim().toLowerCase();
  S.layerOn = S.layerOn.map((v, i) => (flt && S.doc.layers[i].name.toLowerCase().indexOf(flt) < 0) ? v : fn(v, i));
  buildLayers(); redraw();
}
function buildTabs() {
  const el = $('tabs'); el.textContent = '';
  S.spaces.forEach((sp, i) => {
    const b = document.createElement('button'); b.textContent = sp.layout.name; b.setAttribute('role', 'tab');
    b.className = i === S.cur ? 'on' : ''; b.onclick = () => switchTab(i); el.append(b);
  });
}
function ensureSpace(i) {
  const sp = S.spaces[i];
  if (sp.prims) return sp;
  const fl = DXF.flatten(S.doc, sp.layout.ents);
  sp.prims = fl.prims; sp.bbox = fl.bbox; sp.stats = fl.stats;
  sp.vps = sp.layout.viewports.map((e) => { const M = DXF.viewportMatrix(e); return { e, M, I: inv(M), k: e.hh / e.vh }; });
  return sp;
}
function switchTab(i) {
  if (S.pending) finishPending(false);
  const old = space(); if (old) old.view = Object.assign({}, S.view);
  S.cur = i;
  const sp = ensureSpace(i);
  buildTabs(); refreshMeasList();
  if (sp.view) { S.view = Object.assign({}, sp.view); redraw(); } else fit();
}

/* ---------- opening files ---------- */
const isDwgBytes = (u8) => u8.length > 6 && u8[0] === 0x41 && u8[1] === 0x43 && u8[2] >= 0x31 && u8[2] <= 0x32 && (u8[3] === 0x30 || u8[3] === 0x2e);
async function errText(res) { try { const j = await res.json(); return j.error || res.statusText; } catch (e) { return res.statusText; } }
async function openBytes(name, u8) {
  try {
    let dxf = u8;
    if (isDwgBytes(u8)) {
      if (!S.server) throw new Error('DWG files need the CADLite app (start it from the menu or run "cadlite"). This page alone can only read DXF.');
      busy('Converting DWG…'); await paint();
      const res = await fetch(api('todxf?name=' + encodeURIComponent(name)), { method: 'POST', body: u8 });
      if (!res.ok) throw new Error(await errText(res));
      dxf = new Uint8Array(await res.arrayBuffer());
    }
    busy('Reading drawing…'); await paint();
    const doc = DXF.parse(dxf);
    if (!doc.entityCount && doc.layouts.length < 2 && !doc.layers.length) throw new Error('This file does not look like a DXF drawing.');
    S.doc = doc; S.orig = { name, bytes: u8 }; S.pending = null; S.hover = null;
    S.spaces = doc.layouts.map((l) => ({ layout: l, prims: null, meas: [], view: null }));
    S.layerOn = doc.layers.map((L) => !(L.off || L.frozen));
    S.cur = 0;
    S.model = ensureSpace(0);
    while (S.layerOn.length < doc.layers.length) S.layerOn.push(true);
    S.layerInit = S.layerOn.slice();
    const iu = INSUNITS[doc.header.$INSUNITS];
    S.drawUnit = iu || (doc.header.$MEASUREMENT === 0 ? 'in' : 'mm'); S.mmPerUnit = MM[S.drawUnit]; $('selDraw').value = S.drawUnit;
    $('selDraw').querySelector('[value=custom]').hidden = true;
    if (!S.dispTouched) { S.dispUnit = S.drawUnit; $('selDisp').value = S.dispUnit; }
    $('welcome').hidden = true;
    const ver = DXF.VERSIONS[doc.version];
    $('fileName').textContent = name + (ver ? '  ·  AutoCAD ' + ver + ' format' : '') + '  ·  ' + doc.entityCount.toLocaleString('en-US') + ' objects';
    $('fileName').title = name;
    document.title = name + ' – CADLite Viewer';
    buildLayers(); buildTabs(); refreshMeasList(); setTool(S.tool); resize(); fit();
    busy('');
    const un = Object.entries(S.model.stats.unsupported).map((x) => x[0] + ' ×' + x[1]);
    const notes = [];
    if (un.length) notes.push('Not drawn (unsupported object types): ' + un.join(', '));
    if (S.model.stats.truncated) notes.push('Very large drawing – only part of it is shown.');
    if (!iu) notes.push('This file does not state its unit, so 1 unit = 1 ' + S.drawUnit + ' was assumed. If measurements look wrong, change "1 drawing unit =" or use Calibrate on a known length.');
    if (notes.length) toast(notes.join('\n'), false, 9000);
  } catch (err) {
    busy(''); console.error(err); toast('Could not open ' + name + ': ' + (err.message || err), true);
    if (/not set up yet/.test(String(err.message))) { S.retry = { name, u8 }; openExport(); }
  }
}
async function openFile(file) { if (!file) return; busy('Loading…'); await paint(); openBytes(file.name, new Uint8Array(await file.arrayBuffer())); }
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('btnOpen').onclick = $('btnOpen2').onclick = () => $('file').click();
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });

/* ---------- export / convert ---------- */
async function saveBlob(name, blob) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      toast('Saved ' + h.name); return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  toast('Saved ' + name + ' to your Downloads folder');
}
const stem = () => (S.orig ? S.orig.name.replace(/\.[^.]+$/, '') : 'drawing');
function toolStatus() {
  const el = $('convTool'), t = S.info && S.info.tools;
  if (!S.server) { el.className = 'small warn'; el.textContent = 'Format conversion needs the CADLite app – start it with the "cadlite" command.'; return false; }
  if (t && t.oda) { el.className = 'small ok'; el.textContent = 'Converter ready: ODA File Converter (' + t.oda + ')'; return true; }
  if (t && (t.dwg2dxf || t.dxf2dwg)) { el.className = 'small warn'; el.textContent = 'Converter: LibreDWG (limited – DWG to DXF up to 2013, DXF to DWG 2000 only). Install ODA File Converter for every version.'; return true; }
  el.className = 'small warn'; el.textContent = 'DWG support is not set up yet. DXF files and the quick exports below already work.';
  return false;
}
async function refreshInfo() {
  if (!S.server) return;
  try { S.info = await (await fetch(api('info'))).json(); } catch (e) { S.server = false; }
}
let engTimer = null;
async function engineSetup() {
  if (!S.server) return;
  if (!$('dlgExport').open) await openExport();
  $('engRow').hidden = false; $('engGo').disabled = true;
  try { await fetch(api('engine'), { method: 'POST' }); } catch (e) { /* polled below */ }
  clearInterval(engTimer);
  engTimer = setInterval(async () => {
    let st; try { st = await (await fetch(api('engine'))).json(); } catch (e) { return; }
    $('engMsg').className = 'small ' + (st.state === 'error' ? 'warn' : 'muted');
    $('engMsg').textContent = st.msg + (st.state === 'running' && st.pct ? ' – ' + st.pct + '%' : '');
    if (st.state === 'running') return;
    clearInterval(engTimer); $('engGo').disabled = false;
    await refreshInfo(); noteTools();
    if (toolStatus()) {
      $('engRow').hidden = true; toast('DWG support is ready – you can now open and convert DWG files.');
      if (S.retry) { const r = S.retry; S.retry = null; $('dlgExport').close(); openBytes(r.name, r.u8); }
    }
  }, 700);
}
async function openExport() {
  await refreshInfo();
  const ready = toolStatus(), hasOda = !!(S.info && S.info.tools && S.info.tools.oda);
  $('engRow').hidden = !S.server || hasOda || (ready && false);
  $('convSrc').textContent = S.orig ? 'Source: ' + S.orig.name + (DXF.VERSIONS[S.doc.version] ? ' (AutoCAD ' + DXF.VERSIONS[S.doc.version] + ' format)' : '') : 'Open a drawing first.';
  if (S.info && S.info.config && S.info.config.oda_path) $('convPath').value = S.info.config.oda_path;
  $('dlgExport').showModal();
}
$('btnExport').onclick = openExport;
$('engGo').onclick = $('engGo2').onclick = engineSetup;
$('convGo').onclick = async () => {
  if (!S.orig) { toast('Open a drawing first.', true); return; }
  const fmt = $('convFmt').value, ver = $('convVer').value;
  $('dlgExport').close(); busy('Converting…'); await paint();
  try {
    const res = await fetch(api('convert?name=' + encodeURIComponent(S.orig.name) + '&fmt=' + fmt + '&ver=' + ver), { method: 'POST', body: S.orig.bytes });
    if (!res.ok) throw new Error(await errText(res));
    const blob = await res.blob(); busy('');
    await saveBlob(stem() + '_' + ver.replace('ACAD', 'R') + (fmt === 'DWG' ? '.dwg' : '.dxf'), blob);
  } catch (err) { busy(''); toast('Conversion failed: ' + (err.message || err), true); }
};
$('convPathSave').onclick = async () => {
  try {
    const res = await fetch(api('config'), { method: 'POST', body: JSON.stringify({ oda_path: $('convPath').value.trim() }) });
    if (!res.ok) throw new Error(await errText(res));
    await refreshInfo(); toolStatus(); noteTools();
  } catch (err) { $('convTool').className = 'small warn'; $('convTool').textContent = err.message || String(err); }
};
$('expSvg').onclick = () => {
  if (!S.doc) return; const sp = space();
  const svg = DXF.exportSVG({ prims: sp.prims, bbox: sp.bbox, viewports: sp.layout.viewports }, S.model, (p, fr) => !hidden(p, fr));
  $('dlgExport').close(); saveBlob(stem() + '_' + sp.layout.name.replace(/[^\w-]+/g, '_') + '.svg', new Blob([svg], { type: 'image/svg+xml' }));
};
$('expPng').onclick = () => {
  if (!S.doc) return;
  const scale = Math.min(4, 8000 / Math.max(S.W, S.H)), oc = document.createElement('canvas'), keep = S.dpr;
  oc.width = Math.round(S.W * scale); oc.height = Math.round(S.H * scale);
  S.dpr = scale; render(oc.getContext('2d'), S.W, S.H, S.view, true); S.dpr = keep;
  $('dlgExport').close(); oc.toBlob((b) => saveBlob(stem() + '.png', b), 'image/png');
};
$('expR12').onclick = () => {
  if (!S.doc) return;
  const txt = DXF.exportR12(S.doc, S.model.prims, (p) => !hidden(p, null));
  $('dlgExport').close(); saveBlob(stem() + '_R12.dxf', new Blob([txt], { type: 'application/dxf' }));
};

/* ---------- toolbar wiring ---------- */
document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
$('btnSnap').onclick = () => { S.snap = !S.snap; $('btnSnap').classList.toggle('on', S.snap); };
$('btnFit').onclick = fit;
$('btnBg').onclick = () => { S.dark = !S.dark; document.body.classList.toggle('light', !S.dark); $('btnBg').textContent = S.dark ? 'Light' : 'Dark'; if (S.doc) buildLayers(); redraw(); };
$('selDraw').onchange = (e) => { if (e.target.value !== 'custom') { S.drawUnit = e.target.value; S.mmPerUnit = MM[S.drawUnit]; } refreshMeasList(); redraw(); };
$('selDisp').onchange = (e) => { S.dispUnit = e.target.value; S.dispTouched = true; refreshMeasList(); redraw(); };
$('btnCal').onclick = () => { if (!S.doc) return; S.calib = !S.calib; $('btnCal').classList.toggle('on', S.calib); if (S.calib) { setTool('dist'); $('hint').textContent = 'Calibrate: click the two ends of a length you know (for example a dimensioned wall)'; } };
$('selPrec').onchange = (e) => { S.prec = +e.target.value; refreshMeasList(); redraw(); };
$('layerFilter').oninput = () => { if (S.doc) buildLayers(); };
$('layAll').onclick = () => bulkLayers(() => true);
$('layNone').onclick = () => bulkLayers(() => false);
$('layInv').onclick = () => bulkLayers((v) => !v);
$('layReset').onclick = () => { if (S.doc) { S.layerOn = S.layerInit.slice(); buildLayers(); redraw(); } };
$('measClear').onclick = () => { const sp = space(); if (sp) { sp.meas.length = 0; S.pending = null; refreshMeasList(); redraw(); } };
$('measCopy').onclick = () => {
  const sp = space(); if (!sp || !sp.meas.length) return;
  const txt = sp.meas.map((m) => { const r = evalMeas(m); return TITLE[m.type] + ': ' + r.main + (r.sub.length ? '  (' + r.sub.join('; ') + ')' : ''); }).join('\n');
  navigator.clipboard.writeText(txt).then(() => toast('Measurements copied'), () => toast('Clipboard not available', true));
};
new ResizeObserver(resize).observe(stage);

function noteTools() {
  const t = S.info && S.info.tools, el = $('toolNote');
  if (!S.server) el.textContent = 'Running without the CADLite app: DXF files only.';
  else if (t && t.oda) el.textContent = 'DWG support: ODA File Converter detected.';
  else if (t && t.dwg2dxf) el.textContent = 'DWG support: LibreDWG detected.';
  else el.textContent = 'DXF opens straight away. DWG needs a one-time setup:';
  $('engGo2').hidden = !S.server || !!(t && t.oda);
}
(async function init() {
  resize();
  await refreshInfo(); noteTools();
  if (S.server) {
    setInterval(() => { fetch(api('ping'), { method: 'POST' }).catch(() => {}); }, 10000);
    if (S.info && S.info.initial) {
      busy('Loading ' + S.info.initial + '…'); await paint();
      try {
        const res = await fetch(api('initial'));
        if (!res.ok) throw new Error(await errText(res));
        await openBytes(S.info.initial, new Uint8Array(await res.arrayBuffer()));
      } catch (err) { busy(''); toast('Could not open ' + S.info.initial + ': ' + (err.message || err), true); }
    }
  }
})();
window.CADLITE = { S, openBytes, fit, switchTab, setTool, pick };
})();
