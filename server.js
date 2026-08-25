const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || '').trim();
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/device.html'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function socketOriginAllowed(origin) {
  if (!PUBLIC_ORIGIN && !ALLOWED_ORIGINS.length) return true;
  if (!origin) return true;
  return origin === PUBLIC_ORIGIN || ALLOWED_ORIGINS.includes(origin);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) { callback(socketOriginAllowed(origin) ? null : new Error('Origem não permitida'), socketOriginAllowed(origin)); },
    credentials: true
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 2e6
});

const TEAM_COLORS = ['blue', 'red', 'green', 'yellow'];
const ROLES = ['pilot', 'copilot'];
const DIFFICULTIES = ['easy', 'hard'];
const ROOM_MODES = ['online', 'smartphone'];
const rooms = new Map();
const emptyTimers = new Map();
const countdownTimers = new Map();
const finalTeamTimers = new Map();
const EMPTY_ROOM_MS = 10 * 60 * 1000;

function cleanName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length < 1 || text.length > 24) return null;
  if (/[<>\\{}]/.test(text)) return null;
  return text;
}
function cleanCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 1000; tries += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Não foi possível gerar código de sala.');
}
function makeId() { return crypto.randomUUID(); }
function makeToken() { return crypto.randomBytes(24).toString('base64url'); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleQuadratic(p0, c, p1, steps) {
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps, u = 1 - t;
    out.push({ x: u*u*p0.x + 2*u*t*c.x + t*t*p1.x, y: u*u*p0.y + 2*u*t*c.y + t*t*p1.y });
  }
  return out;
}
function sampleLine(p0, p1, steps) {
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    out.push({ x: p0.x + (p1.x-p0.x)*t, y: p0.y + (p1.y-p0.y)*t });
  }
  return out;
}
function pointAtFraction(points, fraction) {
  let total = 0;
  const lens = [];
  for (let i = 1; i < points.length; i += 1) { const l = dist(points[i-1], points[i]); lens.push(l); total += l; }
  const target = total * fraction;
  let acc = 0;
  for (let i = 1; i < points.length; i += 1) {
    const l = lens[i-1];
    if (acc + l >= target) {
      const t = (target - acc) / Math.max(l, 1e-9);
      return { x: points[i-1].x + (points[i].x-points[i-1].x)*t, y: points[i-1].y + (points[i].y-points[i-1].y)*t };
    }
    acc += l;
  }
  return points[points.length - 1];
}
function startCellLabel(start, difficulty) {
  // O trajeto parte da linha vertical central e entra no quadrante superior direito (△).
  const cols = difficulty === 'hard' ? 8 : 4;
  const rows = difficulty === 'hard' ? 12 : 6;
  const localX = 0; // borda esquerda do quadrante superior direito
  const localY = clamp(start.y / 0.5, 0, 0.999999);
  const col = Math.min(cols - 1, Math.floor(localX * cols));
  const row = Math.min(rows - 1, Math.floor(localY * rows)) + 1;
  return `△${String.fromCharCode(65 + col)}${row}`;
}
function trackCellCount(points, difficulty) {
  const W = 592, H = 840;
  const targetMask = new Uint8Array(W * H);
  const trackRadius = 0.0045 * W;
  for (let i = 1; i < points.length; i += 1) rasterLine(targetMask, W, H, points[i - 1], points[i], trackRadius, 1);
  const { cols, rows } = acetateGrid(difficulty);
  return cellsFromMask(targetMask, W, H, cols, rows).indexes.length;
}
function fastTrackCellCount(points, difficulty) {
  // Pré-checagem barata para o gerador. A aferição final continua usando o
  // raster completo; aqui só evitamos rasterizar centenas de candidatos ruins.
  const { cols, rows } = acetateGrid(difficulty);
  const occupied = new Uint8Array(cols * rows);
  const mark = (x, y) => {
    const col = Math.max(0, Math.min(cols - 1, Math.floor(x * cols)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(y * rows)));
    occupied[row * cols + col] = 1;
  };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx) * cols, Math.abs(dy) * rows) * 12));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      mark(a.x + dx * t, a.y + dy * t);
    }
  }
  let count = 0;
  for (const value of occupied) count += value;
  return count;
}
function pickInt(rand, a, b) {
  return a + Math.floor(rand() * (b - a + 1));
}
function buildMapSpanProfile(rand, rows, cols, difficulty) {
  // O contorno nasce de uma massa única e contínua, como uma silhueta de mapa.
  // Os limites laterais variam por faixas, criando baías, cabos, trechos retos e
  // gargalos sem lançar "raios" em direção ao centro (efeito de estrela).
  const marginRows = Math.max(1, Math.round(rows * 0.08));
  const activeRows = Math.max(4, rows - marginRows * 2);
  const left = new Array(activeRows);
  const right = new Array(activeRows);
  let l = pickInt(rand, 0, Math.max(0, Math.floor(cols * 0.22)));
  let r = pickInt(rand, Math.max(l + 2, Math.floor(cols * 0.72)), cols - 1);
  const centerLeft = Math.floor((cols - 1) / 2);
  const centerRight = Math.ceil((cols - 1) / 2);

  for (let row = 0; row < activeRows; row += 1) {
    if (row > 0) {
      const prevL = l;
      const prevR = r;
      const stepMax = difficulty === 'hard'
        ? Math.max(2, Math.round(cols * 0.18))
        : Math.max(3, Math.round(cols * 0.30));
      const weighted = [-stepMax, -1, 0, 0, 0, 1, stepMax];
      l += weighted[pickInt(rand, 0, weighted.length - 1)];
      r += weighted[pickInt(rand, 0, weighted.length - 1)];
      const jumpChance = difficulty === 'hard' ? 0.18 : 0.28;
      if (rand() < jumpChance) l += rand() < 0.5 ? -stepMax : stepMax;
      if (rand() < jumpChance) r += rand() < 0.5 ? -stepMax : stepMax;

      if (rand() < 0.10) {
        const width = pickInt(
          rand,
          Math.max(2, Math.floor(cols * 0.28)),
          Math.max(3, Math.floor(cols * 0.62))
        );
        const center = pickInt(rand, Math.floor(cols * 0.28), Math.ceil(cols * 0.72));
        l = center - Math.floor(width / 2);
        r = l + width;
      }

      l = clamp(l, 0, cols - 3);
      r = clamp(r, l + 2, cols - 1);

      // Mantém sobreposição entre faixas consecutivas. Isso garante uma única
      // massa simples e impede cruzamentos/ilhas internas no contorno.
      if (l > prevR) l = prevR;
      if (r < prevL) r = prevL;
      l = clamp(l, 0, cols - 3);
      r = clamp(r, l + 2, cols - 1);
    }

    // Topo e base sempre atravessam o eixo vertical, permitindo largadas exatas.
    if (row === 0 || row === activeRows - 1) {
      l = Math.min(l, centerLeft);
      r = Math.max(r, centerRight);
    }
    left[row] = l;
    right[row] = r;
  }

  return { left, right, rows: activeRows, totalRows: rows, cols, marginRows };
}
function orthogonalMapPolygon(profile) {
  const { left, right, rows, totalRows, cols, marginRows } = profile;
  const y0 = marginRows / totalRows;
  const points = [
    { x: left[0] / cols, y: y0 },
    { x: (right[0] + 1) / cols, y: y0 }
  ];

  // Costa direita, de cima para baixo.
  for (let row = 0; row < rows; row += 1) {
    const y = (marginRows + row + 1) / totalRows;
    points.push({ x: (right[row] + 1) / cols, y });
    if (row < rows - 1 && right[row + 1] !== right[row]) {
      points.push({ x: (right[row + 1] + 1) / cols, y });
    }
  }

  // Base e costa esquerda, retornando ao topo.
  points.push({ x: left[rows - 1] / cols, y: (marginRows + rows) / totalRows });
  for (let row = rows - 1; row >= 0; row -= 1) {
    const y = (marginRows + row) / totalRows;
    points.push({ x: left[row] / cols, y });
    if (row > 0 && left[row - 1] !== left[row]) {
      points.push({ x: left[row - 1] / cols, y });
    }
  }

  return points.filter((point, index, all) =>
    index === 0 || Math.hypot(point.x - all[index - 1].x, point.y - all[index - 1].y) > 1e-9
  );
}
function roundMapPolygon(poly, rand, difficulty) {
  const n = poly.length;
  const pre = new Array(n);
  const post = new Array(n);
  const cuts = new Array(n);

  // Tamanhos diferentes de arredondamento produzem curvas leves, médias e
  // fechadas sem transformar a pista numa estrela. O Fácil preserva mais retas.
  for (let i = 0; i < n; i += 1) {
    const roll = rand();
    // Não usamos mais cortes minúsculos: eles eram responsáveis pelos pequenos
    // 'tiques' e pontas. Ainda há curvas fechadas, mas sempre com raio visível.
    cuts[i] = difficulty === 'hard'
      ? (roll < 0.25 ? 0.010 : roll < 0.55 ? 0.018 : roll < 0.82 ? 0.030 : 0.044)
      : (roll < 0.30 ? 0.008 : roll < 0.62 ? 0.015 : roll < 0.86 ? 0.025 : 0.038);
  }

  for (let i = 0; i < n; i += 1) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const vx = prev.x - cur.x;
    const vy = prev.y - cur.y;
    const wx = next.x - cur.x;
    const wy = next.y - cur.y;
    const lv = Math.hypot(vx, vy);
    const lw = Math.hypot(wx, wy);
    const d = Math.min(cuts[i], lv * 0.26, lw * 0.26);
    pre[i] = { x: cur.x + (lv ? vx / lv * d : 0), y: cur.y + (lv ? vy / lv * d : 0) };
    post[i] = { x: cur.x + (lw ? wx / lw * d : 0), y: cur.y + (lw ? wy / lw * d : 0) };
  }

  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = post[(i - 1 + n) % n];
    const b = pre[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const curveChance = difficulty === 'hard' ? 0.88 : 0.76;
    // Retas continuam existindo, mas uma reta enorme atravessando grande parte
    // da folha é convertida em uma curva ampla automaticamente.
    const forceCurve = len > (difficulty === 'hard' ? 0.18 : 0.20);
    const canBow = forceCurve || (len > (difficulty === 'hard' ? 0.060 : 0.075) && rand() < curveChance);

    if (canBow) {
      // O contorno é horário; a normal negativa aponta para fora da massa.
      // Curvar prioritariamente para fora mantém a silhueta simples.
      const nx = -dy / len;
      const ny = dx / len;
      const maxOff = difficulty === 'hard' ? Math.min(0.038, len * 0.18) : Math.min(0.032, len * 0.16);
      const off = -maxOff * (0.45 + rand() * 0.55);
      const control = {
        x: clamp((a.x + b.x) / 2 + nx * off, 0.012, 0.988),
        y: clamp((a.y + b.y) / 2 + ny * off, 0.012, 0.988)
      };
      const steps = Math.max(5, Math.ceil(len * 110));
      for (let k = 0; k < steps; k += 1) {
        const t = k / steps;
        const u = 1 - t;
        out.push({
          x: u*u*a.x + 2*u*t*control.x + t*t*b.x,
          y: u*u*a.y + 2*u*t*control.y + t*t*b.y
        });
      }
    } else {
      const steps = Math.max(2, Math.ceil(len * 90));
      for (let k = 0; k < steps; k += 1) {
        const t = k / steps;
        out.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
    }

    // Arredonda o vértice em si.
    const A = pre[i];
    const C = poly[i];
    const B = post[i];
    const angle = internalAngleDeg(A, C, B);
    const midpoint = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const cornerBlend = angle < 52 ? 0.72 : angle < 68 ? 0.52 : angle < 85 ? 0.34 : 0.18;
    const cornerControl = {
      x: C.x * (1 - cornerBlend) + midpoint.x * cornerBlend,
      y: C.y * (1 - cornerBlend) + midpoint.y * cornerBlend
    };
    const curveSteps = angle < 60 ? 10 : 8;
    for (let k = 0; k <= curveSteps; k += 1) {
      const t = k / curveSteps;
      const u = 1 - t;
      out.push({
        x: u*u*A.x + 2*u*t*cornerControl.x + t*t*B.x,
        y: u*u*A.y + 2*u*t*cornerControl.y + t*t*B.y
      });
    }
  }

  out.push({ ...out[0] });
  return out;
}
function organicMapWarp(points, rand, difficulty) {
  // Pequena deformação contínua quebra o aspecto de "grade" sem criar pontas.
  const a1 = (difficulty === 'hard' ? 0.008 : 0.003) * (0.6 + rand() * 0.7);
  const a2 = a1 * 0.45;
  const b1 = (difficulty === 'hard' ? 0.007 : 0.0028) * (0.6 + rand() * 0.7);
  const b2 = b1 * 0.40;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const q1 = rand() * Math.PI * 2;
  const q2 = rand() * Math.PI * 2;

  return points.map(point => {
    const ox = a1 * Math.sin(Math.PI * 2 * point.y + p1) + a2 * Math.sin(Math.PI * 4 * point.y + p2);
    const oy = b1 * Math.sin(Math.PI * 2 * point.x + q1) + b2 * Math.sin(Math.PI * 4 * point.x + q2);
    return { x: clamp(point.x + ox, 0.018, 0.982), y: clamp(point.y + oy, 0.018, 0.982) };
  });
}
function trackBounds(points) {
  let minx = 1, miny = 1, maxx = 0, maxy = 0;
  for (const p of points) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  return { minx, miny, maxx, maxy };
}
function applyDiagonalTransform(points, rand, difficulty) {
  const angle = (rand() - 0.5) * (difficulty === 'hard' ? Math.PI / 2.8 : Math.PI / 3.2);
  const shearX = (rand() - 0.5) * (difficulty === 'hard' ? 0.22 : 0.16);
  const shearY = (rand() - 0.5) * (difficulty === 'hard' ? 0.12 : 0.08);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const transformed = points.map(point => {
    const px = point.x - 0.5;
    const py = point.y - 0.5;
    const rx = px * cos - py * sin;
    const ry = px * sin + py * cos;
    const sx = rx + shearX * ry;
    const sy = ry + shearY * rx;
    return { x: sx, y: sy };
  });
  const b = trackBounds(transformed);
  const spanW = Math.max(1e-6, b.maxx - b.minx);
  const spanH = Math.max(1e-6, b.maxy - b.miny);
  const marginX = difficulty === 'hard' ? 0.045 : 0.055;
  const marginY = difficulty === 'hard' ? 0.04 : 0.05;
  const scale = Math.min((1 - marginX * 2) / spanW, (1 - marginY * 2) / spanH);
  const cx = (b.minx + b.maxx) / 2;
  const cy = (b.miny + b.maxy) / 2;
  return transformed.map(point => ({
    x: clamp((point.x - cx) * scale + 0.5, marginX, 1 - marginX),
    y: clamp((point.y - cy) * scale + 0.5, marginY, 1 - marginY)
  }));
}
function orient2d(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function strictSegmentIntersection(a, b, c, d) {
  const eps = 1e-7;
  const o1 = orient2d(a, b, c), o2 = orient2d(a, b, d), o3 = orient2d(c, d, a), o4 = orient2d(c, d, b);
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}
function hasSelfIntersection(points) {
  // Amostra no máximo ~180 vértices para uma validação rápida de forma.
  const step = Math.max(1, Math.floor(points.length / 180));
  const sampled = [];
  for (let i = 0; i < points.length - 1; i += step) sampled.push(points[i]);
  sampled.push(points[points.length - 1]);
  const n = sampled.length - 1;
  for (let i = 0; i < n; i += 1) {
    const a = sampled[i], b = sampled[i + 1];
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      if (strictSegmentIntersection(a, b, sampled[j], sampled[j + 1])) return true;
    }
  }
  return false;
}
function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2*p0.x - 5*p1.x + 4*p2.x - p3.x) * t2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2*p0.y - 5*p1.y + 4*p2.y - p3.y) * t2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y) * t3)
  };
}
function smoothArray(values, passes=1) {
  let arr = values.slice();
  for (let p = 0; p < passes; p += 1) {
    const next = arr.slice();
    for (let i = 0; i < arr.length; i += 1) {
      const prev = arr[(i - 1 + arr.length) % arr.length];
      const cur = arr[i];
      const nxt = arr[(i + 1) % arr.length];
      next[i] = prev * 0.22 + cur * 0.56 + nxt * 0.22;
    }
    arr = next;
  }
  return arr;
}
function gridKey(x, y) {
  return `${x},${y}`;
}
function orthNeighbors(x, y) {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 }
  ];
}
function connectedCount(occupied, cols, rows, startKey) {
  if (!occupied.size) return 0;
  const start = startKey || occupied.values().next().value;
  const stack = [start];
  const seen = new Set([start]);
  while (stack.length) {
    const key = stack.pop();
    const [xs, ys] = key.split(',');
    const x = +xs, y = +ys;
    for (const n of orthNeighbors(x, y)) {
      if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) continue;
      const nk = gridKey(n.x, n.y);
      if (occupied.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
    }
  }
  return seen.size;
}
function fillBlobHoles(occupied, cols, rows) {
  const seen = new Set();
  const stack = [];
  for (let x = 0; x < cols; x += 1) {
    for (const y of [0, rows - 1]) {
      const k = gridKey(x, y);
      if (!occupied.has(k) && !seen.has(k)) { seen.add(k); stack.push({ x, y }); }
    }
  }
  for (let y = 0; y < rows; y += 1) {
    for (const x of [0, cols - 1]) {
      const k = gridKey(x, y);
      if (!occupied.has(k) && !seen.has(k)) { seen.add(k); stack.push({ x, y }); }
    }
  }
  while (stack.length) {
    const cur = stack.pop();
    for (const n of orthNeighbors(cur.x, cur.y)) {
      if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) continue;
      const nk = gridKey(n.x, n.y);
      if (!occupied.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(n); }
    }
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const k = gridKey(x, y);
      if (!occupied.has(k) && !seen.has(k)) occupied.add(k);
    }
  }
}
function boundaryCells(occupied, cols, rows) {
  const cells = [];
  for (const key of occupied) {
    const [xs, ys] = key.split(',');
    const x = +xs, y = +ys;
    let exposed = 0;
    for (const n of orthNeighbors(x, y)) {
      if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows || !occupied.has(gridKey(n.x, n.y))) exposed += 1;
    }
    if (exposed > 0) cells.push({ x, y, exposed });
  }
  return cells;
}
function createBlobShape(rand, difficulty) {
  // Grade interna mais fina que o acetato. Ela serve apenas para criar a massa;
  // o contorno final será simplificado e suavizado depois.
  const cols = difficulty === 'hard' ? 22 : 18;
  const rows = difficulty === 'hard' ? 30 : 24;
  const target = difficulty === 'hard' ? 145 + Math.floor(rand() * 32) : 92 + Math.floor(rand() * 24);
  const occupied = new Set();
  const sx = Math.floor(cols / 2) + Math.floor((rand() - 0.5) * 3);
  const sy = Math.floor(rows / 2) + Math.floor((rand() - 0.5) * 3);
  occupied.add(gridKey(sx, sy));

  // Crescimento deliberadamente NÃO compacto: bordas com apenas um ou dois
  // vizinhos recebem mais peso, criando braços/lóbulos largos em vez de uma bola.
  while (occupied.size < target) {
    const frontier = new Map();
    for (const key of occupied) {
      const [xs, ys] = key.split(',');
      const x = +xs, y = +ys;
      for (const n of orthNeighbors(x, y)) {
        if (n.x < 2 || n.y < 2 || n.x >= cols - 2 || n.y >= rows - 2) continue;
        const nk = gridKey(n.x, n.y);
        if (occupied.has(nk)) continue;
        frontier.set(nk, (frontier.get(nk) || 0) + 1);
      }
    }
    if (!frontier.size) break;
    const candidates = Array.from(frontier.entries()).map(([key, touch]) => {
      const [xs, ys] = key.split(',');
      const x = +xs, y = +ys;
      const nx = (x + 0.5) / cols - 0.5;
      const ny = (y + 0.5) / rows - 0.5;
      const distance = Math.hypot(nx / 0.48, ny / 0.56);
      // touch 1/2 favorece extensão; touch 3/4 ainda aparece para engrossar partes.
      const branchBias = touch === 1 ? 3.2 : touch === 2 ? 2.0 : touch === 3 ? 0.8 : -0.6;
      const edgeBonus = distance * (difficulty === 'hard' ? 0.85 : 0.70);
      const noise = rand() * 3.0;
      return { key, score: branchBias + edgeBonus + noise };
    }).sort((a,b)=>b.score-a.score);
    const pool = Math.min(candidates.length, difficulty === 'hard' ? 12 : 9);
    const pick = candidates[Math.floor(Math.pow(rand(), 1.7) * pool)] || candidates[0];
    occupied.add(pick.key);
  }

  // Engrossa uma parte das pontas para evitar braços de um único quadradinho.
  const firstPass = Array.from(occupied);
  for (const key of firstPass) {
    if (rand() > (difficulty === 'hard' ? 0.30 : 0.34)) continue;
    const [xs, ys] = key.split(',');
    const x = +xs, y = +ys;
    const opts = orthNeighbors(x,y).filter(n => n.x >= 2 && n.y >= 2 && n.x < cols-2 && n.y < rows-2 && !occupied.has(gridKey(n.x,n.y)));
    if (opts.length) {
      const n = opts[Math.floor(rand()*opts.length)];
      occupied.add(gridKey(n.x,n.y));
    }
  }

  // Esculpe baías no perímetro. A célula só é removida se a massa continuar una.
  const carveAttempts = difficulty === 'hard' ? 16 : 11;
  for (let attempt = 0; attempt < carveAttempts; attempt += 1) {
    const boundary = boundaryCells(occupied, cols, rows).filter(c => c.exposed >= 1 && c.x > 2 && c.y > 2 && c.x < cols-3 && c.y < rows-3);
    if (!boundary.length) break;
    const cell = boundary[Math.floor(rand() * boundary.length)];
    const k = gridKey(cell.x, cell.y);
    occupied.delete(k);
    const remaining = occupied.values().next().value;
    if (!remaining || connectedCount(occupied, cols, rows, remaining) !== occupied.size) occupied.add(k);
  }

  fillBlobHoles(occupied, cols, rows);
  const cells = Array.from(occupied).map(k => {
    const [xs, ys] = k.split(',');
    return { x:+xs, y:+ys };
  });
  return { occupied, cols, rows, style:'organic-grid-blob', cells };
}
function blobStats(blob) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const { x, y } of blob.cells) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const width = maxx - minx + 1;
  const height = maxy - miny + 1;
  const area = blob.cells.length;
  const fill = area / (width * height);
  let exposed = 0;
  for (const { x, y } of blob.cells) {
    for (const n of orthNeighbors(x, y)) {
      if (n.x < 0 || n.y < 0 || n.x >= blob.cols || n.y >= blob.rows || !blob.occupied.has(gridKey(n.x, n.y))) exposed += 1;
    }
  }
  return { width, height, fill, exposed };
}
function contourFromBlob(blob) {
  const edges = [];
  const has = (x, y) => x >= 0 && y >= 0 && x < blob.cols && y < blob.rows && blob.occupied.has(gridKey(x, y));
  for (const { x, y } of blob.cells) {
    if (!has(x, y - 1)) edges.push([{ x, y }, { x: x + 1, y }]);
    if (!has(x + 1, y)) edges.push([{ x: x + 1, y }, { x: x + 1, y: y + 1 }]);
    if (!has(x, y + 1)) edges.push([{ x: x + 1, y: y + 1 }, { x, y: y + 1 }]);
    if (!has(x - 1, y)) edges.push([{ x, y: y + 1 }, { x, y }]);
  }
  const map = new Map();
  const pkey = p => `${p.x},${p.y}`;
  for (const [a, b] of edges) map.set(pkey(a), b);
  let start = edges[0][0];
  for (const [a] of edges) {
    if (a.y < start.y || (a.y === start.y && a.x < start.x)) start = a;
  }
  const out = [];
  let cur = start;
  const visited = new Set();
  while (cur) {
    const k = pkey(cur);
    if (visited.has(k) && k === pkey(start)) break;
    visited.add(k);
    out.push(cur);
    cur = map.get(k);
    if (cur && pkey(cur) === pkey(start)) {
      out.push(cur);
      break;
    }
  }
  return out;
}
function removeCollinearClosed(points) {
  const src = points.slice();
  if (src.length > 1 && Math.hypot(src[0].x-src[src.length-1].x, src[0].y-src[src.length-1].y) < 1e-9) src.pop();
  const out=[];
  for (let i=0;i<src.length;i+=1) {
    const a=src[(i-1+src.length)%src.length], b=src[i], c=src[(i+1)%src.length];
    const cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if (Math.abs(cross)>1e-9) out.push(b);
  }
  return out;
}
function pointLineDistance(p,a,b) {
  const dx=b.x-a.x, dy=b.y-a.y;
  const den=dx*dx+dy*dy;
  if (den<1e-12) return Math.hypot(p.x-a.x,p.y-a.y);
  const t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/den,0,1);
  return Math.hypot(p.x-(a.x+dx*t),p.y-(a.y+dy*t));
}
function rdpOpen(points, epsilon) {
  if (points.length<=2) return points.slice();
  let maxD=0,index=-1;
  const a=points[0],b=points[points.length-1];
  for (let i=1;i<points.length-1;i+=1) {
    const d=pointLineDistance(points[i],a,b);
    if (d>maxD) {maxD=d;index=i;}
  }
  if (maxD<=epsilon || index<0) return [a,b];
  const left=rdpOpen(points.slice(0,index+1),epsilon);
  const right=rdpOpen(points.slice(index),epsilon);
  return left.slice(0,-1).concat(right);
}
function simplifyClosedContour(points, epsilon) {
  const base=removeCollinearClosed(points);
  if (base.length<6) return base;
  // abre o anel em um vértice distante do centro para o RDP não colapsar tudo.
  let start=0,best=-1;
  for (let i=0;i<base.length;i+=1) {
    const d=Math.hypot(base[i].x-0.5,base[i].y-0.5);
    if (d>best) {best=d;start=i;}
  }
  const ordered=base.slice(start).concat(base.slice(0,start));
  ordered.push({...ordered[0]});
  const simplified=rdpOpen(ordered,epsilon);
  simplified.pop();
  return simplified;
}
function internalAngleDeg(a,b,c) {
  const v1x=a.x-b.x, v1y=a.y-b.y;
  const v2x=c.x-b.x, v2y=c.y-b.y;
  const l1=Math.hypot(v1x,v1y), l2=Math.hypot(v2x,v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 180;
  const dot=(v1x*v2x+v1y*v2y)/(l1*l2);
  return Math.acos(clamp(dot,-1,1))*180/Math.PI;
}
function softenSharpVertices(poly, difficulty) {
  let cur=poly.slice();
  const passes = 2;
  const minAngle = difficulty === 'hard' ? 78 : 74;
  for (let pass=0; pass<passes; pass+=1) {
    const next=[];
    for (let i=0;i<cur.length;i+=1) {
      const a=cur[(i-1+cur.length)%cur.length];
      const b=cur[i];
      const c=cur[(i+1)%cur.length];
      const angle=internalAngleDeg(a,b,c);
      if (angle < minAngle) {
        const midpoint={x:(a.x+c.x)/2, y:(a.y+c.y)/2};
        const blend = angle < 48 ? 0.72 : angle < 58 ? 0.62 : 0.52;
        next.push({
          x: b.x*(1-blend) + midpoint.x*blend,
          y: b.y*(1-blend) + midpoint.y*blend
        });
      } else {
        next.push(b);
      }
    }
    cur=next;
  }
  return cur;
}
function chaikinClosed(points, passes=1, ratio=0.22) {
  let cur=points.slice();
  for (let pass=0;pass<passes;pass+=1) {
    const next=[];
    for (let i=0;i<cur.length;i+=1) {
      const a=cur[i],b=cur[(i+1)%cur.length];
      next.push({x:a.x*(1-ratio)+b.x*ratio,y:a.y*(1-ratio)+b.y*ratio});
      next.push({x:a.x*ratio+b.x*(1-ratio),y:a.y*ratio+b.y*(1-ratio)});
    }
    cur=next;
  }
  return cur;
}
function polygonSignedArea(points) {
  let a=0;
  for (let i=0;i<points.length;i+=1) {
    const p=points[i],q=points[(i+1)%points.length];
    a+=p.x*q.y-q.x*p.y;
  }
  return a/2;
}
function convexHull(points) {
  const pts=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
  if (pts.length<=3) return pts;
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower=[];
  for (const p of pts) {while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p);}
  const upper=[];
  for (let i=pts.length-1;i>=0;i-=1){const p=pts[i];while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}
  lower.pop();upper.pop();return lower.concat(upper);
}
function concaveTurnCount(points) {
  const orientation=Math.sign(polygonSignedArea(points))||1;
  let count=0;
  for (let i=0;i<points.length;i+=1) {
    const a=points[(i-1+points.length)%points.length],b=points[i],c=points[(i+1)%points.length];
    const turn=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if (turn*orientation< -1e-5) count+=1;
  }
  return count;
}
function buildMapTrackCandidate(rand, difficulty) {
  const blob=createBlobShape(rand,difficulty);
  const stats=blobStats(blob);
  const rawContour=contourFromBlob(blob);
  if (!rawContour || rawContour.length<8) return {points:[],validShape:false,usableShape:false,style:blob.style,metrics:null};

  const normalized=rawContour.map(p=>({x:p.x/blob.cols,y:p.y/blob.rows}));
  const simplified=removeCollinearClosed(normalized);
  if (simplified.length<7) return {points:[],validShape:false,usableShape:false,style:blob.style,metrics:null};

  // Mantém apenas as grandes entradas/saliências da massa e remove os micro-recortes.
  let major=simplifyClosedContour(simplified,difficulty==='hard'?0.032:0.036);
  if (major.length < 8) major = simplified;
  major = softenSharpVertices(major, difficulty);

  // Reconstrói o contorno como mistura de retas e curvas maiores, mais próximo das referências.
  let points=roundMapPolygon(major,rand,difficulty);
  // A antiga deformação senoidal adicionava micro-mudanças em trechos que
  // deveriam ser visualmente limpos. A rotação/inclinação já dá variedade.
  points=applyDiagonalTransform(points,rand,difficulty);
  if (points.length) points[points.length-1]={...points[0]};

  const ring=points.slice(0,-1);
  const b=trackBounds(points);
  const spanW=b.maxx-b.minx,spanH=b.maxy-b.miny;
  const aspect=spanW/Math.max(1e-6,spanH);
  const selfIntersects=hasSelfIntersection(points);
  const hull=convexHull(ring);
  const area=Math.abs(polygonSignedArea(ring));
  const hullArea=Math.max(1e-8,Math.abs(polygonSignedArea(hull)));
  const solidity=area/hullArea;
  const concavities=concaveTurnCount(major);

  const usableShape=!selfIntersects&&points.length>=12&&spanW>0.40&&spanH>0.48&&aspect>0.28&&aspect<1.95;
  const validShape=usableShape
    && spanW>0.48&&spanH>0.56
    && stats.fill>0.20&&stats.fill<0.80
    && solidity>(difficulty==='hard'?0.44:0.48)
    && solidity<(difficulty==='hard'?0.93:0.93)
    && concavities>=(difficulty==='hard'?2:2)
    && concavities<=(difficulty==='hard'?9:7)
    && aspect>0.34&&aspect<1.70;

  return {points,validShape,usableShape,style:blob.style,metrics:{spanW,spanH,aspect,fill:stats.fill,exposed:stats.exposed,selfIntersects,solidity,concavities}};
}
function finalizeGeneratedTrack(seed, difficulty, candidate, cellCount, minCells, maxCells) {
  const normalized = normalizeTrackStart(candidate.points);
  return {
    seed,
    difficulty,
    start: normalized.points[0],
    startLabel: startCellLabel(normalized.points[0], difficulty),
    clockwise: true,
    points: normalized.points.map(p => ({ x:+p.x.toFixed(5), y:+p.y.toFixed(5) })),
    checkpoints: [0.25,0.50,0.75,1].map(f =>
      f === 1 ? { ...normalized.points[0] } : pointAtFraction(normalized.points, f)
    ).map(p => ({ x:+p.x.toFixed(5), y:+p.y.toFixed(5) })),
    segments: [],
    targetCellCount: cellCount,
    targetCellRange: { min:minCells, max:maxCells },
    style: candidate.style
  };
}
function emergencyTrackCandidate(difficulty) {
  // Última proteção contra falhas aleatórias extremas. É uma silhueta simples,
  // irregular e fechada; ela existe para o servidor NUNCA cair ao criar partida.
  const base = difficulty === 'hard'
    ? [
        [0.50,0.07],[0.67,0.10],[0.78,0.18],[0.75,0.30],[0.88,0.38],
        [0.80,0.49],[0.86,0.61],[0.72,0.67],[0.75,0.82],[0.59,0.91],
        [0.43,0.86],[0.30,0.93],[0.20,0.81],[0.24,0.67],[0.11,0.58],
        [0.20,0.46],[0.13,0.34],[0.27,0.25],[0.31,0.13]
      ]
    : [
        [0.50,0.08],[0.68,0.12],[0.80,0.23],[0.75,0.35],[0.87,0.44],
        [0.77,0.56],[0.82,0.70],[0.67,0.78],[0.61,0.91],[0.45,0.85],
        [0.31,0.92],[0.20,0.79],[0.24,0.64],[0.12,0.53],[0.21,0.40],
        [0.16,0.27],[0.31,0.20],[0.36,0.10]
      ];
  const poly = base.map(([x,y]) => ({x,y}));
  const rand = mulberry32(difficulty === 'hard' ? 0x51A77E : 0x37A11E);
  let points = roundMapPolygon(poly, rand, difficulty);
  points[points.length - 1] = { ...points[0] };
  return { points, validShape:true, usableShape:true, style:'emergency-map' };
}
function generateTrack(difficulty) {
  const minCells = difficulty === 'hard' ? 80 : 38;
  const maxCells = difficulty === 'hard' ? 100 : 50;
  const centerTarget = difficulty === 'hard' ? 90 : 44;
  const maxAttempts = difficulty === 'hard' ? 18 : 14;
  const fastMargin = difficulty === 'hard' ? 15 : 7;
  let bestInRange = null;
  let bestFallback = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const rand = mulberry32(seed);
    const candidate = buildMapTrackCandidate(rand, difficulty);
    if (!candidate.usableShape) continue;

    const fastCount = fastTrackCellCount(candidate.points, difficulty);
    if (fastCount < minCells - fastMargin || fastCount > maxCells + 2) continue;

    const cellCount = trackCellCount(candidate.points, difficulty);
    const distanceFromRange = cellCount < minCells ? minCells - cellCount : cellCount > maxCells ? cellCount - maxCells : 0;
    const centerDistance = Math.abs(cellCount - centerTarget);
    const m = candidate.metrics || {};

    // Escolhe entre poucos candidatos bons, em vez de varrer centenas deles.
    // Isso preserva variedade e evita bloquear o Socket.IO durante vários segundos.
    let visualPenalty = 0;
    if (m.solidity != null) {
      if (m.solidity > 0.91) visualPenalty += (m.solidity - 0.91) * 120; // oval/compacta demais
      if (m.solidity < 0.48) visualPenalty += (0.48 - m.solidity) * 80;  // recortada demais
    }
    if (m.aspect != null && (m.aspect < 0.36 || m.aspect > 1.65)) visualPenalty += 8;
    const score = distanceFromRange * 100 + centerDistance * 0.35 + visualPenalty;
    const row = { seed, candidate, cellCount, score };

    if (!bestFallback || score < bestFallback.score) bestFallback = row;
    if (distanceFromRange === 0 && (!bestInRange || score < bestInRange.score)) bestInRange = row;
  }

  const chosen = bestInRange || bestFallback;
  if (chosen) return finalizeGeneratedTrack(chosen.seed, difficulty, chosen.candidate, chosen.cellCount, minCells, maxCells);

  const emergency = emergencyTrackCandidate(difficulty);
  const emergencyCells = trackCellCount(emergency.points, difficulty);
  return finalizeGeneratedTrack(0, difficulty, emergency, emergencyCells, minCells, maxCells);
}
function findTopAxisCrossing(points) {
  let best = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.x - 0.5) < 1e-8 && Math.abs(b.x - 0.5) < 1e-8) {
      const y = Math.min(a.y, b.y);
      if (y < 0.5 && (!best || y < best.point.y)) best = { index: i, point: { x: 0.5, y } };
      continue;
    }
    const cross = axisIntersection(a, b, 'x', 0.5);
    if (cross && cross.y < 0.5 && (!best || cross.y < best.point.y)) best = { index: i, point: cross };
  }
  return best;
}
function normalizeTrackStart(points) {
  const closed = points.slice();
  if (dist(closed[0], closed[closed.length - 1]) > 1e-8) closed.push({ ...closed[0] });
  const crossing = findTopAxisCrossing(closed);
  if (!crossing) return { points: closed };

  // Insere a interseção se ela não coincidir com um vértice e roda o circuito
  // para que a largada Online permaneça na linha vertical superior.
  const work = closed.slice(0, -1);
  let startIndex = crossing.index;
  const prev = work[(crossing.index - 1 + work.length) % work.length];
  const next = work[crossing.index % work.length];
  if (dist(prev, crossing.point) < 1e-6) startIndex = crossing.index - 1;
  else if (dist(next, crossing.point) < 1e-6) startIndex = crossing.index % work.length;
  else {
    work.splice(crossing.index, 0, crossing.point);
    startIndex = crossing.index;
  }
  const rotated = work.slice(startIndex).concat(work.slice(0, startIndex));
  rotated.push({ ...rotated[0] });
  return { points: rotated };
}

