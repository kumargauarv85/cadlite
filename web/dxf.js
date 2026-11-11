/* CADLite – DXF reader, geometry flattener and exporters. No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DXF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const PI = Math.PI, TAU = 2 * PI, DEG = PI / 180;
const MAX_PRIMS = 4000000;

/* ---------- colours ---------- */
const ACI_BASE = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
const ACI_GREY = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
function aciToRgb(i) {
  i = Math.abs(i | 0);
  if (i < 10) return ACI_BASE[i];
  if (i >= 250) return ACI_GREY[Math.min(i, 255) - 250];
  const hue = Math.floor((i - 10) / 10) * 15, j = i % 10;
  const val = [1, 0.65, 0.5, 0.3, 0.15][j >> 1], sat = (j & 1) ? 0.5 : 1;
  const c = val * sat, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = val - c;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; } else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; } else if (hue < 300) { r = x; b = c; } else { r = c; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}
function rgbToAci(rgb) {
  if (rgb < 0) return 7;
  const r = rgb >> 16 & 255, g = rgb >> 8 & 255, b = rgb & 255;
  let best = 7, bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = aciToRgb(i), d = (r - (c >> 16 & 255)) ** 2 + (g - (c >> 8 & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* ---------- decoding / tokenising ---------- */
const CODEPAGES = { ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258' };
const BIN_SENTINEL = 'AutoCAD Binary DXF';

function isFloatCode(c) { return (c >= 10 && c <= 59) || (c >= 110 && c <= 149) || (c >= 210 && c <= 239) || (c >= 460 && c <= 469) || (c >= 1010 && c <= 1059); }
function isIntCode(c) { return (c >= 60 && c <= 99) || (c >= 160 && c <= 179) || (c >= 270 && c <= 299) || (c >= 370 && c <= 389) || (c >= 400 && c <= 409) || (c >= 420 && c <= 459) || (c >= 1060 && c <= 1071); }

function tokenizeText(text) {
  if (text.indexOf('\n') < 0) text = text.replace(/\r/g, '\n');
  const codes = [], vals = [];
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let e = text.indexOf('\n', pos); if (e < 0) e = n;
    const code = parseInt(text.slice(pos, e), 10);
    pos = e + 1;
    if (isNaN(code)) continue;
    if (pos > n) break;
    let e2 = text.indexOf('\n', pos); if (e2 < 0) e2 = n;
    let v = text.slice(pos, e2);
    pos = e2 + 1;
    if (v.charCodeAt(v.length - 1) === 13) v = v.slice(0, -1);
    codes.push(code);
    if (isFloatCode(code)) vals.push(parseFloat(v) || 0);
    else if (isIntCode(code)) vals.push(parseInt(v, 10) || 0);
    else vals.push(code === 0 || code === 2 || code === 9 || code === 100 ? v.trim() : v);
  }
  return { codes, vals };
}

function tokenizeBinary(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = new TextDecoder('utf-8');
  const codes = [], vals = [];
  let p = 22;
  const wide = u8[23] === 0;
  const n = u8.length;
  while (p < n) {
    let c;
    if (wide) { c = dv.getUint16(p, true); p += 2; }
    else { c = u8[p++]; if (c === 255) { c = dv.getUint16(p, true); p += 2; } }
    let v;
    if (isFloatCode(c)) { v = dv.getFloat64(p, true); p += 8; }
    else if ((c >= 90 && c <= 99) || (c >= 420 && c <= 459) || c === 1071) { v = dv.getInt32(p, true); p += 4; }
    else if (c >= 160 && c <= 169) { v = Number(dv.getBigInt64(p, true)); p += 8; }
    else if (c >= 290 && c <= 299) { v = u8[p++]; }
    else if ((c >= 310 && c <= 319) || c === 1004) { const len = u8[p++]; v = ''; p += len; }
    else if (isIntCode(c)) { v = dv.getInt16(p, true); p += 2; }
    else {
      let q = p; while (q < n && u8[q] !== 0) q++;
      v = dec.decode(u8.subarray(p, q)); p = q + 1;
      if (c === 0 || c === 2 || c === 9 || c === 100) v = v.trim();
    }
    codes.push(c); vals.push(v);
    if (c === 0 && v === 'EOF') break;
  }
  return { codes, vals };
}

function tokenize(input) {
  if (typeof input === 'string') return tokenizeText(input);
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = u8.length > 22;
  for (let i = 0; bin && i < BIN_SENTINEL.length; i++) if (u8[i] !== BIN_SENTINEL.charCodeAt(i)) bin = false;
  if (bin) return tokenizeBinary(u8);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch (err) {
    const head = new TextDecoder('windows-1252').decode(u8.subarray(0, 400000));
    const m = /\$DWGCODEPAGE\s+3\s+(\S+)/.exec(head);
    const enc = (m && CODEPAGES[m[1].toUpperCase()]) || 'windows-1252';
    try { text = new TextDecoder(enc).decode(u8); } catch (e2) { text = new TextDecoder('windows-1252').decode(u8); }
  }
  return tokenizeText(text);
}

/* ---------- text helpers ---------- */
function decodeSpecial(s) {
  if (s.indexOf('%%') >= 0) {
    s = s.replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, '⌀')
      .replace(/%%[uUoOkK]/g, '').replace(/%%(\d{3})/g, (m, d) => String.fromCharCode(+d)).replace(/%%%/g, '%');
  }
  if (s.indexOf('\\U+') >= 0) s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return s;
}
function mtextPlain(s) {
  s = decodeSpecial(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[++i];
      if (nx === undefined) break;
      if (nx === 'P' || nx === 'N' || nx === 'X') out += '\n';
      else if (nx === '~') out += ' ';
      else if (nx === '\\' || nx === '{' || nx === '}') out += nx;
      else if ('LlOoKk'.indexOf(nx) >= 0) { /* toggles */ }
      else if (nx === 'S') {
        const j = s.indexOf(';', i); const seg = s.slice(i + 1, j < 0 ? s.length : j);
        out += seg.replace(/\\(.)/g, '$1').replace(/[\^#]/g, '/'); i = j < 0 ? s.length : j;
      } else if ('fFHWQTCcAp'.indexOf(nx) >= 0) { const j = s.indexOf(';', i); i = j < 0 ? s.length : j; }
      else out += nx;
    } else if (ch === '{' || ch === '}') { /* grouping */ }
    else if (ch === '^' && s[i + 1] === 'I') { out += ' '; i++; }
    else if (ch === '^' && s[i + 1] === 'J') { out += '\n'; i++; }
    else out += ch;
  }
  return out;
}

/* ---------- document parser ---------- */
function parse(input) {
  const tk = tokenize(input);
  const codes = tk.codes, vals = tk.vals, n = codes.length;
  const doc = { header: {}, layers: [], layerIdx: new Map(), layerByHandle: new Map(), blocks: new Map(), blockRecs: new Map(),
    layouts: [], version: '', entityCount: 0 };
  let i = 0;

  function addLayer(name, props) {
    const key = String(name).toUpperCase();
    let idx = doc.layerIdx.get(key);
    if (idx === undefined) {
      idx = doc.layers.length;
      doc.layers.push(Object.assign({ name: String(name), color: 7, tc: null, ltype: 'CONTINUOUS', off: false, frozen: false, locked: false, count: 0 }, props || {}));
      doc.layerIdx.set(key, idx);
    } else if (props) Object.assign(doc.layers[idx], props);
    return idx;
  }
  doc.addLayer = addLayer;

  function nextZero(from) { let j = from; while (j < n && codes[j] !== 0) j++; return j; }

  function scan(s, e) {
    const f = {}; let in102 = false, end = e;
    for (let j = s; j < e; j++) {
      const c = codes[j];
      if (c >= 1000 || c === 101) { end = j; break; }
      if (c === 102) { in102 = String(vals[j]).charAt(0) === '{'; continue; }
      if (in102) continue;
      if (f[c] === undefined) f[c] = vals[j];
    }
    f._s = s; f._e = end;
    return f;
  }

  function parseHatch(o, s, e) {
    let j = s;
    o.solid = false; o.loops = [];
    let seen100 = false;
    for (; j < e && codes[j] !== 91; j++) {
      if (codes[j] === 100 && vals[j] === 'AcDbHatch') seen100 = true;
      else if (codes[j] === 70 && seen100) o.solid = vals[j] === 1;
    }
    if (j >= e) return;
    const nl = vals[j]; j++;
    const eat = (set, max) => { const r = {}; let k = 0; while (j < e && k < max && set.indexOf(codes[j]) >= 0 && r[codes[j]] === undefined) { r[codes[j]] = vals[j]; j++; k++; } return r; };
    for (let L = 0; L < nl && j < e; L++) {
      while (j < e && codes[j] !== 92) j++;
      if (j >= e) break;
      const flag = vals[j]; j++;
      let pts = [];
      if (flag & 2) {
        let closed = 1, nv = 0;
        for (; j < e; j++) { const c = codes[j]; if (c === 73) closed = vals[j]; else if (c === 93) { nv = vals[j]; j++; break; } }
        const vs = [];
        while (j < e) {
          const c = codes[j];
          if (c === 10) { if (vs.length === nv) break; vs.push([vals[j], 0, 0]); }
          else if (c === 20 && vs.length) vs[vs.length - 1][1] = vals[j];
          else if (c === 42 && vs.length) vs[vs.length - 1][2] = vals[j];
          else break;
          j++;
        }
        pts = bulgePath(vs, !!closed).pts;
      } else {
        while (j < e && codes[j] !== 93) j++;
        const ne = vals[j]; j++;
        for (let k = 0; k < ne && j < e; k++) {
          while (j < e && codes[j] !== 72) j++;
          if (j >= e) break;
          const et = vals[j]; j++;
          if (et === 1) { const r = eat([10, 20, 11, 21], 4); pts.push(r[10] || 0, r[20] || 0, r[11] || 0, r[21] || 0); }
          else if (et === 2) {
            const r = eat([10, 20, 40, 50, 51, 73], 6);
            let a0 = (r[50] || 0) * DEG, a1 = (r[51] || 0) * DEG;
            if (r[73]) { if (a1 <= a0) a1 += TAU; } else { a0 = -a0; a1 = -a1; if (a1 >= a0) a1 -= TAU; }
            const ns = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (PI / 24)));
            for (let q = 0; q <= ns; q++) { const a = a0 + (a1 - a0) * q / ns; pts.push(r[10] + r[40] * Math.cos(a), r[20] + r[40] * Math.sin(a)); }
          } else if (et === 3) {
            const r = eat([10, 20, 11, 21, 40, 50, 51, 73], 8);
            let a0 = (r[50] || 0) * DEG, a1 = (r[51] || 0) * DEG;
            if (r[73]) { if (a1 <= a0) a1 += TAU; } else { a0 = -a0; a1 = -a1; if (a1 >= a0) a1 -= TAU; }
            const mx = r[11] || 0, my = r[21] || 0, ra = r[40] || 1;
            const ns = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (PI / 24)));
            for (let q = 0; q <= ns; q++) { const a = a0 + (a1 - a0) * q / ns, ca = Math.cos(a), sa = Math.sin(a); pts.push(r[10] + ca * mx - sa * my * ra, r[20] + ca * my + sa * mx * ra); }
          } else if (et === 4) {
            let deg = 3, nk = 0, nc = 0;
            for (; j < e; j++) { const c = codes[j]; if (c === 94) deg = vals[j]; else if (c === 95) nk = vals[j]; else if (c === 96) { nc = vals[j]; j++; break; } else if (c !== 73 && c !== 74) break; }
            const knots = [], ctrl = [], w = [];
            while (j < e && codes[j] === 40 && knots.length < nk) { knots.push(vals[j]); j++; }
            while (j < e && ctrl.length <= nc) {
              const c = codes[j];
              if (c === 10) { if (ctrl.length === nc) break; ctrl.push([vals[j], 0]); }
              else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = vals[j];
              else if (c === 42) w.push(vals[j]);
              else break;
              j++;
            }
            if (j < e && codes[j] === 97) {
              const nx = codes[j + 1];
              const isFit = nx === 11 || (vals[j] === 0 && (nx === 12 || nx === 72 || nx === 97));
              if (isFit) { j++; while (j < e && (codes[j] === 11 || codes[j] === 21 || codes[j] === 12 || codes[j] === 22 || codes[j] === 13 || codes[j] === 23)) j++; }
            }
            const sp = bspline(deg, knots, ctrl, w.length === ctrl.length ? w : null);
            for (let q = 0; q < sp.length; q++) pts.push(sp[q]);
          }
        }
      }
      if (pts.length >= 6) o.loops.push(pts);
    }
  }

  function parseMLeader(o, s, e) {
    o.lines = []; o.text = ''; o.tx = null; o.th = 0; o.trot = 0;
    const stack = []; let verts = [], conn = null, dog = null, dogLen = 0;
    for (let j = s; j < e; j++) {
      const c = codes[j], v = vals[j], top = stack[stack.length - 1];
      if ((c >= 300 && c <= 305) && typeof v === 'string' && v.charAt(v.length - 1) === '{') {
        stack.push(v); if (v === 'LEADER_LINE{') verts = []; if (v === 'LEADER{') { conn = null; dog = null; dogLen = 0; }
        continue;
      }
      if ((c === 301 || c === 303 || c === 305) && v === '}') {
        const cl = stack.pop();
        if (cl === 'LEADER_LINE{' && verts.length) { const l = verts.slice(); if (conn) l.push(conn[0], conn[1]); if (l.length >= 4) o.lines.push(l); }
        if (cl === 'LEADER{' && conn && dog && dogLen) o.lines.push([conn[0], conn[1], conn[0] + dog[0] * dogLen, conn[1] + dog[1] * dogLen]);
        continue;
      }
      if (top === 'LEADER_LINE{') { if (c === 10) verts.push(v, 0); else if (c === 20 && verts.length) verts[verts.length - 1] = v; }
      else if (top === 'LEADER{') {
        if (c === 10) conn = [v, 0]; else if (c === 20 && conn) conn[1] = v;
        else if (c === 11) dog = [v, 0]; else if (c === 21 && dog) dog[1] = v; else if (c === 40) dogLen = v;
      } else if (top === 'CONTEXT_DATA{') {
        if (c === 304) o.text = v; else if (c === 12) o.tx = [v, 0]; else if (c === 22 && o.tx) o.tx[1] = v;
        else if (c === 41) o.th = v; else if (c === 42) o.trot = v;
      }
    }
  }

  function parseEntity(type, s, e) {
    const f = scan(s, e);
    e = f._e;
    const o = { t: type, h: f[5], layer: f[8] === undefined ? '0' : String(f[8]), color: f[62], tc: f[420], lt: f[6],
      paper: f[67] === 1, owner: f[330], inv: f[60] === 1, ext: null };
    if (f[230] !== undefined && (f[230] < 0.999999 || Math.abs(f[210] || 0) > 1e-9 || Math.abs(f[220] || 0) > 1e-9)) o.ext = [f[210] || 0, f[220] || 0, f[230]];
    const X = (c) => f[c] || 0;
    switch (type) {
      case 'LINE': o.x1 = X(10); o.y1 = X(20); o.x2 = X(11); o.y2 = X(21); o.ext = null; break;
      case 'POINT': o.x = X(10); o.y = X(20); o.ext = null; break;
      case 'CIRCLE': o.x = X(10); o.y = X(20); o.r = X(40); break;
      case 'ARC': o.x = X(10); o.y = X(20); o.r = X(40); o.a0 = X(50); o.a1 = X(51); break;
      case 'ELLIPSE': o.x = X(10); o.y = X(20); o.mx = X(11); o.my = X(21); o.ratio = f[40] === undefined ? 1 : f[40]; o.t0 = X(41); o.t1 = f[42] === undefined ? TAU : f[42]; break;
      case 'LWPOLYLINE': {
        o.closed = (X(70) & 1) === 1; const vs = [];
        for (let j = s; j < e; j++) {
          const c = codes[j];
          if (c === 10) vs.push([vals[j], 0, 0]); else if (c === 20 && vs.length) vs[vs.length - 1][1] = vals[j];
          else if (c === 42 && vs.length) vs[vs.length - 1][2] = vals[j];
        }
        o.vs = vs; break;
      }
      case 'POLYLINE': o.flags = X(70); o.m = X(71); o.n = X(72); o.vs = []; o.faces = []; break;
      case 'VERTEX': o.x = X(10); o.y = X(20); o.b = X(42); o.flags = X(70); o.f = [X(71), X(72), X(73), X(74)]; break;
      case 'SPLINE': {
        o.deg = f[71] === undefined ? 3 : f[71]; o.closed = (X(70) & 1) === 1;
        const knots = [], ctrl = [], w = [], fit = [];
        for (let j = s; j < e; j++) {
          const c = codes[j];
          if (c === 40) knots.push(vals[j]); else if (c === 10) ctrl.push([vals[j], 0]); else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = vals[j];
          else if (c === 41) w.push(vals[j]); else if (c === 11) fit.push(vals[j], 0); else if (c === 21 && fit.length) fit[fit.length - 1] = vals[j];
        }
        o.knots = knots; o.ctrl = ctrl; o.w = w.length === ctrl.length ? w : null; o.fit = fit; o.ext = null; break;
      }
      case 'TEXT': case 'ATTRIB': {
        o.x = X(10); o.y = X(20); o.hasAlign = f[11] !== undefined; o.ax = X(11); o.ay = X(21); o.hgt = X(40) || 1;
        o.rot = X(50); o.wf = f[41] || 1; o.s = decodeSpecial(String(f[1] === undefined ? '' : f[1]));
        o.ha = X(72); o.va = type === 'ATTRIB' ? X(74) : X(73);
        if (type === 'ATTRIB' && (X(70) & 1)) o.inv = true;
        break;
      }
      case 'MTEXT': {
        o.x = X(10); o.y = X(20); o.hgt = X(40) || 1; o.w = X(41); o.att = f[71] || 1; o.lsf = f[44] || 1;
        let str = '', rot = null, dir = null, col = false;
        for (let j = s; j < e; j++) {
          const c = codes[j];
          if (c === 3) str += vals[j]; else if (c === 1) str += vals[j];
          else if (c === 75) col = true; else if (c === 50 && rot === null && !col) rot = vals[j];
          else if (c === 11) dir = [vals[j], 0]; else if (c === 21 && dir) dir[1] = vals[j];
        }
        o.rot = dir && (dir[0] || dir[1]) ? Math.atan2(dir[1], dir[0]) / DEG : (rot || 0);
        o.s = mtextPlain(str); o.ext = null; break;
      }
      case 'INSERT':
        o.name = String(f[2] || ''); o.x = X(10); o.y = X(20); o.sx = f[41] === undefined ? 1 : f[41]; o.sy = f[42] === undefined ? 1 : f[42];
        o.rot = X(50); o.cols = f[70] || 1; o.rows = f[71] || 1; o.dx = X(44); o.dy = X(45); o.hasAtt = f[66] === 1; o.atts = []; break;
      case 'DIMENSION': o.name = String(f[2] || ''); o.ext = null; break;
      case 'ACAD_TABLE': o.t = 'INSERT'; o.name = String(f[2] || ''); o.x = X(10); o.y = X(20); o.sx = 1; o.sy = 1; o.rot = 0; o.cols = 1; o.rows = 1; o.dx = 0; o.dy = 0; o.atts = []; o.ext = null; break;
      case 'HATCH': parseHatch(o, s, e); break;
      case 'SOLID': case 'TRACE': o.p = [X(10), X(20), X(11), X(21), X(13), X(23), X(12), X(22)]; break;
      case '3DFACE': o.p = [X(10), X(20), X(11), X(21), X(12), X(22), X(13), X(23)]; o.ext = null; break;
      case 'LEADER': {
        const p = [];
        for (let j = s; j < e; j++) { if (codes[j] === 10) p.push(vals[j], 0); else if (codes[j] === 20 && p.length) p[p.length - 1] = vals[j]; }
        o.p = p; o.ext = null; break;
      }
      case 'MULTILEADER': case 'MLEADER': o.t = 'MLEADER'; parseMLeader(o, s, e); o.ext = null; break;
      case 'IMAGE': {
        const ux = X(11), uy = X(21), vx = X(12), vy = X(22), w = X(13), h = X(23), x = X(10), y = X(20);
        o.p = [x, y, x + ux * w, y + uy * w, x + ux * w + vx * h, y + uy * w + vy * h, x + vx * h, y + vy * h]; o.ext = null; break;
      }
      case 'VIEWPORT': {
        o.cx = X(10); o.cy = X(20); o.w = X(40); o.hh = X(41); o.vcx = X(12); o.vcy = X(22); o.vh = X(45);
        o.tx = X(17); o.ty = X(27); o.twist = X(51); o.id = f[69]; o.status = f[68];
        o.plan = Math.abs(X(16)) < 1e-9 && Math.abs(X(26)) < 1e-9;
        o.frozen = [];
        for (let j = s; j < e; j++) if (codes[j] === 331) o.frozen.push(String(vals[j]).toUpperCase());
        o.ext = null; break;
      }
      case 'SEQEND': break;
      default: o.unsupported = true;
    }
    return o;
  }

  function readEntities() {
    const list = []; let seq = null;
    while (i < n) {
      if (codes[i] !== 0) { i++; continue; }
      const type = vals[i];
      if (type === 'ENDSEC' || type === 'ENDBLK' || type === 'EOF') break;
      const s = i + 1, e = nextZero(s);
      i = e;
      const ent = parseEntity(type, s, e);
      doc.entityCount++;
      if (type === 'VERTEX') {
        if (seq && seq.t === 'POLYLINE') { if ((ent.flags & 128) && !(ent.flags & 64)) seq.faces.push(ent.f); else seq.vs.push([ent.x, ent.y, ent.b]); }
        continue;
      }
      if (type === 'SEQEND') { seq = null; continue; }
      if (type === 'ATTRIB' && seq && seq.t === 'INSERT') { seq.atts.push(ent); continue; }
      list.push(ent);
      if (type === 'POLYLINE' || (type === 'INSERT' && ent.hasAtt)) seq = ent; else seq = null;
    }
    return list;
  }

  let entities = [];
  const layoutsRaw = [];
  while (i < n) {
    if (!(codes[i] === 0 && vals[i] === 'SECTION')) { i++; continue; }
    const sec = vals[i + 1]; i += 2;
    if (sec === 'HEADER') {
      while (i < n && !(codes[i] === 0)) {
        if (codes[i] === 9) {
          const name = vals[i]; i++; const vv = [];
          while (i < n && codes[i] !== 9 && codes[i] !== 0) { vv.push(vals[i]); i++; }
          doc.header[name] = vv.length === 1 ? vv[0] : vv;
        } else i++;
      }
    } else if (sec === 'TABLES') {
      while (i < n) {
        if (codes[i] !== 0) { i++; continue; }
        const type = vals[i]; if (type === 'ENDSEC') break;
        const s = i + 1, e = nextZero(s); i = e;
        if (type === 'LAYER') {
          const f = scan(s, e); if (f[2] === undefined) continue;
          const col = f[62] === undefined ? 7 : f[62], fl = f[70] || 0;
          const idx = addLayer(f[2], { color: Math.abs(col) || 7, tc: f[420] === undefined ? null : f[420], ltype: String(f[6] || 'CONTINUOUS'), off: col < 0, frozen: (fl & 1) === 1, locked: (fl & 4) === 4 });
          if (f[5] !== undefined) doc.layerByHandle.set(String(f[5]).toUpperCase(), idx);
        } else if (type === 'BLOCK_RECORD') {
          const f = scan(s, e); if (f[5] !== undefined && f[2] !== undefined) doc.blockRecs.set(String(f[5]).toUpperCase(), String(f[2]));
        }
      }
    } else if (sec === 'BLOCKS') {
      while (i < n) {
        if (codes[i] !== 0) { i++; continue; }
        const type = vals[i]; if (type === 'ENDSEC') break;
        if (type === 'BLOCK') {
          const s = i + 1, e = nextZero(s); i = e;
          const f = scan(s, e);
          const blk = { name: String(f[2] || ''), bx: f[10] || 0, by: f[20] || 0, ents: readEntities() };
          doc.blocks.set(blk.name.toUpperCase(), blk);
        } else i++;
      }
    } else if (sec === 'ENTITIES') {
      entities = readEntities();
    } else if (sec === 'OBJECTS') {
      while (i < n) {
        if (codes[i] !== 0) { i++; continue; }
        const type = vals[i]; if (type === 'ENDSEC') break;
        const s = i + 1, e = nextZero(s); i = e;
        if (type !== 'LAYOUT') continue;
        let j = s; while (j < e && !(codes[j] === 100 && vals[j] === 'AcDbLayout')) j++;
        const lay = { name: '', order: 0, rec: '' }; let in102 = false;
        for (; j < e; j++) {
          const c = codes[j];
          if (c === 102) { in102 = String(vals[j]).charAt(0) === '{'; continue; }
          if (in102) continue;
          if (c === 1 && !lay.name) lay.name = String(vals[j]); else if (c === 71) lay.order = vals[j];
          else if (c === 330 && !lay.rec) lay.rec = String(vals[j]).toUpperCase();
        }
        layoutsRaw.push(lay);
      }
    }
  }

  const modelEnts = [], paperEnts = [];
  for (const en of entities) (en.paper ? paperEnts : modelEnts).push(en);
  const ms = doc.blocks.get('*MODEL_SPACE'); if (ms) for (const en of ms.ents) modelEnts.push(en);
  doc.layouts.push({ name: 'Model', isModel: true, order: -1, ents: modelEnts });
  layoutsRaw.sort((a, b) => a.order - b.order);
  let usedPaper = false;
  for (const lr of layoutsRaw) {
    const bn = (doc.blockRecs.get(lr.rec) || '').toUpperCase();
    if (!bn || bn === '*MODEL_SPACE') continue;
    const blk = doc.blocks.get(bn);
    let ents = blk ? blk.ents : [];
    if (bn === '*PAPER_SPACE') { ents = paperEnts.concat(ents); usedPaper = true; }
    doc.layouts.push({ name: lr.name || bn, isModel: false, order: lr.order, ents });
  }
  if (!usedPaper && paperEnts.length) doc.layouts.push({ name: 'Paper', isModel: false, order: 999, ents: paperEnts });
  for (const lay of doc.layouts) {
    lay.viewports = lay.isModel ? [] : lay.ents.filter(v => v.t === 'VIEWPORT' && v.id !== 1 && v.status !== 0 && v.w > 0 && v.hh > 0 && v.vh > 0);
    for (const vp of lay.viewports) {
      vp.frozenIdx = new Set();
      for (const h of vp.frozen) { const li = doc.layerByHandle.get(h); if (li !== undefined) vp.frozenIdx.add(li); }
    }
  }
  if (!doc.layers.length) addLayer('0');
  doc.version = String(doc.header.$ACADVER || '');
  return doc;
}