function firstFreeColor(room) {
  const used = new Set(room.playerOrder.map(id => room.players[id]?.color).filter(Boolean));
  return TEAM_COLORS.find(color => !used.has(color)) || null;
}
function createRoomData(name, difficulty, socketId, mode='online') {
  const id = makeId(), token = makeToken(), code = makeCode();
  const smartphone = mode === 'smartphone';
  const player = {
    id, token, name,
    color: smartphone ? TEAM_COLORS[0] : null,
    role: smartphone ? 'copilot' : null,
    connected: true, socketId, ready: false
  };
  const room = {
    code, mode, difficulty, hostId: id, status: 'lobby', createdAt: Date.now(), updatedAt: Date.now(),
    players: { [id]: player }, playerOrder: [id], track: null, chips: [null,null,null,null],
    startedAt: null, countdownEndsAt: null, lastTeamDeadline:null, lastTeamColor:null, results: null, teamStates: {}, smartphoneStarts: {}, advancedSpecials: null, restarting:false, finishCounter:0
  };
  rooms.set(code, room);
  return { room, player };
}
function teamSlots(room) {
  const result = {};
  for (const color of TEAM_COLORS) result[color] = { pilot: null, copilot: null };
  for (const id of room.playerOrder) {
    const p = room.players[id];
    if (p && p.color && p.role && result[p.color]) result[p.color][p.role] = p;
  }
  return result;
}
function completeTeams(room) {
  const slots = teamSlots(room);
  if (room.mode === 'smartphone') return TEAM_COLORS.filter(c => slots[c].copilot);
  return TEAM_COLORS.filter(c => slots[c].pilot && slots[c].copilot);
}
function allPlayersInCompleteTeams(room) {
  if (room.mode === 'smartphone') return room.playerOrder.length >= 1 && room.playerOrder.length <= 4;
  const complete = new Set(completeTeams(room));
  return room.playerOrder.length > 0 && room.playerOrder.every(id => complete.has(room.players[id]?.color));
}
function axisIntersection(a, b, axis, value) {
  const av = axis === 'x' ? a.x : a.y;
  const bv = axis === 'x' ? b.x : b.y;
  if ((av < value && bv < value) || (av > value && bv > value) || Math.abs(bv-av) < 1e-9) return null;
  const t = (value-av)/(bv-av);
  if (t < 0 || t > 1) return null;
  return { x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t };
}
function smartphonePrintedPoints(side) {
  const points = [];
  if (side === 'top') {
    // Folha A5 v5: N01 começa 17 mm abaixo do topo; passos de 8 mm.
    for (let i = 0; i < 12; i += 1) points.push({ label:`N${String(i+1).padStart(2,'0')}`, x:0.5, y:(17 + 8*i) / 210 });
  } else if (side === 'bottom') {
    // S01 começa 111 mm abaixo do topo; passos de 8 mm.
    for (let i = 0; i < 11; i += 1) points.push({ label:`S${String(i+1).padStart(2,'0')}`, x:0.5, y:(111 + 8*i) / 210 });
  } else if (side === 'left') {
    // W01..W08 seguem exatamente as posições impressas na folha A5 v5.
    const step = 57 / 7;
    for (let i = 0; i < 8; i += 1) points.push({ label:`W${String(i+1).padStart(2,'0')}`, x:(17 + step*i) / 148, y:0.5 });
  } else if (side === 'right') {
    const step = 57 / 7;
    for (let i = 0; i < 8; i += 1) points.push({ label:`E${String(i+1).padStart(2,'0')}`, x:(80 + step*i) / 148, y:0.5 });
  }
  return points;
}
function sideCoordinate(point, side) {
  return side === 'top' || side === 'bottom' ? point.y : point.x;
}
function sideHalfMatches(point, side) {
  if (side === 'top') return point.y < 0.5 - 1e-5;
  if (side === 'bottom') return point.y > 0.5 + 1e-5;
  if (side === 'left') return point.x < 0.5 - 1e-5;
  return point.x > 0.5 + 1e-5;
}
function sideOuterScore(point, side) {
  if (side === 'top') return point.y;
  if (side === 'bottom') return 1 - point.y;
  if (side === 'left') return point.x;
  return 1 - point.x;
}
function nearestPrintedPoint(point, side) {
  const printed = smartphonePrintedPoints(side);
  let best = printed[0];
  let bestDistance = Infinity;
  for (const candidate of printed) {
    const d = Math.abs(sideCoordinate(candidate, side) - sideCoordinate(point, side));
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  return { point:{ x:best.x, y:best.y }, label:best.label, distance:bestDistance };
}
function findBestSideCrossing(points, side) {
  const axis = side === 'top' || side === 'bottom' ? 'x' : 'y';
  const printed = smartphonePrintedPoints(side);
  const candidates = [];

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    const av = axis === 'x' ? a.x : a.y;
    const bv = axis === 'x' ? b.x : b.y;

    if (Math.abs(av - 0.5) < 1e-7 && Math.abs(bv - 0.5) < 1e-7) {
      // Quando a pista percorre um trecho do próprio eixo, prefira um ponto
      // impresso que já esteja exatamente dentro desse trecho: zero desvio.
      const lo = Math.min(sideCoordinate(a, side), sideCoordinate(b, side)) - 1e-7;
      const hi = Math.max(sideCoordinate(a, side), sideCoordinate(b, side)) + 1e-7;
      for (const mark of printed) {
        const coord = sideCoordinate(mark, side);
        if (coord >= lo && coord <= hi && sideHalfMatches(mark, side)) {
          candidates.push({ index:i, crossing:{x:mark.x,y:mark.y}, desired:mark, snapDistance:0 });
        }
      }
      continue;
    }

    const crossing = axisIntersection(a, b, axis, 0.5);
    if (!crossing || !sideHalfMatches(crossing, side)) continue;
    const nearest = nearestPrintedPoint(crossing, side);
    candidates.push({
      index:i,
      crossing,
      desired:{ ...nearest.point, label:nearest.label },
      snapDistance:nearest.distance
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const outer = sideOuterScore(a.crossing, side) - sideOuterScore(b.crossing, side);
    if (Math.abs(outer) > 1e-6) return outer;
    return a.snapDistance - b.snapDistance;
  });
  return candidates[0];
}
function snapTrackAtSide(points, side) {
  const hit = findBestSideCrossing(points, side);
  if (!hit) return { points, start:null };
  const work = points.slice();
  const desired = { x:hit.desired.x, y:hit.desired.y };
  const prev = work[hit.index - 1];
  const next = work[hit.index];

  if (dist(prev, desired) < 1e-6) {
    return { points:work, start:{ side, point:{...prev}, label:hit.desired.label } };
  }
  if (dist(next, desired) < 1e-6) {
    return { points:work, start:{ side, point:{...next}, label:hit.desired.label } };
  }

  // O deslocamento máximo é metade da distância entre dois pontos impressos;
  // inserir o ponto mantém a costa contínua e faz a linha passar EXATAMENTE
  // pela coordenada que o Copiloto lerá para o Piloto.
  work.splice(hit.index, 0, desired);
  return { points:work, start:{ side, point:{...desired}, label:hit.desired.label } };
}
function prepareSmartphoneTrack(room) {
  let points = room.track.points.map(p => ({ x:p.x, y:p.y }));
  if (dist(points[0], points[points.length - 1]) > 1e-8) points.push({ ...points[0] });

  const starts = {};
  for (const side of ['top','right','bottom','left']) {
    const snapped = snapTrackAtSide(points, side);
    points = snapped.points;
    if (snapped.start) starts[side] = snapped.start;
  }

  // Proteção: uma silhueta válida deve cruzar os quatro eixos. Se algum ponto
  // não foi encontrado, usa o ponto impresso mais externo daquela direção.
  for (const side of ['top','right','bottom','left']) {
    if (starts[side]) continue;
    const marks = smartphonePrintedPoints(side);
    const fallback = side === 'top' || side === 'left' ? marks[0] : marks[marks.length - 1];
    starts[side] = { side, point:{x:fallback.x,y:fallback.y}, label:fallback.label };
  }

  // Refecha matematicamente e atualiza a pista real usada pela pontuação.
  if (dist(points[0], points[points.length - 1]) > 1e-8) points.push({ ...points[0] });
  else points[points.length - 1] = { ...points[0] };
  room.track.points = points.map(p => ({ x:+p.x.toFixed(5), y:+p.y.toFixed(5) }));
  room.track.targetCellCount = trackCellCount(room.track.points, room.difficulty);
  room.track.checkpoints = [0.25,0.50,0.75,1].map(f =>
    f === 1 ? { ...room.track.points[0] } : pointAtFraction(room.track.points, f)
  ).map(p => ({ x:+p.x.toFixed(5), y:+p.y.toFixed(5) }));
  return starts;
}
function assignSmartphoneStarts(room) {
  const available = prepareSmartphoneTrack(room);
  const count = room.playerOrder.length;
  let sides;
  if (count === 1) sides = [['top'],['right'],['bottom'],['left']][crypto.randomInt(0,4)];
  else if (count === 2) sides = crypto.randomInt(0,2) === 0 ? ['top','bottom'] : ['left','right'];
  else if (count === 3) {
    const all = ['top','right','bottom','left'];
    all.splice(crypto.randomInt(0,4), 1);
    sides = all;
  } else sides = ['top','right','bottom','left'];

  room.smartphoneStarts = {};
  room.playerOrder.forEach((id, index) => {
    const player = room.players[id];
    const side = sides[index];
    const start = available[side];
    room.smartphoneStarts[player.color] = {
      side,
      point:{ x:+start.point.x.toFixed(5), y:+start.point.y.toFixed(5) },
      label:start.label
    };
  });

  // A referência geral da sala fica na largada superior; cada Copiloto recebe
  // sua própria largada pelo roomClientShape.
  if (available.top) {
    room.track.start = { x:+available.top.point.x.toFixed(5), y:+available.top.point.y.toFixed(5) };
    room.track.startLabel = available.top.label;
  }
}

function generateTrackForRoom(room) {
  if (room.mode !== 'smartphone') {
    room.track = generateTrack(room.difficulty);
    room.smartphoneStarts = {};
    return;
  }

  const minCells = room.difficulty === 'hard' ? 80 : 38;
  const maxCells = room.difficulty === 'hard' ? 100 : 50;
  let best = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    room.track = generateTrack(room.difficulty);
    assignSmartphoneStarts(room);
    const count = room.track.targetCellCount;
    const distance = count < minCells ? minCells - count : count > maxCells ? count - maxCells : 0;
    if (!best || distance < best.distance) {
      best = {
        distance,
        track: JSON.parse(JSON.stringify(room.track)),
        starts: JSON.parse(JSON.stringify(room.smartphoneStarts))
      };
    }
    if (distance === 0) return;
  }
  room.track = best.track;
  room.smartphoneStarts = best.starts;
}

function initializeTeamStates(room) {
  room.teamStates = {};
  room.finishCounter = 0;
  const slots = teamSlots(room);
  for (const color of completeTeams(room)) {
    const smartphone = room.mode === 'smartphone';
    room.teamStates[color] = {
      color,
      pilotId: smartphone ? null : slots[color].pilot.id,
      copilotId: slots[color].copilot.id,
      ops: [], bonus: 0, finishPlace: null, finishOrder: null, finishedAt: null, elapsedMs: null, timedOut:false,
      pilotConfirmed: false, copilotConfirmed: false,
      routeScore: null, targetCellCount: null, advancedBonus: 0, advancedPenalty: 0, advancedNet: 0, total: null,
      scanSubmitted:false, scanCells:null, scanImage:null,
      smartphoneStart: smartphone ? room.smartphoneStarts[color] : null
    };
  }
}
function roomClientShape(room, viewer) {
  const teams = teamSlots(room);
  const smartphone = room.mode === 'smartphone';
  const canSeeTrack = room.status === 'finished' || (viewer && ((smartphone && room.status !== 'lobby') || (viewer.role === 'copilot' && room.status !== 'lobby')));
  const ownColor = viewer?.color || null;
  const canSeeAdvanced = room.difficulty === 'hard' && viewer?.role === 'copilot';
  const drawings = {};
  if (room.status === 'finished') {
    for (const [color, t] of Object.entries(room.teamStates)) drawings[color] = t.ops;
  } else if (ownColor && room.teamStates[ownColor]) {
    drawings[ownColor] = room.teamStates[ownColor].ops;
  }
  let track=null;
  if (room.track) {
    if (canSeeTrack) {
      track={...room.track};
      if (smartphone && ownColor && room.smartphoneStarts[ownColor]) {
        const st=room.smartphoneStarts[ownColor];
        track={...track,start:st.point,startLabel:st.label,startSide:st.side};
      }
      if (canSeeAdvanced && room.advancedSpecials) track.advancedSpecials = room.advancedSpecials;
      else if (track.advancedSpecials) delete track.advancedSpecials;
    } else track={ start:room.track.start, startLabel:room.track.startLabel, clockwise:true };
  }
  return {
    code: room.code,
    mode: room.mode || 'online',
    difficulty: room.difficulty,
    hostId: room.hostId,
    status: room.status,
    restarting: !!room.restarting,
    startedAt: room.startedAt,
    countdownEndsAt: room.countdownEndsAt,
    chips: room.chips,
    players: room.playerOrder.map(id => {
      const p = room.players[id];
      return { id:p.id, name:p.name, color:p.color, role:p.role, connected:p.connected, ready:p.ready };
    }),
    teams: Object.fromEntries(TEAM_COLORS.map(c => [c, {
      pilot: teams[c].pilot ? { id:teams[c].pilot.id, name:teams[c].pilot.name, connected:teams[c].pilot.connected, ready:teams[c].pilot.ready } : null,
      copilot: teams[c].copilot ? { id:teams[c].copilot.id, name:teams[c].copilot.name, connected:teams[c].copilot.connected, ready:teams[c].copilot.ready } : null,
      bonus: room.teamStates[c]?.bonus || 0,
      finishPlace: room.teamStates[c]?.finishPlace || null,
      pilotConfirmed: !!room.teamStates[c]?.pilotConfirmed,
      copilotConfirmed: !!room.teamStates[c]?.copilotConfirmed,
      finishedAt: room.teamStates[c]?.finishedAt || null,
      elapsedMs: room.teamStates[c]?.elapsedMs || null,
      timedOut: !!room.teamStates[c]?.timedOut,
      scanSubmitted: !!room.teamStates[c]?.scanSubmitted,
      smartphoneStart: room.teamStates[c]?.smartphoneStart || room.smartphoneStarts[c] || null
    }])),
    lastTeamCountdown: (room.status==='racing' && room.lastTeamDeadline && room.lastTeamColor===ownColor) ? { endsAt:room.lastTeamDeadline, color:room.lastTeamColor } : null,
    track,
    drawings,
    results: room.status === 'finished' ? room.results : null,
    canStart: room.status === 'lobby' && (smartphone ? room.playerOrder.length >= 1 && room.playerOrder.length <= 4 : completeTeams(room).length >= 1 && allPlayersInCompleteTeams(room))
  };
}
function emitRoom(room) {
  room.updatedAt = Date.now();
  for (const id of room.playerOrder) {
    const p = room.players[id];
    if (p?.connected && p.socketId) io.to(p.socketId).emit('roomState', roomClientShape(room, p));
  }
}
function cancelEmptyTimer(code) {
  if (emptyTimers.has(code)) clearTimeout(emptyTimers.get(code));
  emptyTimers.delete(code);
}
function scheduleEmptyRoom(room) {
  cancelEmptyTimer(room.code);
  const anyConnected = room.playerOrder.some(id => room.players[id]?.connected);
  if (anyConnected) return;
  emptyTimers.set(room.code, setTimeout(() => {
    rooms.delete(room.code); emptyTimers.delete(room.code);
    if (countdownTimers.has(room.code)) clearTimeout(countdownTimers.get(room.code));
    countdownTimers.delete(room.code);
    if (finalTeamTimers.has(room.code)) clearTimeout(finalTeamTimers.get(room.code));
    finalTeamTimers.delete(room.code);
  }, EMPTY_ROOM_MS));
}
function playerBySocket(socket) {
  const meta = socket.data.session;
  if (!meta) return {};
  const room = rooms.get(meta.code);
  const player = room?.players[meta.playerId];
  return { room, player };
}
function attachSocket(socket, room, player) {
  player.connected = true; player.socketId = socket.id;
  socket.data.session = { code: room.code, playerId: player.id };
  socket.join(room.code);
  cancelEmptyTimer(room.code);
}
function ackError(ack, message) { if (typeof ack === 'function') ack({ ok:false, error:message }); }
function ackOk(ack, extra={}) { if (typeof ack === 'function') ack({ ok:true, ...extra }); }