/* ---------- geometry helpers ---------- */
function mul(A, B) { // apply B first, then A
  if (!A) return B; if (!B) return A;
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
}
function ocsMatrix(ext) {
  if (!ext) return null;
  let nx = ext[0], ny = ext[1], nz = ext[2];
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { ax = nz; ay = 0; az = -nx; } else { ax = -ny; ay = nx; az = 0; }
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  const bx = ny * az - nz * ay, by = nz * ax - nx * az;
  return [ax, ay, bx, by, 0, 0];
}
function bulgePath(vs, closed) {
  const pts = [], ends = [];
  let curved = false;
  const n = vs.length;
  for (let k = 0; k < n; k++) {
    const v = vs[k];
    pts.push(v[0], v[1]); ends.push(v[0], v[1]);
    const b = v[2];
    if (b && (k < n - 1 || closed)) {
      const w = vs[(k + 1) % n], x1 = v[0], y1 = v[1], x2 = w[0], y2 = w[1];
      const th = 4 * Math.atan(b), q = (1 - b * b) / (4 * b);
      const cx = (x1 + x2) / 2 - (y2 - y1) * q, cy = (y1 + y2) / 2 + (x2 - x1) * q, r = Math.hypot(x1 - cx, y1 - cy);
      const a1 = Math.atan2(y1 - cy, x1 - cx), ns = Math.max(2, Math.ceil(Math.abs(th) / (PI / 24)));
      for (let s = 1; s < ns; s++) { const a = a1 + th * s / ns; pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
      curved = true;
    }
  }
  return { pts, ends: curved ? ends : null };
}
function bspline(deg, knots, ctrl, w) {
  const nc = ctrl.length, out = [];
  if (nc < 2) return out;
  if (deg < 1 || knots.length < nc + deg + 1 || nc <= deg) { for (const c of ctrl) out.push(c[0], c[1]); return out; }
  const t0 = knots[deg], t1 = knots[nc], ns = Math.min(600, Math.max(16, nc * 8));
  if (!(t1 > t0)) { for (const c of ctrl) out.push(c[0], c[1]); return out; }
  const dx = new Array(deg + 1), dy = new Array(deg + 1), dw = new Array(deg + 1);
  let k = deg;
  for (let s = 0; s <= ns; s++) {
    const t = s === ns ? t1 : t0 + (t1 - t0) * s / ns;
    while (k < nc - 1 && knots[k + 1] <= t) k++;
    for (let j = 0; j <= deg; j++) { const c = ctrl[k - deg + j], ww = w ? w[k - deg + j] : 1; dx[j] = c[0] * ww; dy[j] = c[1] * ww; dw[j] = ww; }
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const i0 = j + k - deg, den = knots[i0 + deg - r + 1] - knots[i0], a = den ? (t - knots[i0]) / den : 0;
      dx[j] = (1 - a) * dx[j - 1] + a * dx[j]; dy[j] = (1 - a) * dy[j - 1] + a * dy[j]; dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
    }
    const ww = dw[deg] || 1; out.push(dx[deg] / ww, dy[deg] / ww);
  }
  return out;
}
function dashClass(name) {
  if (!name) return 0;
  const u = String(name).toUpperCase();
  if (u === 'CONTINUOUS' || u === 'BYLAYER' || u === 'BYBLOCK') return 0;
  if (/CENTER|PHANTOM|DIVIDE|DASHDOT|BORDER|CHAIN/.test(u)) return 2;
  if (/DOT/.test(u)) return 3;
  return 1;
}
let measureText = (s) => s.length * 0.6; // width in units of text height; the app replaces this with a canvas-based measure
function setMeasure(fn) { measureText = fn; }