function simpleRate(socket, key, limit, windowMs) {
  const now = Date.now();
  socket.data.rates ||= {};
  const bucket = socket.data.rates[key] || { start: now, count: 0 };
  if (now - bucket.start > windowMs) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1; socket.data.rates[key] = bucket;
  return bucket.count <= limit;
}
function validPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}
function cleanDrawOp(raw) {
  if (!raw || !['draw','erase'].includes(raw.kind) || !validPoint(raw.from) || !validPoint(raw.to)) return null;
  const width = raw.kind === 'erase' ? 0.03 : 0.006;
  return { kind: raw.kind, from:{x:+raw.from.x.toFixed(5),y:+raw.from.y.toFixed(5)}, to:{x:+raw.to.x.toFixed(5),y:+raw.to.y.toFixed(5)}, width:+width.toFixed(5) };
}
function drawCircle(mask, W, H, cx, cy, r, value) {
  const x0=Math.max(0,Math.floor(cx-r)), x1=Math.min(W-1,Math.ceil(cx+r));
  const y0=Math.max(0,Math.floor(cy-r)), y1=Math.min(H-1,Math.ceil(cy+r));
  const rr=r*r;
  for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) if ((x-cx)*(x-cx)+(y-cy)*(y-cy)<=rr) mask[y*W+x]=value;
}
function rasterLine(mask, W, H, a, b, radius, value) {
  const ax=a.x*(W-1), ay=a.y*(H-1), bx=b.x*(W-1), by=b.y*(H-1);
  const steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)*1.25));
  for (let i=0;i<=steps;i++) { const t=i/steps; drawCircle(mask,W,H,ax+(bx-ax)*t,ay+(by-ay)*t,radius,value); }
}
function acetateGrid(difficulty) {
  // Fácil: 24 células por quadrante = 4x6 em cada quadrante = 8x12 na folha.
  // Difícil: 96 células por quadrante = 8x12 em cada quadrante = 16x24 na folha.
  return difficulty === 'hard' ? { cols:16, rows:24 } : { cols:8, rows:12 };
}
function cellsFromMask(mask, W, H, cols, rows) {
  const occupied = new Uint8Array(cols * rows);
  for (let y=0; y<H; y++) {
    const row = Math.min(rows - 1, Math.floor(y * rows / H));
    for (let x=0; x<W; x++) {
      if (!mask[y*W+x]) continue;
      const col = Math.min(cols - 1, Math.floor(x * cols / W));
      occupied[row*cols+col] = 1;
    }
  }
  const indexes=[];
  for (let i=0;i<occupied.length;i++) if (occupied[i]) indexes.push(i);
  return { occupied, indexes };
}
function targetAcetate(room) {
  const W=592,H=840;
  const targetMask=new Uint8Array(W*H);
  const pts=room.track.points;
  const trackRadius=0.0045*W;
  for(let i=1;i<pts.length;i++) rasterLine(targetMask,W,H,pts[i-1],pts[i],trackRadius,1);
  const {cols,rows}=acetateGrid(room.difficulty);
  return {cols,rows,...cellsFromMask(targetMask,W,H,cols,rows)};
}

function orderedTrackCells(room) {
  const { cols, rows } = acetateGrid(room.difficulty);
  const pts = room.track?.points || [];
  const seq = [];
  const seen = new Set();
  const pushPoint = p => {
    const col = clamp(Math.floor(p.x * cols), 0, cols - 1);
    const row = clamp(Math.floor(p.y * rows), 0, rows - 1);
    const index = row * cols + col;
    if (!seen.has(index)) { seen.add(index); seq.push(index); }
  };
  if (!pts.length) return seq;
  pushPoint(pts[0]);
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i];
    const dx = (b.x - a.x) * cols;
    const dy = (b.y - a.y) * rows;
    const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) * 12));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      pushPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return seq;
}
function cellRowCol(index, cols) { return { row: Math.floor(index / cols), col: index % cols }; }
function circularCellDistance(a, b, length) {
  const d = Math.abs(a - b);
  return Math.min(d, length - d);
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sideCellsForAnchor(seq, pathIndex, cols, rows, targetSet) {
  const n = seq.length;
  if (n < 3) return null;
  const prev = cellRowCol(seq[(pathIndex - 1 + n) % n], cols);
  const cur = cellRowCol(seq[pathIndex], cols);
  const next = cellRowCol(seq[(pathIndex + 1) % n], cols);
  let tx = next.col - prev.col;
  let ty = next.row - prev.row;
  if (Math.abs(tx) + Math.abs(ty) < 1e-6) {
    tx = next.col - cur.col; ty = next.row - cur.row;
  }
  const len = Math.hypot(tx, ty) || 1;
  const nx = -ty / len, ny = tx / len;
  const offsets = [];
  for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
    if (!dr && !dc) continue;
    const ol = Math.hypot(dc, dr);
    offsets.push({ dc, dr, ax: dc / ol, ay: dr / ol });
  }
  const pickSide = sign => {
    const candidates = offsets
      .map(o => ({ ...o, score: (o.ax * nx + o.ay * ny) * sign }))
      .sort((a,b)=>b.score-a.score);
    for (const o of candidates) {
      if (o.score < 0.35) break;
      const row = cur.row + o.dr, col = cur.col + o.dc;
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
      const idx = row * cols + col;
      if (!targetSet.has(idx)) return idx;
    }
    return null;
  };
  const left = pickSide(1), right = pickSide(-1);
  if (left == null || right == null || left === right) return null;
  return { left, right };
}
function generateAdvancedSpecials(room) {
  if (room.difficulty !== 'hard' || !room.track?.points) return null;
  const target = targetAcetate(room);
  const targetSet = new Set(target.indexes);
  const seq = orderedTrackCells(room).filter(i => targetSet.has(i));
  if (seq.length < 20) return null;
  const valid = [];
  for (let i = 0; i < seq.length; i += 1) {
    const sides = sideCellsForAnchor(seq, i, target.cols, target.rows, targetSet);
    if (sides) valid.push({ pathIndex:i, trackCell:seq[i], ...sides });
  }
  shuffleInPlace(valid);
  const chosen = [];
  const usedSpecialCells = new Set();
  for (const candidate of valid) {
    const cells=[candidate.trackCell,candidate.left,candidate.right];
    const separated=chosen.every(c => circularCellDistance(candidate.pathIndex, c.pathIndex, seq.length) >= 6);
    const distinct=cells.every(index=>!usedSpecialCells.has(index));
    if (separated && distinct) {
      chosen.push(candidate);
      cells.forEach(index=>usedSpecialCells.add(index));
      if (chosen.length === 3) break;
    }
  }
  if (chosen.length < 3) return null;
  const bonusValues = shuffleInPlace([15,10,5]);
  const penaltyValues = shuffleInPlace([-20,-15,-10,-5]).slice(0,3);
  const gates = chosen
    .sort((a,b)=>a.pathIndex-b.pathIndex)
    .map((c,i)=>({
      trackCell:c.trackCell,
      leftCell:c.left,
      rightCell:c.right,
      bonus:bonusValues[i],
      penalty:penaltyValues[i],
      pathIndex:c.pathIndex
    }));
  return { cols:target.cols, rows:target.rows, minTrackDistance:6, gates };
}
function scoreAdvancedSpecials(room, occupied) {
  const specials = room.advancedSpecials;
  if (room.difficulty !== 'hard' || !specials?.gates?.length) return { advancedBonus:0, advancedPenalty:0, advancedNet:0 };
  const has = index => occupied instanceof Set ? occupied.has(index) : !!occupied[index];
  let advancedBonus = 0, advancedPenalty = 0;
  for (const gate of specials.gates) {
    if (has(gate.trackCell)) advancedBonus += gate.bonus;
    if (has(gate.leftCell)) advancedPenalty += gate.penalty;
    if (has(gate.rightCell)) advancedPenalty += gate.penalty;
  }
  return { advancedBonus, advancedPenalty, advancedNet:advancedBonus + advancedPenalty };
}
function scoreTeam(room, team) {
  // Folha A5 virtual. O tamanho físico da tela não interfere na aferição.
  const W=592,H=840;
  const playerMask = new Uint8Array(W*H);
  for (const op of team.ops) {
    const radius = op.width * W * 0.5;
    rasterLine(playerMask,W,H,op.from,op.to,radius,op.kind==='draw'?1:0);
  }
  const target=targetAcetate(room);
  const player=cellsFromMask(playerMask,W,H,target.cols,target.rows);
  const hitCells=target.indexes.filter(index=>player.occupied[index]);
  const advanced=scoreAdvancedSpecials(room,player.occupied);
  return {
    score:hitCells.length,
    targetCellCount:target.indexes.length,
    playerCellCount:player.indexes.length,
    acetate:{cols:target.cols,rows:target.rows,targetCells:target.indexes,hitCells},
    ...advanced
  };
}
function scoreSmartphoneTeam(room, team) {
  const target=targetAcetate(room);
  const playerCells=Array.isArray(team.scanCells)?team.scanCells:[];
  const playerSet=new Set(playerCells);
  const hitCells=target.indexes.filter(index=>playerSet.has(index));
  const advanced=scoreAdvancedSpecials(room,playerSet);
  return {
    score:hitCells.length,
    targetCellCount:target.indexes.length,
    playerCellCount:playerSet.size,
    acetate:{cols:target.cols,rows:target.rows,targetCells:target.indexes,hitCells},
    ...advanced
  };
}
function finishBonusByTeamCount(teamCount) {
  if (teamCount >= 4) return [10, 5, 3, 0];
  if (teamCount === 3) return [10, 4, 0];
  if (teamCount === 2) return [7, 0];
  return [0];
}
function assignFinishBonuses(room, colors) {
  const order = colors.slice().sort((a,b) => {
    const ta = room.teamStates[a];
    const tb = room.teamStates[b];
    return (ta.finishOrder || Infinity) - (tb.finishOrder || Infinity)
      || (ta.finishedAt || Infinity) - (tb.finishedAt || Infinity)
      || TEAM_COLORS.indexOf(a) - TEAM_COLORS.indexOf(b);
  });
  const bonuses = finishBonusByTeamCount(order.length);
  order.forEach((color,index) => {
    const team = room.teamStates[color];
    team.finishPlace = index + 1;
    team.bonus = bonuses[index] || 0;
  });
}
function clearLastTeamCountdown(room) {
  if (!room) return;
  if (finalTeamTimers.has(room.code)) clearTimeout(finalTeamTimers.get(room.code));
  finalTeamTimers.delete(room.code);
  room.lastTeamDeadline = null;
  room.lastTeamColor = null;
}
function maybeStartLastTeamCountdown(room) {
  if (!room || room.status !== 'racing') { if (room) clearLastTeamCountdown(room); return false; }
  const colors = Object.keys(room.teamStates || {});
  if (colors.length <= 1) { clearLastTeamCountdown(room); return false; }
  const unfinished = colors.filter(color => !room.teamStates[color]?.finishedAt);
  if (unfinished.length !== 1) {
    if (unfinished.length === 0 || room.lastTeamDeadline) clearLastTeamCountdown(room);
    return false;
  }
  const color = unfinished[0];
  if (room.lastTeamColor === color && room.lastTeamDeadline && room.lastTeamDeadline > Date.now()) return false;
  clearLastTeamCountdown(room);
  const deadline = Date.now() + 10000;
  room.lastTeamColor = color;
  room.lastTeamDeadline = deadline;
  const timer = setTimeout(() => {
    finalTeamTimers.delete(room.code);
    const current = rooms.get(room.code);
    if (!current || current.status !== 'racing') return;
    if (current.lastTeamColor !== color || current.lastTeamDeadline !== deadline) return;
    const team = current.teamStates[color];
    if (!team || team.finishedAt) { clearLastTeamCountdown(current); emitRoom(current); return; }

    team.timedOut = true;
    team.finishedAt = deadline;
    team.finishOrder = ++current.finishCounter;
    team.elapsedMs = Math.max(0, deadline - current.startedAt);
    // No Smartphone não há motivo para pedir fotografia: a dupla já zerou a etapa.
    if (current.mode === 'smartphone') {
      team.scanSubmitted = true;
      team.scanCells = [];
      team.scanImage = null;
    }
    current.lastTeamDeadline = null;
    current.lastTeamColor = null;
    maybeFinishRoom(current);
    emitRoom(current);
  }, Math.max(0, deadline - Date.now()) + 25);
  finalTeamTimers.set(room.code, timer);
  return true;
}