/* ---------- flatten: entities -> drawable primitives ---------- */
// prim kinds: 0 path {p, cl, ends?}, 1 arc {x,y,r,a0,a1,full}, 2 fill {loops, solid}, 3 text, 4 point
function flatten(doc, ents) {
  const out = [], stats = { unsupported: {}, truncated: false };
  const layers = doc.layers;

  function style(e, ctx) {
    let li = doc.layerIdx.get(e.layer.toUpperCase());
    if (li === undefined) li = doc.addLayer(e.layer);
    if (ctx.depth > 0 && ctx.layer >= 0 && e.layer === '0') li = ctx.layer;
    const L = layers[li];
    let c;
    if (e.tc !== undefined && e.tc !== null) c = e.tc & 0xffffff;
    else {
      const ci = e.color === undefined ? 256 : e.color;
      if (ci === 256) c = L.tc !== null ? (L.tc & 0xffffff) : (L.color === 7 ? -1 : aciToRgb(L.color));
      else if (ci === 0) c = ctx.color;
      else c = ci === 7 ? -1 : aciToRgb(ci);
    }
    const ltn = e.lt === undefined ? 'BYLAYER' : String(e.lt).toUpperCase();
    const d = ltn === 'BYLAYER' ? dashClass(L.ltype) : ltn === 'BYBLOCK' ? ctx.dash : dashClass(ltn);
    return { li, c, d, l2: ctx.ins2 };
  }
  function push(p, st, x0, y0, x1, y1) {
    p.li = st.li; p.l2 = st.l2; p.c = st.c; p.d = st.d; p.bb = [x0, y0, x1, y1];
    layers[st.li].count++;
    out.push(p);
  }
  function xf(M, pts) {
    if (!M) return pts instanceof Float64Array ? pts : Float64Array.from(pts);
    const r = new Float64Array(pts.length);
    for (let k = 0; k < pts.length; k += 2) { const x = pts[k], y = pts[k + 1]; r[k] = M[0] * x + M[2] * y + M[4]; r[k + 1] = M[1] * x + M[3] * y + M[5]; }
    return r;
  }
  function bbox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) { const x = p[k], y = p[k + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }
  function addPath(pts, closed, st, M, ends) {
    if (pts.length < 4) return;
    const p = xf(M, pts), b = bbox(p);
    if (!isFinite(b[0] + b[1] + b[2] + b[3])) return;
    const prim = { k: 0, p, cl: !!closed };
    if (ends) prim.ends = xf(M, ends);
    push(prim, st, b[0], b[1], b[2], b[3]);
  }
  function addArc(cx, cy, r, a0, a1, full, st, M) {
    if (!(r > 0)) return;
    if (M) {
      const sx2 = M[0] * M[0] + M[1] * M[1], sy2 = M[2] * M[2] + M[3] * M[3], dot = M[0] * M[2] + M[1] * M[3];
      if (Math.abs(sx2 - sy2) > 1e-6 * (sx2 + sy2) || Math.abs(dot) > 1e-6 * (sx2 + sy2)) {
        if (full) { a0 = 0; a1 = TAU; } else if (a1 <= a0) a1 += TAU;
        const ns = Math.max(8, Math.ceil((a1 - a0) / (PI / 36))), pts = [];
        for (let s = 0; s <= ns; s++) { const a = a0 + (a1 - a0) * s / ns; pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        addPath(pts, false, st, M, [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
        return;
      }
      const s = Math.sqrt(sx2), det = M[0] * M[3] - M[1] * M[2];
      const ncx = M[0] * cx + M[2] * cy + M[4], ncy = M[1] * cx + M[3] * cy + M[5];
      if (!full) {
        const ang = (a) => { const c = Math.cos(a), sn = Math.sin(a); return Math.atan2(M[1] * c + M[3] * sn, M[0] * c + M[2] * sn); };
        const b0 = ang(a0), b1 = ang(a1);
        if (det < 0) { a0 = b1; a1 = b0; } else { a0 = b0; a1 = b1; }
      }
      cx = ncx; cy = ncy; r *= s;
    }
    if (!isFinite(cx + cy + r)) return;
    if (!full) { a0 = ((a0 % TAU) + TAU) % TAU; a1 = ((a1 % TAU) + TAU) % TAU; if (a1 <= a0) a1 += TAU; }
    push({ k: 1, x: cx, y: cy, r, a0: full ? 0 : a0, a1: full ? TAU : a1, full: !!full }, st, cx - r, cy - r, cx + r, cy + r);
  }
  function addText(x, y, h, rotRad, wf, s, ha, va, st, M) {
    if (!s || !(h > 0)) return;
    if (M) {
      const c = Math.cos(rotRad), sn = Math.sin(rotRad);
      const ux = M[0] * c + M[2] * sn, uy = M[1] * c + M[3] * sn, vx = -M[0] * sn + M[2] * c, vy = -M[1] * sn + M[3] * c;
      const su = Math.hypot(ux, uy), sv = Math.hypot(vx, vy);
      const nx = M[0] * x + M[2] * y + M[4], ny = M[1] * x + M[3] * y + M[5];
      x = nx; y = ny; rotRad = Math.atan2(uy, ux); h *= sv; wf *= sv ? su / sv : 1;
    }
    if (!isFinite(x + y + h) || !(h > 0)) return;
    const w = measureText(s) * h * wf, lx0 = ha === 1 ? -w / 2 : ha === 2 ? -w : 0;
    const ly0 = va === 1 ? 0 : va === 2 ? -0.6 * h : va === 3 ? -1.25 * h : -0.25 * h, ly1 = ly0 + 1.25 * h;
    const c = Math.cos(rotRad), sn = Math.sin(rotRad);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of [[lx0, ly0], [lx0 + w, ly0], [lx0 + w, ly1], [lx0, ly1]]) {
      const px = x + c * q[0] - sn * q[1], py = y + sn * q[0] + c * q[1];
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    push({ k: 3, x, y, h, rot: rotRad, wf, s, ha, va }, st, x0, y0, x1, y1);
  }

  function emit(e, ctx) {
    if (out.length >= MAX_PRIMS) { stats.truncated = true; return; }
    if (e.inv) return;
    if (e.unsupported) { stats.unsupported[e.t] = (stats.unsupported[e.t] || 0) + 1; return; }
    if (e.t === 'VIEWPORT') return;
    const st = style(e, ctx);
    const M = e.ext ? mul(ctx.M, ocsMatrix(e.ext)) : ctx.M;
    switch (e.t) {
      case 'LINE': addPath([e.x1, e.y1, e.x2, e.y2], false, st, M); break;
      case 'POINT': {
        const p = xf(M, [e.x, e.y]);
        if (isFinite(p[0] + p[1])) push({ k: 4, x: p[0], y: p[1] }, st, p[0], p[1], p[0], p[1]);
        break;
      }
      case 'CIRCLE': addArc(e.x, e.y, e.r, 0, TAU, true, st, M); break;
      case 'ARC': addArc(e.x, e.y, e.r, e.a0 * DEG, e.a1 * DEG, false, st, M); break;
      case 'ELLIPSE': {
        let t0 = e.t0, t1 = e.t1; if (t1 <= t0) t1 += TAU;
        const full = Math.abs(t1 - t0 - TAU) < 1e-9;
        const nz = e.ext && e.ext[2] < 0 ? -1 : 1;
        const qx = -nz * e.my * e.ratio, qy = nz * e.mx * e.ratio;
        const ns = Math.max(12, Math.ceil((t1 - t0) / (PI / 36))), pts = [];
        for (let s = 0; s <= ns; s++) { const t = t0 + (t1 - t0) * s / ns, c = Math.cos(t), sn = Math.sin(t); pts.push(e.x + c * e.mx + sn * qx, e.y + c * e.my + sn * qy); }
        addPath(pts, false, st, ctx.M, full ? [e.x, e.y] : [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
        break;
      }
      case 'LWPOLYLINE': { const bp = bulgePath(e.vs, e.closed); addPath(bp.pts, e.closed, st, M, bp.ends); break; }
      case 'POLYLINE': {
        if (e.flags & 64) {
          for (const f of e.faces) {
            const pts = [];
            for (const ix of f) { const v = e.vs[Math.abs(ix) - 1]; if (ix && v) pts.push(v[0], v[1]); }
            if (pts.length >= 4) addPath(pts, pts.length > 4, st, ctx.M);
          }
        } else if (e.flags & 16) {
          const m = e.m, nn = e.n;
          if (m * nn <= e.vs.length) {
            for (let a = 0; a < m; a++) { const pts = []; for (let b = 0; b < nn; b++) { const v = e.vs[a * nn + b]; pts.push(v[0], v[1]); } addPath(pts, (e.flags & 32) !== 0, st, ctx.M); }
            for (let b = 0; b < nn; b++) { const pts = []; for (let a = 0; a < m; a++) { const v = e.vs[a * nn + b]; pts.push(v[0], v[1]); } addPath(pts, (e.flags & 1) !== 0, st, ctx.M); }
          }
        } else {
          const is3d = (e.flags & 8) !== 0, closed = (e.flags & 1) !== 0;
          const bp = bulgePath(is3d ? e.vs.map(v => [v[0], v[1], 0]) : e.vs, closed);
          addPath(bp.pts, closed, st, is3d ? ctx.M : M, bp.ends);
        }
        break;
      }
      case 'SPLINE': {
        let pts = e.ctrl.length >= 2 ? bspline(e.deg, e.knots, e.ctrl, e.w) : e.fit;
        if (pts.length >= 4) addPath(pts, false, st, ctx.M, [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
        break;
      }
      case 'TEXT': case 'ATTRIB': {
        let x = e.x, y = e.y, ha = 0, va = 0;
        if ((e.ha || e.va) && e.hasAlign) {
          if (e.ha === 3 || e.ha === 5) { ha = 0; va = 0; }
          else { x = e.ax; y = e.ay; ha = e.ha === 4 ? 1 : Math.min(e.ha, 2); va = e.ha === 4 ? 2 : e.va; }
        }
        addText(x, y, e.hgt, e.rot * DEG, e.wf, e.s, ha, va, st, M);
        break;
      }
      case 'MTEXT': {
        const h = e.hgt, rot = e.rot * DEG, sp = h * 1.6667 * e.lsf;
        let lines = [];
        for (const para of e.s.split('\n')) {
          if (e.w > 0 && measureText(para) * h > e.w * 1.02 && para.indexOf(' ') > 0) {
            let cur = '';
            for (const word of para.split(' ')) {
              const t = cur ? cur + ' ' + word : word;
              if (cur && measureText(t) * h > e.w) { lines.push(cur); cur = word; } else cur = t;
            }
            lines.push(cur);
          } else lines.push(para);
        }
        if (lines.length > 400) lines = lines.slice(0, 400);
        const att = e.att, col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
        const total = (lines.length - 1) * sp + h;
        const top = row === 0 ? 0 : row === 1 ? total / 2 : total;
        const c = Math.cos(rot), sn = Math.sin(rot);
        for (let k = 0; k < lines.length; k++) {
          if (!lines[k]) continue;
          const oy = top - k * sp;
          addText(e.x - sn * oy, e.y + c * oy, h, rot, 1, lines[k], col, 3, st, ctx.M);
        }
        break;
      }
      case 'INSERT': case 'DIMENSION': {
        const blk = doc.blocks.get(e.name.toUpperCase());
        if (!blk || ctx.depth > 14 || ctx.stack.indexOf(blk) >= 0) break;
        const sub = { M: null, layer: st.li, color: st.c, dash: st.d, ins2: ctx.depth === 0 ? st.li : ctx.ins2, depth: ctx.depth + 1, stack: ctx.stack.concat([blk]) };
        if (e.t === 'DIMENSION') { sub.M = ctx.M; for (const be of blk.ents) emit(be, sub); break; }
        const r = e.rot * DEG, c = Math.cos(r), sn = Math.sin(r);
        const base = mul(M, [c, sn, -sn, c, e.x, e.y]);
        for (let row = 0; row < e.rows; row++) for (let colm = 0; colm < e.cols; colm++) {
          sub.M = mul(base, [e.sx, 0, 0, e.sy, colm * e.dx - e.sx * blk.bx, row * e.dy - e.sy * blk.by]);
          for (const be of blk.ents) emit(be, sub);
        }
        for (const a of e.atts) emit(a, ctx);
        break;
      }
      case 'HATCH': {
        if (!e.loops.length) break;
        const loops = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of e.loops) { const p = xf(M, l), b = bbox(p); loops.push(p); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
        if (isFinite(x0 + y0 + x1 + y1)) push({ k: 2, loops, solid: e.solid }, st, x0, y0, x1, y1);
        break;
      }
      case 'SOLID': case 'TRACE': {
        const p = xf(M, e.p), b = bbox(p);
        if (isFinite(b[0] + b[1] + b[2] + b[3])) push({ k: 2, loops: [p], solid: true }, st, b[0], b[1], b[2], b[3]);
        break;
      }
      case '3DFACE': case 'IMAGE': addPath(e.p, true, st, ctx.M); break;
      case 'LEADER': addPath(e.p, false, st, ctx.M); break;
      case 'MLEADER': {
        for (const l of e.lines) addPath(l, false, st, ctx.M);
        if (e.text && e.tx && e.th > 0) {
          const lines = mtextPlain(e.text).split('\n'), c = Math.cos(e.trot), sn = Math.sin(e.trot);
          for (let k = 0; k < lines.length; k++) { const oy = -k * e.th * 1.6667; addText(e.tx[0] - sn * oy, e.tx[1] + c * oy, e.th, e.trot, 1, lines[k], 0, 3, st, ctx.M); }
        }
        break;
      }
    }
  }

  const ctx0 = { M: null, layer: -1, color: -1, dash: 0, ins2: -1, depth: 0, stack: [] };
  for (const e of ents) emit(e, ctx0);
  const rank = (p) => p.k === 2 ? 0 : p.k === 3 ? 2 : 1;
  out.sort((a, b) => (rank(a) - rank(b)) || (a.c - b.c) || (a.d - b.d));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of out) { const b = p.bb; if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
  return { prims: out, bbox: out.length ? [x0, y0, x1, y1] : [0, 0, 100, 100], stats };
}

function viewportMatrix(vp) { // model -> paper
  const k = vp.hh / vp.vh, c = Math.cos(vp.twist * DEG), s = Math.sin(vp.twist * DEG);
  const a = k * c, b = k * s, cc = -k * s, d = k * c;
  return [a, b, cc, d, vp.cx - k * vp.vcx - (a * vp.tx + cc * vp.ty), vp.cy - k * vp.vcy - (b * vp.tx + d * vp.ty)];
}

/* ---------- exporters ---------- */
const num = (v) => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s.indexOf('e') >= 0 ? v.toFixed(6) : s; };

function exportR12(doc, prims, visible) {
  const o = [];
  const g = (c, v) => { o.push(c, v); };
  const lname = (i) => (doc.layers[i].name.toUpperCase().replace(/[^A-Z0-9_$-]/g, '_').slice(0, 31) || '0');
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0); g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, doc.layers.length);
  doc.layers.forEach((L, i) => { g(0, 'LAYER'); g(2, lname(i)); g(70, 0); g(62, L.tc !== null ? rgbToAci(L.tc & 0xffffff) : L.color); g(6, 'CONTINUOUS'); });
  g(0, 'ENDTAB'); g(0, 'ENDSEC'); g(0, 'SECTION'); g(2, 'ENTITIES');
  const aciCache = new Map();
  const aci = (c) => { if (c < 0) return 7; let a = aciCache.get(c); if (a === undefined) { a = rgbToAci(c); aciCache.set(c, a); } return a; };
  const head = (t, p) => { g(0, t); g(8, lname(p.li)); g(62, aci(p.c)); };
  const poly = (p, pts, closed) => {
    if (pts.length === 4 && !closed) { head('LINE', p); g(10, num(pts[0])); g(20, num(pts[1])); g(11, num(pts[2])); g(21, num(pts[3])); return; }
    head('POLYLINE', p); g(66, 1); g(70, closed ? 1 : 0);
    for (let k = 0; k < pts.length; k += 2) { g(0, 'VERTEX'); g(8, lname(p.li)); g(10, num(pts[k])); g(20, num(pts[k + 1])); }
    g(0, 'SEQEND'); g(8, lname(p.li));
  };
  for (const p of prims) {
    if (visible && !visible(p)) continue;
    if (p.k === 0) poly(p, p.p, p.cl);
    else if (p.k === 1) {
      head(p.full ? 'CIRCLE' : 'ARC', p); g(10, num(p.x)); g(20, num(p.y)); g(40, num(p.r));
      if (!p.full) { g(50, num(p.a0 / DEG)); g(51, num((p.a1 / DEG) % 360)); }
    } else if (p.k === 2) { for (const l of p.loops) poly(p, l, true); }
    else if (p.k === 3) {
      head('TEXT', p); g(10, num(p.x)); g(20, num(p.y)); g(40, num(p.h)); g(1, p.s.replace(/[\r\n]/g, ' '));
      if (p.rot) g(50, num(p.rot / DEG)); if (p.wf !== 1) g(41, num(p.wf));
      if (p.ha || p.va) { g(72, p.ha); g(73, p.va); g(11, num(p.x)); g(21, num(p.y)); }
    } else if (p.k === 4) { head('POINT', p); g(10, num(p.x)); g(20, num(p.y)); }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  const lines = new Array(o.length);
  for (let k = 0; k < o.length; k += 2) { lines[k] = String(o[k]).padStart(3, ' '); lines[k + 1] = String(o[k + 1]); }
  return lines.join('\r\n') + '\r\n';
}

function exportSVG(space, model, visible) {
  // space: {prims, bbox, viewports}; model: {prims}; visible(p, frozenSet) -> bool
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (c) => c < 0 || c === 0xffffff ? '#000' : '#' + c.toString(16).padStart(6, '0');
  let b = space.bbox.slice();
  for (const vp of space.viewports || []) { b[0] = Math.min(b[0], vp.cx - vp.w / 2); b[1] = Math.min(b[1], vp.cy - vp.hh / 2); b[2] = Math.max(b[2], vp.cx + vp.w / 2); b[3] = Math.max(b[3], vp.cy + vp.hh / 2); }
  const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.02 || 1;
  const w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(b[0] - pad)} ${num(-b[3] - pad)} ${num(w)} ${num(h)}" width="${Math.round(1600)}" height="${Math.round(1600 * h / w)}">`);
  out.push('<rect x="' + num(b[0] - pad) + '" y="' + num(-b[3] - pad) + '" width="' + num(w) + '" height="' + num(h) + '" fill="#fff"/>');
  out.push('<g transform="scale(1,-1)" fill="none" stroke-width="1" stroke-linecap="round" font-family="Arial, Helvetica, sans-serif">');
  const dash = ['', ' stroke-dasharray="6 3"', ' stroke-dasharray="10 3 2 3"', ' stroke-dasharray="1.5 3"'];
  function dump(prims, frozen) {
    for (const p of prims) {
      if (!visible(p, frozen)) continue;
      const c = col(p.c), st = ` stroke="${c}" vector-effect="non-scaling-stroke"${dash[p.d]}`;
      if (p.k === 0) {
        let d = 'M'; for (let k = 0; k < p.p.length; k += 2) d += (k ? ' L' : '') + num(p.p[k]) + ' ' + num(p.p[k + 1]);
        out.push(`<path d="${d}${p.cl ? ' Z' : ''}"${st}/>`);
      } else if (p.k === 1) {
        if (p.full) out.push(`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${num(p.r)}"${st}/>`);
        else {
          const x0 = p.x + p.r * Math.cos(p.a0), y0 = p.y + p.r * Math.sin(p.a0), x1 = p.x + p.r * Math.cos(p.a1), y1 = p.y + p.r * Math.sin(p.a1);
          out.push(`<path d="M${num(x0)} ${num(y0)} A${num(p.r)} ${num(p.r)} 0 ${p.a1 - p.a0 > PI ? 1 : 0} 1 ${num(x1)} ${num(y1)}"${st}/>`);
        }
      } else if (p.k === 2) {
        let d = ''; for (const l of p.loops) { d += 'M'; for (let k = 0; k < l.length; k += 2) d += (k ? ' L' : '') + num(l[k]) + ' ' + num(l[k + 1]); d += ' Z '; }
        out.push(`<path d="${d}" fill="${c}" fill-opacity="${p.solid ? 0.9 : 0.15}" fill-rule="evenodd" stroke="none"/>`);
      } else if (p.k === 3) {
        const anchor = ['start', 'middle', 'end'][p.ha] || 'start', dy = [0, 0.15, -0.5, -1][p.va] || 0;
        out.push(`<text transform="translate(${num(p.x)} ${num(p.y)}) rotate(${num(p.rot / DEG)}) scale(${num(p.wf)},-1)" font-size="${num(p.h / 0.72)}" text-anchor="${anchor}" y="${num(-dy * p.h)}" fill="${c}" stroke="none">${esc(p.s)}</text>`);
      } else if (p.k === 4) out.push(`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="0.01"${st}/>`);
    }
  }
  dump(space.prims, null);
  let id = 0;
  for (const vp of space.viewports || []) {
    const M = viewportMatrix(vp); id++;
    out.push(`<clipPath id="vp${id}"><rect x="${num(vp.cx - vp.w / 2)}" y="${num(vp.cy - vp.hh / 2)}" width="${num(vp.w)}" height="${num(vp.hh)}"/></clipPath>`);
    out.push(`<g clip-path="url(#vp${id})"><g transform="matrix(${M.map(num).join(' ')})">`);
    dump(model.prims, vp.frozenIdx);
    out.push('</g></g>');
  }
  out.push('</g>\n</svg>\n');
  return out.join('\n');
}

const VERSIONS = { AC1006: 'R10', AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };

return { parse, flatten, viewportMatrix, exportR12, exportSVG, aciToRgb, rgbToAci, setMeasure, mul, VERSIONS, mtextPlain };
});