function maybeFinishRoom(room) {
  const colors = Object.keys(room.teamStates);
  if (!colors.length) return false;
  const smartphone=room.mode==='smartphone';
  const ready=smartphone
    ? colors.every(c=>room.teamStates[c].finishedAt&&room.teamStates[c].scanSubmitted)
    : colors.every(c=>room.teamStates[c].finishedAt);
  if(!ready)return false;
  assignFinishBonuses(room, colors);
  const rows = colors.map(color => {
    const t=room.teamStates[color];
    const scored=smartphone?scoreSmartphoneTeam(room,t):scoreTeam(room,t);
    t.targetCellCount=scored.targetCellCount;
    if (t.timedOut) {
      t.routeScore=0;
      t.bonus=0;
      t.advancedBonus=0;
      t.advancedPenalty=0;
      t.advancedNet=0;
      t.total=0;
    } else {
      t.routeScore=scored.score;
      t.advancedBonus=scored.advancedBonus||0;
      t.advancedPenalty=scored.advancedPenalty||0;
      t.advancedNet=scored.advancedNet||0;
      t.total=t.routeScore+t.bonus+t.advancedNet;
    }
    return {
      color,
      routeScore:t.routeScore,
      targetCellCount:t.targetCellCount,
      playerCellCount:scored.playerCellCount,
      bonus:t.bonus,
      finishPlace:t.finishPlace,
      timedOut:!!t.timedOut,
      advancedBonus:t.advancedBonus,
      advancedPenalty:t.advancedPenalty,
      advancedNet:t.advancedNet,
      total:t.total,
      elapsedMs:t.elapsedMs,
      ops:t.ops,
      scanImage:smartphone?t.scanImage:null,
      acetate:scored.acetate,
      smartphoneStart:t.smartphoneStart||null
    };
  });
  rows.sort((a,b)=>b.total-a.total || a.elapsedMs-b.elapsedMs);
  rows.forEach((r,i)=>r.place=i+1);
  room.results={
    ranking:rows,
    finishedAt:Date.now(),
    scoring:'acetate-cells-plus-finish-bonus-plus-advanced-specials-with-last-team-timeout',
    grid:acetateGrid(room.difficulty),
    mode:room.mode||'online'
  };
  clearLastTeamCountdown(room);
  room.status='finished';
  return true;
}
function claimChip() {
  return { ok:false, error:'As fichas de etapa foram removidas. O bônus agora é definido pela ordem de conclusão.' };
}
function confirmTeamFinish(room, team, player) {
  if (room.status !== 'racing') return { ok:false, error:'A corrida ainda não está em andamento.' };
  if (team.finishedAt) return { ok:false, error:'Sua dupla já concluiu a pista.' };
  if (room.lastTeamColor===team.color && room.lastTeamDeadline && Date.now()>=room.lastTeamDeadline) {
    return { ok:false, error:'O prazo final de 10 segundos terminou.' };
  }

  if (room.mode === 'smartphone') {
    if (player.id !== team.copilotId) return { ok:false, error:'Você não pertence a essa dupla.' };
    team.copilotConfirmed=true;
    team.finishedAt=Date.now();
    team.finishOrder=++room.finishCounter;
    team.elapsedMs=Math.max(0,team.finishedAt-room.startedAt);
    maybeStartLastTeamCountdown(room);
    emitRoom(room);
    return {ok:true,confirmedRole:'copilot',teamFinished:true,elapsedMs:team.elapsedMs,roomFinished:false,needsScan:true};
  }

  const field = player.id === team.pilotId
    ? 'pilotConfirmed'
    : player.id === team.copilotId
      ? 'copilotConfirmed'
      : null;
  if (!field) return { ok:false, error:'Você não pertence a essa dupla.' };
  if (team[field]) return { ok:false, error:'Você já confirmou a conclusão.' };

  team[field] = true;
  let teamFinished = false;
  let roomFinished = false;
  if (team.pilotConfirmed && team.copilotConfirmed) {
    team.finishedAt = Date.now();
    team.finishOrder = ++room.finishCounter;
    team.elapsedMs = Math.max(0, team.finishedAt - room.startedAt);
    teamFinished = true;
    maybeStartLastTeamCountdown(room);
    roomFinished = maybeFinishRoom(room);
  }
  emitRoom(room);
  return {
    ok:true,
    confirmedRole: player.id === team.pilotId ? 'pilot' : 'copilot',
    teamFinished,
    elapsedMs: team.elapsedMs,
    roomFinished,
    needsScan:false
  };
}
function beginCountdown(room) {
  if (room.status !== 'prep') return;
  const ids = room.playerOrder.filter(id => room.players[id]?.color && room.teamStates[room.players[id].color]);
  if (!ids.length || !ids.every(id => room.players[id].ready && room.players[id].connected)) return;
  clearLastTeamCountdown(room);
  room.status='countdown'; room.countdownEndsAt=Date.now()+10000;
  emitRoom(room);
  const timer=setTimeout(()=>{
    if (!rooms.has(room.code) || room.status!=='countdown') return;
    room.status='racing'; room.startedAt=room.countdownEndsAt; room.countdownEndsAt=null;
    emitRoom(room);
    countdownTimers.delete(room.code);
  },10020);
  countdownTimers.set(room.code,timer);
}
function removePlayer(room, player) {
  delete room.players[player.id];
  room.playerOrder=room.playerOrder.filter(id=>id!==player.id);
  if (room.hostId===player.id) room.hostId=room.playerOrder[0]||null;
  if (!room.playerOrder.length) { clearLastTeamCountdown(room); rooms.delete(room.code); cancelEmptyTimer(room.code); return; }
  if (room.status==='lobby') emitRoom(room);
  else emitRoom(room);
}

io.on('connection', socket => {
  socket.on('createRoom', (payload, ack) => {
    if (!simpleRate(socket,'room',8,10000)) return ackError(ack,'Muitas tentativas. Tente novamente em instantes.');
    const name=cleanName(payload?.name), difficulty=DIFFICULTIES.includes(payload?.difficulty)?payload.difficulty:null;
    const mode=ROOM_MODES.includes(payload?.mode)?payload.mode:'online';
    if (!name) return ackError(ack,'Informe um nome válido de até 24 caracteres.');
    if (!difficulty) return ackError(ack,'Escolha a dificuldade.');
    const {room,player}=createRoomData(name,difficulty,socket.id,mode); attachSocket(socket,room,player);
    ackOk(ack,{ code:room.code, playerId:player.id, token:player.token, mode:room.mode }); emitRoom(room);
  });

  socket.on('joinRoom', (payload, ack) => {
    if (!simpleRate(socket,'room',8,10000)) return ackError(ack,'Muitas tentativas. Tente novamente em instantes.');
    const name=cleanName(payload?.name), code=cleanCode(payload?.code);
    if (!name || !code) return ackError(ack,'Nome ou código inválido.');
    const room=rooms.get(code); if (!room) return ackError(ack,'Sala não encontrada.');
    if (room.status!=='lobby') return ackError(ack,'A partida já foi iniciada.');
    const requestedMode=ROOM_MODES.includes(payload?.mode)?payload.mode:null;
    if(requestedMode&&requestedMode!==room.mode)return ackError(ack,`Essa sala foi criada no modo ${room.mode==='smartphone'?'Smartphone':'Online'}.`);
    const maxPlayers=room.mode==='smartphone'?4:8;
    if (room.playerOrder.length>=maxPlayers) return ackError(ack,`A sala já possui ${maxPlayers} jogadores.`);
    const id=makeId(), token=makeToken();
    const color=room.mode==='smartphone'?firstFreeColor(room):null;
    if(room.mode==='smartphone'&&!color)return ackError(ack,'As quatro vagas de Copiloto já estão ocupadas.');
    const p={id,token,name,color,role:room.mode==='smartphone'?'copilot':null,connected:true,socketId:socket.id,ready:false};
    room.players[id]=p; room.playerOrder.push(id); attachSocket(socket,room,p);
    ackOk(ack,{code,id,playerId:id,token,mode:room.mode}); emitRoom(room);
  });

  socket.on('resumeSession', (payload, ack) => {
    const code=cleanCode(payload?.code), id=String(payload?.playerId||''), token=String(payload?.token||'');
    const room=code?rooms.get(code):null, p=room?.players[id];
    if (!room||!p||!token||p.token!==token) return ackError(ack,'Sessão não encontrada.');
    attachSocket(socket,room,p); ackOk(ack,{code,playerId:p.id,token:p.token}); emitRoom(room);
  });

  socket.on('setTeam', (payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (room.status!=='lobby') return ackError(ack,'A equipe só pode ser alterada no lobby.');
    if (room.mode==='smartphone') return ackError(ack,'No modo Smartphone as cores são atribuídas automaticamente.');
    const color=TEAM_COLORS.includes(payload?.color)?payload.color:null, role=ROLES.includes(payload?.role)?payload.role:null;
    if (!color||!role) return ackError(ack,'Equipe inválida.');
    const occupied=room.playerOrder.some(id=>{const p=room.players[id]; return p.id!==player.id&&p.color===color&&p.role===role;});
    if (occupied) return ackError(ack,'Essa vaga já está ocupada.');
    player.color=color; player.role=role; player.ready=false; emitRoom(room); ackOk(ack);
  });

  socket.on('startGame', (_payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (player.id!==room.hostId) return ackError(ack,'Somente o anfitrião pode iniciar.');
    if (room.status!=='lobby') return ackError(ack,'A partida já foi iniciada.');
    if (room.mode==='smartphone') {
      if(room.playerOrder.length<1||room.playerOrder.length>4)return ackError(ack,'O modo Smartphone aceita de 1 a 4 Copilotos.');
    } else {
      if (completeTeams(room).length<1) return ackError(ack,'Forme ao menos uma dupla completa.');
      if (!allPlayersInCompleteTeams(room)) return ackError(ack,'Todos os jogadores precisam estar em uma dupla completa.');
    }

    clearLastTeamCountdown(room);
    room.status='starting';
    room.startedAt=null;
    room.countdownEndsAt=null;
    emitRoom(room);
    ackOk(ack);

    setImmediate(() => {
      try {
        generateTrackForRoom(room);
        room.advancedSpecials=generateAdvancedSpecials(room);
        room.chips=[null,null,null,null];
        room.results=null;
        room.startedAt=null;
        room.countdownEndsAt=null;
        for (const id of room.playerOrder) room.players[id].ready=false;
        initializeTeamStates(room);
        room.status='prep';
        emitRoom(room);
      } catch (err) {
        console.error('[Rally Team] Falha ao gerar pista:', err);
        room.status='lobby';
        emitRoom(room);
      }
    });
  });

  socket.on('setReady', (payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (room.restarting) return ackError(ack,'Aguarde a nova pista ser gerada.');
    if (room.status!=='prep') return ackError(ack,'Não é possível alterar prontidão agora.');
    player.ready=payload?.ready!==false; emitRoom(room); ackOk(ack); beginCountdown(room);
  });

  socket.on('drawOp', raw => {
    if (!simpleRate(socket,'draw',220,1000)) return;
    const {room,player}=playerBySocket(socket); if (!room||!player||room.restarting||room.status!=='racing'||player.role!=='pilot'||!player.color) return;
    const team=room.teamStates[player.color]; if (!team||team.pilotId!==player.id||team.finishedAt) return;
    const op=cleanDrawOp(raw); if (!op) return;
    if (team.ops.length>=20000) return;
    team.ops.push(op);
    const mate=room.players[team.copilotId];
    if (mate?.connected&&mate.socketId) io.to(mate.socketId).emit('drawOp',{color:player.color,op});
  });

  socket.on('claimChip', (payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (room.restarting) return ackError(ack,'Aguarde a nova pista ser gerada.');
    if (player.role!=='copilot' || !player.color) return ackError(ack,'Somente o Copiloto pode pegar a ficha.');
    const team=room.teamStates[player.color]; if (!team||team.copilotId!==player.id) return ackError(ack,'Dupla inválida.');
    const result=claimChip(room,team,Number(payload?.index));
    if (!result.ok) return ackError(ack,result.error);
    ackOk(ack);
  });

  socket.on('finishTeam', (_payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (!player.color || !player.role) return ackError(ack,'Você não está em uma dupla.');
    const team=room.teamStates[player.color]; if (!team) return ackError(ack,'Dupla inválida.');
    if (player.id!==team.pilotId && player.id!==team.copilotId) return ackError(ack,'Você não pertence a essa dupla.');
    const result=confirmTeamFinish(room,team,player);
    if (!result.ok) return ackError(ack,result.error);
    ackOk(ack,{
      confirmedRole:result.confirmedRole,
      teamFinished:result.teamFinished,
      elapsedMs:result.elapsedMs,
      roomFinished:result.roomFinished,
      // A resposta leva também o estado final correspondente a ESTE jogador.
      // Assim a tela de resultado abre pelo próprio clique, mesmo antes de
      // qualquer roomState assíncrono chegar ao navegador.
      state:roomClientShape(room,player)
    });
  });


  socket.on('submitSmartphoneScan', (payload, ack) => {
    const {room,player}=playerBySocket(socket); if(!room||!player)return ackError(ack,'Sessão inválida.');
    if(room.mode!=='smartphone')return ackError(ack,'Esta sala não usa fotografia do papel.');
    if(room.status!=='racing')return ackError(ack,'A corrida não está aguardando fotografias.');
    const team=room.teamStates[player.color];
    if(!team||team.copilotId!==player.id)return ackError(ack,'Dupla inválida.');
    if(!team.finishedAt)return ackError(ack,'Clique em Concluímos antes de fotografar a folha.');
    if(team.scanSubmitted)return ackError(ack,'A fotografia desta dupla já foi enviada.');
    const {cols,rows}=acetateGrid(room.difficulty), max=cols*rows;
    const cells=Array.isArray(payload?.cells)?payload.cells:[];
    const unique=[...new Set(cells.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<max))];
    const image=String(payload?.scanImage||'');
    if(!/^data:image\/(png|jpeg);base64,/i.test(image)||image.length>900000)return ackError(ack,'A imagem processada é inválida ou grande demais.');
    team.scanCells=unique;
    team.scanImage=image;
    team.scanSubmitted=true;
    const roomFinished=maybeFinishRoom(room);
    emitRoom(room);
    ackOk(ack,{roomFinished,state:roomClientShape(room,player)});
  });

  socket.on('restartGame', (_payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return ackError(ack,'Sessão inválida.');
    if (player.id!==room.hostId) return ackError(ack,'Somente o anfitrião pode reiniciar.');
    if (!['prep','countdown','racing','finished'].includes(room.status)) return ackError(ack,'Não é possível reiniciar neste momento.');
    if (room.restarting) return ackError(ack,'Uma nova pista já está sendo gerada.');

    room.restarting=true;
    if (countdownTimers.has(room.code)) clearTimeout(countdownTimers.get(room.code));
    countdownTimers.delete(room.code);
    clearLastTeamCountdown(room);
    emitRoom(room);
    ackOk(ack);

    setImmediate(() => {
      try {
        generateTrackForRoom(room);
        room.advancedSpecials=generateAdvancedSpecials(room);
        room.chips=[null,null,null,null];
        room.results=null;
        room.startedAt=null;
        room.countdownEndsAt=null;
        for (const id of room.playerOrder) room.players[id].ready=false;
        initializeTeamStates(room);
        room.restarting=false;
        room.status='prep';
        emitRoom(room);
      } catch (err) {
        console.error('[Rally Team] Falha ao reiniciar com nova pista:', err);
        room.restarting=false;
        room.status='prep';
        room.startedAt=null;
        room.countdownEndsAt=null;
        for (const id of room.playerOrder) room.players[id].ready=false;
        initializeTeamStates(room);
        emitRoom(room);
      }
    });
  });

  socket.on('leaveRoom', (_payload, ack) => {
    const {room,player}=playerBySocket(socket); if (!room||!player) { ackOk(ack); return; }
    socket.leave(room.code); socket.data.session=null; removePlayer(room,player); ackOk(ack);
  });

  socket.on('disconnect', () => {
    const {room,player}=playerBySocket(socket); if (!room||!player) return;
    if (player.socketId!==socket.id) return;
    player.connected=false; player.socketId=null; emitRoom(room); scheduleEmptyRoom(room);
  });
});

server.listen(PORT, () => console.log(`Rally Team Online disponível em http://localhost:${PORT}`));
