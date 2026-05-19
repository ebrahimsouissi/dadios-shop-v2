/* Dadios — Boutique 3D scene v5 (Phase 12 — Astro integration)
 *
 * Phase 12 additions over the original prototype:
 *  - detectLowPerf() heuristic. On mobile + (low memory OR weak GPU) we
 *    drop blossoms 110→40, bottles per shelf row 7→4, tree pebbles 24→8,
 *    table OSB chips 300→80, disable shadow maps, pin pixelRatio at 1,
 *    skip the ceiling spotlights and turn off auto-rotate.
 *  - prefers-reduced-motion: no auto-rotate, no foliage sway, no hover
 *    floating, instant unfold transition.
 *  - Live product catalogue: scene.js calls Bot.setProducts(arr) after
 *    fetching /api/products + /products.json. The featureIds and
 *    tableProducts arrays now derive from whatever the live catalogue
 *    holds — no hardcoded slugs.
 *  - selectProduct's CTA reads "Ajouter au panier — 50ml" and wires to
 *    window.cart.addItem({ slug, name, size, price, qty }). Shows a
 *    short "Ajouté au panier ✓" toast and keeps focus on the scene.
 *  - All visible UI strings in French.
 *
 * If THREE / OrbitControls / DadiosBottles aren't loaded by the time
 * this script runs, BoutiqueScene.astro shows the static fallback img.
 */

(async function () {
  // Phase 12 bugfix: wait briefly for the orchestrator in
  // BoutiqueScene.astro to finish fetching /api/products and call
  // DadiosBottles.setProducts(...). If we built the scene immediately,
  // we'd use the hardcoded fallback catalogue even when the live one
  // is available. 2.5 s timeout makes the wait bounded — if the
  // orchestrator never signals, we boot with whatever bottles.js
  // currently has.
  await new Promise((resolve) => {
    if (window.__dadiosBotReady) return resolve();
    const t = setTimeout(resolve, 2500);
    document.addEventListener('dadios-bot-ready', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

  // ===== Phase 12 perf detection =====
  function detectLowPerf() {
    try {
      const ua = navigator.userAgent || '';
      const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
      const isLowMemory = !!navigator.deviceMemory && navigator.deviceMemory < 4;
      let isLowGPU = false;
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
          isLowGPU = /Mali|Adreno [3-5]|PowerVR|Intel HD/i.test(String(renderer));
        }
      } catch {}
      return isMobile && (isLowMemory || isLowGPU);
    } catch { return false; }
  }
  const LOW_PERF = detectLowPerf();
  const PREFERS_REDUCED = (typeof matchMedia === 'function')
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TOUCH_ONLY = (typeof matchMedia === 'function')
    && matchMedia('(pointer: coarse)').matches;

  const COUNT_BLOSSOMS = LOW_PERF ? 40 : 110;
  const COUNT_BOTTLES_PER_ROW = LOW_PERF ? 4 : 7;
  const COUNT_PEBBLES = LOW_PERF ? 8 : 24;
  const COUNT_TABLE_CHIPS = LOW_PERF ? 80 : 300;

  if (LOW_PERF) {
    try {
      const note = document.createElement('div');
      note.textContent = 'Mode économe activé';
      note.setAttribute('style', [
        'position:absolute', 'top:60px', 'right:18px', 'z-index:5',
        'background:rgba(42,34,26,0.78)', 'color:#f3e9d8',
        'padding:6px 10px', 'border-radius:999px',
        'font:500 11px Inter, sans-serif',
        'letter-spacing:0.1em', 'text-transform:uppercase',
        'opacity:0', 'transition:opacity .25s', 'pointer-events:none',
      ].join(';'));
      const w = document.getElementById('sceneWrap');
      if (w) {
        w.appendChild(note);
        requestAnimationFrame(() => { note.style.opacity = '1'; });
        setTimeout(() => { note.style.opacity = '0'; setTimeout(() => note.remove(), 400); }, 2000);
      }
    } catch {}
  }

  const T = window.THREE;
  const Bot = window.DadiosBottles;
  if (!T || !Bot) {
    // Bail silently — BoutiqueScene.astro's fallback will catch it.
    return;
  }

  // ——— DOM ———
  const wrap = document.getElementById('sceneWrap');
  const canvas = document.getElementById('scene');
  const tooltip = document.getElementById('tooltip');
  const hint = document.getElementById('hint');
  const btnAuto = document.getElementById('btnAuto');
  const btnReset = document.getElementById('btnReset');
  const btnUnfold = document.getElementById('btnUnfold');
  const productEl = document.getElementById('product');

  // ——— Renderer ———
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // Phase 12: cap pixelRatio at 1 in low-perf, drop shadows entirely.
  renderer.setPixelRatio(LOW_PERF ? 1 : Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = !LOW_PERF;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new T.Scene();
  scene.background = null;

  // ——— Camera ———
  const camera = new T.PerspectiveCamera(28, 1, 0.1, 100);
  const camStart = new T.Vector3(12, 11, 14);
  camera.position.copy(camStart);

  // ——— Controls ———
  const controls = new T.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1.8, -0.3);
  controls.minDistance = 10;
  controls.maxDistance = 30;
  controls.minPolarAngle = Math.PI * 0.05;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enablePan = false;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.7;
  // Phase 12: respect low-perf + reduced-motion defaults.
  controls.autoRotate = !(LOW_PERF || PREFERS_REDUCED);
  controls.autoRotateSpeed = 0.5;

  // ——— Lighting ———
  scene.add(new T.AmbientLight(0xfff0d8, 0.55));
  scene.add(new T.HemisphereLight(0xfff1d8, 0xb59b78, 0.34));

  const sun = new T.DirectionalLight(0xfff0d8, 0.85);
  sun.position.set(10, 16, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -10;
  sun.shadow.bias = -0.0005;
  sun.shadow.radius = 4;
  scene.add(sun);

  const fill = new T.DirectionalLight(0xfff4d8, 0.32);
  fill.position.set(2, 6, 14);
  scene.add(fill);

  // ——— Palette ———
  const COL = {
    walnutA: 0x7a4d2c,
    slatLight: 0xd4b288,
    slatDark:  0x1f1610,
    wallWhite: 0xf3ecdd,
    tileTop: 0xc6d9a8,
    tileLeft: 0x4f7a55,
    tileRight: 0x1e3a26,
    tileAccentTop: 0xe8d8a6,
    tileAccentLeft: 0xb38b5a,
    tileAccentRight: 0x5a3e22,
    gold: 0xd7b25c,
    goldDeep: 0xa07d33,
    pot: 0xece3d2,
    trunk: 0x7a553a,
    blossomA: 0xf5e9d2,
    blossomB: 0xead5b8,
    blossomC: 0xfaf0dd,
    giftWood: 0x7a4a2a,
    osbBase: 0xc7a86a,
    osbChipA: 0xb38a4a,
    osbChipB: 0xd9b878,
    osbChipC: 0x8a6534,
    osbChipD: 0xa67d4a,
    black: 0x18130d,
    brass: 0xb89154,
    curtainRed: 0x781522,
    curtainShadow: 0x4a0c14,
  };

  const mat = (c, opts = {}) => new T.MeshStandardMaterial({ color: c, roughness: 0.8, ...opts });
  const matGold = () => new T.MeshStandardMaterial({ color: COL.gold, roughness: 0.28, metalness: 0.92 });
  const matGoldDeep = () => new T.MeshStandardMaterial({ color: COL.goldDeep, roughness: 0.35, metalness: 0.88 });

  const room = new T.Group();
  scene.add(room);

  // ——— Constants ———
  const ROOM_W = 8.5;
  const ROOM_D = 7.5;
  const WALL_H = 5.2;
  const LEDGE = 1.8;

  // ====================================================
  // BASE PLATFORM + LEDGE
  // ====================================================
  const baseFrontZ = -ROOM_D / 2 - 0.3;
  const baseBackZ = ROOM_D / 2 + LEDGE;
  const baseCenterZ = (baseFrontZ + baseBackZ) / 2;
  const BASE_D = baseBackZ - baseFrontZ;
  const base = new T.Mesh(
    new T.BoxGeometry(ROOM_W + 0.6, 0.4, BASE_D),
    mat(0xc8b491, { roughness: 0.95 })
  );
  base.position.set(0, -0.2, baseCenterZ);
  base.receiveShadow = true;
  room.add(base);

  // brass nameplate
  function makeNameplate() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 80;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 80);
    g.addColorStop(0, '#c8a160');
    g.addColorStop(0.5, '#b8924a');
    g.addColorStop(1, '#9d7a38');
    x.fillStyle = g;
    x.fillRect(0, 0, 1024, 80);
    for (let i = 0; i < 200; i++) {
      x.fillStyle = `rgba(255,230,180,${Math.random() * 0.15})`;
      x.fillRect(Math.random() * 1024, Math.random() * 80, 2, 1);
    }
    x.strokeStyle = '#5a3f15';
    x.lineWidth = 2;
    x.strokeRect(8, 8, 1008, 64);
    x.fillStyle = '#241a0c';
    x.font = '600 28px "Inter", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('ISOMETRIC MODEL  \u2022  DADIOS FRAGRANCE STUDIO', 512, 42);
    return new T.CanvasTexture(c);
  }
  const nameplate = new T.Mesh(
    new T.PlaneGeometry(5.5, 0.32),
    new T.MeshStandardMaterial({ map: makeNameplate(), roughness: 0.4, metalness: 0.7 })
  );
  nameplate.position.set(0, -0.05, baseBackZ + 0.02);
  room.add(nameplate);

  // ====================================================
  // FLOOR — light oak planks
  // ====================================================
  const floor = new T.Group();
  const floorDepth = ROOM_D + LEDGE;
  const planks = 18;
  const plankW = floorDepth / planks;
  const oakShades = [
    0xd3a772, 0xc69862, 0xb8884e, 0xcb9b66, 0xd9af7c, 0xbf905a, 0xc99c68,
    0xd1a572, 0xc8985f, 0xd5a875, 0xbe9056, 0xcfa06c, 0xc4934f, 0xddb682,
    0xc69862, 0xd3a772, 0xb8884e, 0xcb9b66,
  ];
  for (let i = 0; i < planks; i++) {
    const p = new T.Mesh(
      new T.BoxGeometry(ROOM_W, 0.04, plankW - 0.015),
      mat(oakShades[i % oakShades.length], { roughness: 0.78 })
    );
    p.position.set(0, 0.02, -ROOM_D / 2 + plankW / 2 + i * plankW);
    p.receiveShadow = true;
    floor.add(p);
  }
  room.add(floor);

  // brass threshold at the open entrance
  const threshold = new T.Mesh(
    new T.BoxGeometry(ROOM_W, 0.04, 0.1),
    mat(0xb89154, { roughness: 0.4, metalness: 0.85 })
  );
  threshold.position.set(0, 0.045, ROOM_D / 2 - 0.05);
  room.add(threshold);

  // ====================================================
  // GREEN TUMBLING-BLOCKS TILES (under right-wall table)
  // ====================================================
  function makeRhombus(verts, color) {
    const shape = new T.Shape();
    shape.moveTo(verts[0][0], verts[0][1]);
    for (let i = 1; i < verts.length; i++) shape.lineTo(verts[i][0], verts[i][1]);
    shape.closePath();
    const geom = new T.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false });
    const m = new T.Mesh(geom, mat(color, { roughness: 0.5, metalness: 0.06 }));
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    return m;
  }
  function makeTileCube(cx, cz, r, colors) {
    const g = new T.Group();
    const v = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * 60 + 30) * Math.PI / 180;
      v.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    g.add(makeRhombus([v[0], v[1], v[2], [0, 0]], colors[0]));
    g.add(makeRhombus([v[2], v[3], v[4], [0, 0]], colors[1]));
    g.add(makeRhombus([v[4], v[5], v[0], [0, 0]], colors[2]));
    g.position.set(cx, 0.045, cz);
    return g;
  }
  const tileAreaX = [1.4, 3.2];
  const tileAreaZ = [-3.0, 3.0];
  const grout = new T.Mesh(
    new T.BoxGeometry(tileAreaX[1] - tileAreaX[0], 0.05, tileAreaZ[1] - tileAreaZ[0]),
    mat(0x2a3a30, { roughness: 1 })
  );
  grout.position.set((tileAreaX[0] + tileAreaX[1]) / 2, 0.025, (tileAreaZ[0] + tileAreaZ[1]) / 2);
  grout.receiveShadow = true;
  room.add(grout);
  const tileR = 0.32;
  const xStep = Math.sqrt(3) * tileR;
  const zStep = 1.5 * tileR;
  for (let row = -4; row < 8; row++) {
    for (let col = -2; col < 6; col++) {
      const offset = (row % 2 ? xStep / 2 : 0);
      const cx = col * xStep + offset + 1.7;
      const cz = row * zStep;
      if (cx < tileAreaX[0] - 0.05 || cx > tileAreaX[1] + 0.05) continue;
      if (cz < tileAreaZ[0] - 0.05 || cz > tileAreaZ[1] + 0.05) continue;
      const isAccent = ((row * 7 + col * 3) % 11 === 0);
      const colors = isAccent
        ? [COL.tileAccentTop, COL.tileAccentLeft, COL.tileAccentRight]
        : [COL.tileTop, COL.tileLeft, COL.tileRight];
      room.add(makeTileCube(cx, cz, tileR, colors));
    }
  }

  // ====================================================
  // WALL TEXTURES
  // ====================================================
  function makeTriangleTileTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const x = c.getContext('2d');
    x.fillStyle = '#f3ecdd';
    x.fillRect(0, 0, 512, 512);
    const TS = 128;
    for (let ty = 0; ty < 512; ty += TS) {
      for (let tx = 0; tx < 512; tx += TS) {
        x.strokeStyle = 'rgba(170,150,120,0.18)';
        x.lineWidth = 1;
        x.strokeRect(tx + 0.5, ty + 0.5, TS - 1, TS - 1);
        const cx = tx + TS / 2, cy = ty + TS / 2;
        const tris = [
          [[tx, ty], [tx + TS, ty], [cx, cy], 'rgba(232,220,196,1)', 'rgba(196,178,148,0.55)'],
          [[tx + TS, ty], [tx + TS, ty + TS], [cx, cy], 'rgba(225,213,188,1)', 'rgba(180,164,138,0.55)'],
          [[tx + TS, ty + TS], [tx, ty + TS], [cx, cy], 'rgba(216,202,176,1)', 'rgba(170,154,128,0.55)'],
          [[tx, ty + TS], [tx, ty], [cx, cy], 'rgba(238,228,206,1)', 'rgba(205,188,158,0.55)'],
        ];
        tris.forEach((t) => {
          x.fillStyle = t[3];
          x.beginPath();
          x.moveTo(t[0][0], t[0][1]);
          x.lineTo(t[1][0], t[1][1]);
          x.lineTo(t[2][0], t[2][1]);
          x.closePath();
          x.fill();
          x.strokeStyle = t[4];
          x.lineWidth = 1.2;
          x.beginPath();
          x.moveTo(t[0][0], t[0][1]);
          x.lineTo(t[2][0], t[2][1]);
          x.stroke();
        });
      }
    }
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.repeat.set(3, 2);
    tex.anisotropy = 8;
    return tex;
  }
  function makeMarbleTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 1024;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0, '#2c1f17');
    g.addColorStop(0.5, '#1a120c');
    g.addColorStop(1, '#0e0805');
    x.fillStyle = g;
    x.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 600; i++) {
      const x0 = Math.random() * 1024, y0 = Math.random() * 1024;
      const len = 30 + Math.random() * 180;
      const angle = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 4 + (Math.random() - 0.5) * 0.18);
      x.strokeStyle = `rgba(${180 + Math.random()*50}, ${110 + Math.random()*40}, ${50 + Math.random()*30}, ${0.06 + Math.random() * 0.18})`;
      x.lineWidth = 0.4 + Math.random() * 1.1;
      x.beginPath();
      x.moveTo(x0, y0);
      x.lineTo(x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
      x.stroke();
    }
    for (let i = 0; i < 80; i++) {
      const x0 = Math.random() * 1024, y0 = Math.random() * 1024;
      const len = 80 + Math.random() * 250;
      const angle = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 4);
      x.strokeStyle = `rgba(240, 180, 110, ${0.08 + Math.random() * 0.1})`;
      x.lineWidth = 0.8;
      x.beginPath();
      x.moveTo(x0, y0);
      x.lineTo(x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
      x.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const cx = Math.random() * 1024, cy = Math.random() * 1024;
      const r = 120 + Math.random() * 200;
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, 'rgba(255,230,180,0.07)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = rg;
      x.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  }
  const triTileTex = makeTriangleTileTexture();
  const marbleTex = makeMarbleTexture();

  // ====================================================
  // GOLD FRAME (helper)
  // ====================================================
  function makeGoldFrame(w, h, frameT = 0.12, depth = 0.06) {
    const g = new T.Group();
    const top = new T.Mesh(new T.BoxGeometry(w, frameT, depth), matGold());
    top.position.set(0, h / 2 - frameT / 2, 0); g.add(top);
    const bot = new T.Mesh(new T.BoxGeometry(w, frameT, depth), matGold());
    bot.position.set(0, -h / 2 + frameT / 2, 0); g.add(bot);
    const lft = new T.Mesh(new T.BoxGeometry(frameT, h - frameT * 2, depth), matGold());
    lft.position.set(-w / 2 + frameT / 2, 0, 0); g.add(lft);
    const rgt = new T.Mesh(new T.BoxGeometry(frameT, h - frameT * 2, depth), matGold());
    rgt.position.set(w / 2 - frameT / 2, 0, 0); g.add(rgt);
    const ridges = [
      [w - frameT * 0.5, frameT * 0.18, depth + 0.01, 0, h / 2 - frameT * 0.45, 0],
      [w - frameT * 0.5, frameT * 0.18, depth + 0.01, 0, -h / 2 + frameT * 0.45, 0],
      [frameT * 0.18, h - frameT * 0.9, depth + 0.01, -w / 2 + frameT * 0.45, 0, 0],
      [frameT * 0.18, h - frameT * 0.9, depth + 0.01, w / 2 - frameT * 0.45, 0, 0],
    ];
    ridges.forEach(([rw, rh, rd, x, y, z]) => {
      const r = new T.Mesh(new T.BoxGeometry(rw, rh, rd), matGoldDeep());
      r.position.set(x, y, z);
      g.add(r);
    });
    const glass = new T.Mesh(
      new T.PlaneGeometry(w - frameT * 1.8, h - frameT * 1.8),
      new T.MeshStandardMaterial({ color: 0x2a2326, roughness: 0.25, metalness: 0.6 })
    );
    glass.position.z = depth / 2 + 0.001;
    g.add(glass);
    const highlight = new T.Mesh(
      new T.PlaneGeometry((w - frameT * 1.8) * 0.65, (h - frameT * 1.8) * 0.85),
      new T.MeshBasicMaterial({ color: 0xddcaa0, transparent: true, opacity: 0.18 })
    );
    highlight.position.set(-w * 0.08, h * 0.04, depth / 2 + 0.003);
    highlight.rotation.z = -0.18;
    g.add(highlight);
    return g;
  }

  // ====================================================
  // WALL GROUPS (so we can hinge them open for the elevation view)
  //
  // Each wall group's local origin is at the BOTTOM EDGE of that wall
  // (the line where the wall meets the floor). Rotating the group around
  // the appropriate axis hinges the wall outward.
  // ====================================================
  const frontWallGroup = new T.Group();
  frontWallGroup.position.set(0, 0, -ROOM_D / 2);
  room.add(frontWallGroup);

  // LEFT wall group: origin at the FRONT-LEFT vertical corner (the hinge).
  // In room mode (rotation.y = 0), wall extends from this corner along local +Z.
  // In pano mode (rotation.y = -π/2), wall hinges open along world -X,
  // ending up in line with the front wall, facing +Z (toward camera).
  const leftWallGroup = new T.Group();
  leftWallGroup.position.set(-ROOM_W / 2, 0, -ROOM_D / 2);
  room.add(leftWallGroup);

  // RIGHT wall group: origin at FRONT-RIGHT vertical corner. Hinges to +π/2.
  const rightWallGroup = new T.Group();
  rightWallGroup.position.set(ROOM_W / 2, 0, -ROOM_D / 2);
  room.add(rightWallGroup);

  // ====================================================
  // FRONT WALL — split: SLAT (left) | RED CURTAIN | BLACK (right)
  // Local coords: x is along the wall length, y is up,
  //               z is INTO the room (+z = inside, -z = outside)
  // The wall occupies x ∈ [-W/2, +W/2], y ∈ [0, WALL_H], z ≈ 0
  // ====================================================
  const HALF_W = ROOM_W / 2;
  const CURTAIN_GAP = 0.6; // width reserved for the curtain band

  // —— SLAT PANEL (left half: x from -HALF_W to -CURTAIN_GAP/2)
  const slatSection = new T.Group();
  const SP_W = HALF_W - CURTAIN_GAP / 2;
  const SP_H = WALL_H - 0.4;
  const SP_T = 0.12;
  // dark backing
  const backBoard = new T.Mesh(
    new T.BoxGeometry(SP_W, SP_H, 0.05),
    mat(COL.slatDark, { roughness: 0.9 })
  );
  backBoard.position.set(0, SP_H / 2, 0);
  slatSection.add(backBoard);
  // vertical slats
  const slatCount = Math.floor(SP_W / 0.18);
  const slatStep = SP_W / slatCount;
  const slatLightShades = [0xd4b288, 0xc9a778, 0xddbb92, 0xc8a47a, 0xd6b485, 0xceac80];
  for (let i = 0; i < slatCount; i++) {
    const s = new T.Mesh(
      new T.BoxGeometry(slatStep - 0.025, SP_H - 0.05, 0.05),
      mat(slatLightShades[i % slatLightShades.length], { roughness: 0.75 })
    );
    s.position.set(-SP_W / 2 + slatStep / 2 + i * slatStep, SP_H / 2, 0.04);
    s.castShadow = true; s.receiveShadow = true;
    slatSection.add(s);
  }
  // Center on the RIGHT half of the front wall.
  slatSection.position.set((HALF_W + CURTAIN_GAP / 2) / 2, 0, 0.04);
  frontWallGroup.add(slatSection);

  // —— ROUND BEADED GOLD MIRROR — centered on slat panel (left half)
  const roundMirror = new T.Group();
  const beadCount = 32;
  const beadR = 0.55;
  for (let i = 0; i < beadCount; i++) {
    const a = (i / beadCount) * Math.PI * 2;
    const b = new T.Mesh(new T.SphereGeometry(0.05, 12, 10), matGold());
    b.position.set(Math.cos(a) * beadR, Math.sin(a) * beadR, 0);
    roundMirror.add(b);
  }
  const innerRing = new T.Mesh(
    new T.TorusGeometry(0.45, 0.02, 12, 36), matGold()
  );
  roundMirror.add(innerRing);
  const rmGlass = new T.Mesh(
    new T.CircleGeometry(0.45, 36),
    new T.MeshStandardMaterial({ color: 0xe5dec9, roughness: 0.18, metalness: 0.55 })
  );
  roundMirror.add(rmGlass);
  const rmHl = new T.Mesh(
    new T.CircleGeometry(0.38, 36),
    new T.MeshBasicMaterial({ color: 0xfaf2dc, transparent: true, opacity: 0.32 })
  );
  rmHl.position.z = 0.005;
  roundMirror.add(rmHl);
  roundMirror.position.set((HALF_W + CURTAIN_GAP / 2) / 2, 2.7, 0.14);
  frontWallGroup.add(roundMirror);

  // —— BLACK GLOSSY WALL (left half: x from -HALF_W to -CURTAIN_GAP/2)
  const blackHalf = new T.Mesh(
    new T.BoxGeometry(SP_W, WALL_H, 0.18),
    new T.MeshStandardMaterial({
      color: 0xb6987a, map: marbleTex,
      roughness: 0.16, metalness: 0.32,
    })
  );
  blackHalf.position.set(-(HALF_W + CURTAIN_GAP / 2) / 2, WALL_H / 2, 0);
  blackHalf.receiveShadow = true;
  frontWallGroup.add(blackHalf);

  // —— TALL VERTICAL GOLD MIRROR — centered on black left half
  const verticalMirror = makeGoldFrame(1.6, 3.6, 0.14, 0.08);
  verticalMirror.position.set(-(HALF_W + CURTAIN_GAP / 2) / 2, 1.9, 0.11);
  frontWallGroup.add(verticalMirror);

  // —— RED CURTAIN — hangs between the two halves
  const curtain = new T.Group();
  const CURT_W = CURTAIN_GAP + 0.05;
  const CURT_H = WALL_H - 0.05;
  // brass rod
  const rod = new T.Mesh(
    new T.CylinderGeometry(0.035, 0.035, CURT_W + 0.5, 12),
    mat(0xb89154, { roughness: 0.32, metalness: 0.85 })
  );
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, WALL_H - 0.08, 0.18);
  curtain.add(rod);
  // rod end caps
  [-1, 1].forEach((sx) => {
    const c = new T.Mesh(
      new T.SphereGeometry(0.052, 14, 10),
      mat(0xb89154, { roughness: 0.32, metalness: 0.88 })
    );
    c.position.set(sx * (CURT_W / 2 + 0.25), WALL_H - 0.08, 0.18);
    curtain.add(c);
  });
  // velvet folds — multiple thin tall slabs with subtly varying depths
  const FOLDS = 8;
  const foldStep = CURT_W / FOLDS;
  for (let i = 0; i < FOLDS; i++) {
    const isInner = i % 2 === 0;
    const fold = new T.Mesh(
      new T.BoxGeometry(foldStep - 0.005, CURT_H, isInner ? 0.06 : 0.1),
      new T.MeshStandardMaterial({
        color: isInner ? COL.curtainRed : COL.curtainShadow,
        roughness: 0.95,
        metalness: 0.0,
      })
    );
    const x = -CURT_W / 2 + foldStep / 2 + i * foldStep;
    fold.position.set(x, CURT_H / 2, 0.15 + (isInner ? 0.0 : -0.02));
    fold.castShadow = true;
    fold.receiveShadow = true;
    curtain.add(fold);
  }
  // gentle scallops at the top (where curtain meets rod)
  for (let i = 0; i <= FOLDS; i++) {
    const s = new T.Mesh(
      new T.SphereGeometry(0.06, 10, 8),
      new T.MeshStandardMaterial({ color: COL.curtainRed, roughness: 0.9 })
    );
    const x = -CURT_W / 2 + i * foldStep;
    s.position.set(x, WALL_H - 0.18, 0.18);
    s.scale.y = 0.6;
    curtain.add(s);
  }
  curtain.position.set(0, 0, 0);
  frontWallGroup.add(curtain);

  // baseboard for the front wall
  const bbFront = new T.Mesh(
    new T.BoxGeometry(ROOM_W, 0.16, 0.04),
    mat(0xe9dfc8, { roughness: 0.85 })
  );
  bbFront.position.set(0, 0.08, 0.13);
  frontWallGroup.add(bbFront);

  // crown trim
  const trimFront = new T.Mesh(
    new T.BoxGeometry(ROOM_W + 0.3, 0.22, 0.32),
    mat(0xfaf2e0, { roughness: 0.85 })
  );
  trimFront.position.set(0, WALL_H + 0.05, 0.15);
  frontWallGroup.add(trimFront);

  // ====================================================
  // LEFT WALL — dark marble + 6-row perfume display + horizontal mirror
  // local +X = into room, local -Z = front of room, local +Z = back/door side
  // Wall plane is at local x = 0 (because group origin is at floor edge of left wall).
  // ====================================================
  const leftWallMesh = new T.Mesh(
    new T.BoxGeometry(0.2, WALL_H, ROOM_D),
    new T.MeshStandardMaterial({
      color: 0xb6987a, map: marbleTex,
      roughness: 0.18, metalness: 0.25,
    })
  );
  // shifted +D/2 in local Z so the wall stays centered in world Z (group origin is at front corner now)
  leftWallMesh.position.set(-0.1, WALL_H / 2, ROOM_D / 2);
  leftWallMesh.receiveShadow = true;
  leftWallGroup.add(leftWallMesh);

  const trimLeft = new T.Mesh(
    new T.BoxGeometry(0.32, 0.22, ROOM_D + 0.2),
    mat(0xfaf2e0, { roughness: 0.85 })
  );
  trimLeft.position.set(0.05, WALL_H + 0.05, ROOM_D / 2);
  leftWallGroup.add(trimLeft);

  // —— 6-row perfume display
  const display = new T.Group();
  const DISP_W = 5.4;       // local width along the wall (will run along Z in world)
  const DISP_BOTTOM = 0.55;
  const DISP_STEP = 0.55;
  const N_ROWS = 6;
  const shelfMatPhys = new T.MeshPhysicalMaterial({
    color: 0xdbe7e6, roughness: 0.06, metalness: 0.0,
    transparent: true, opacity: 0.32, clearcoat: 1.0, reflectivity: 0.6,
  });
  const bracketMat = matGoldDeep();
  function makeShelfBottle(juice) {
    const g = new T.Group();
    const bodyH = 0.42;
    const w = 0.16, d = 0.08;
    const body = new T.Mesh(
      new T.BoxGeometry(w, bodyH, d),
      new T.MeshPhysicalMaterial({
        color: juice, roughness: 0.15, metalness: 0.0,
        transparent: true, opacity: 0.86, clearcoat: 0.8, reflectivity: 0.5,
      })
    );
    body.position.y = bodyH / 2;
    body.castShadow = true;
    g.add(body);
    const collar = new T.Mesh(
      new T.CylinderGeometry(0.04, 0.04, 0.02, 14),
      new T.MeshStandardMaterial({ color: 0xc4c4cc, roughness: 0.25, metalness: 0.9 })
    );
    collar.position.y = bodyH + 0.01;
    g.add(collar);
    const cap = new T.Mesh(
      new T.CylinderGeometry(0.048, 0.054, 0.105, 16),
      new T.MeshStandardMaterial({ color: 0xdcb583, roughness: 0.55 })
    );
    cap.position.y = bodyH + 0.02 + 0.0525;
    cap.castShadow = true;
    g.add(cap);
    const lbl = new T.Mesh(
      new T.PlaneGeometry(w * 0.78, bodyH * 0.46),
      new T.MeshStandardMaterial({ color: 0x123a2a, roughness: 0.6 })
    );
    lbl.position.set(0, bodyH * 0.48, d / 2 + 0.001);
    g.add(lbl);
    const lblGold = new T.Mesh(
      new T.PlaneGeometry(w * 0.5, bodyH * 0.06),
      new T.MeshStandardMaterial({ color: 0xd7b25c, roughness: 0.35, metalness: 0.7 })
    );
    lblGold.position.set(0, bodyH * 0.48, d / 2 + 0.002);
    g.add(lblGold);
    return g;
  }
  const rowJuices = [
    [0xe4dca8, 0xd7c66e, 0xeae3cd, 0xe4dca8, 0xd7c66e, 0xeae3cd, 0xddc998],
    [0xc88a3a, 0xb37526, 0xd99a4a, 0xc88a3a, 0xa56820, 0xb37526, 0xd99a4a],
    [0xd47894, 0xc26882, 0xe28aa4, 0xd47894, 0xb96074, 0xc26882, 0xe28aa4],
    [0x5f8a5a, 0x4d7548, 0x6f9a68, 0x5f8a5a, 0x436540, 0x4d7548, 0x6f9a68],
    [0x2a2326, 0x1a1517, 0x3a3236, 0x2a2326, 0x1a1517, 0x3a3236, 0x2a2326],
    [0x5a2a26, 0x6b3a2a, 0x7a3a30, 0x5a2a26, 0x4a2218, 0x6b3a2a, 0x7a3a30],
  ];
  // Phase 12: pick the first 6 live products (or wrap-around if fewer)
  // to populate the middle slot of each display row. setProducts() may
  // have already grown the list via duplication.
  const featureIds = (function () {
    const ids = (Bot.products || []).map((p) => p && p.id).filter(Boolean);
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < 6; i++) out.push(ids[i % ids.length]);
    return out;
  })();

  for (let r = 0; r < N_ROWS; r++) {
    const y = DISP_BOTTOM + r * DISP_STEP;
    const shelf = new T.Mesh(
      new T.BoxGeometry(DISP_W, 0.028, 0.22), shelfMatPhys
    );
    shelf.position.set(0, y, 0.12);
    shelf.castShadow = true; shelf.receiveShadow = true;
    display.add(shelf);
    [-DISP_W / 2 + 0.3, 0, DISP_W / 2 - 0.3].forEach((bx) => {
      const br = new T.Mesh(new T.BoxGeometry(0.04, 0.05, 0.18), bracketMat);
      br.position.set(bx, y - 0.03, 0.07);
      display.add(br);
    });
    const led = new T.Mesh(
      new T.BoxGeometry(DISP_W - 0.1, 0.008, 0.012),
      new T.MeshBasicMaterial({ color: 0xffe6b4 })
    );
    led.position.set(0, y - 0.018, 0.22);
    display.add(led);
    const juices = rowJuices[r];
    const nBottles = COUNT_BOTTLES_PER_ROW; // Phase 12: 7 default, 4 low-perf
    for (let i = 0; i < nBottles; i++) {
      const fraction = (i + 0.5) / nBottles;
      const x = -DISP_W / 2 + 0.25 + fraction * (DISP_W - 0.5);
      const juice = juices[i % juices.length];
      if (i === Math.floor(nBottles / 2)) {
        const spec = Bot.products.find((p) => p.id === featureIds[r]);
        if (spec) {
          const b = Bot.make(spec, { h: 0.7 });
          b.scale.setScalar(0.7);
          b.position.set(x, y + 0.014, 0.12);
          b.rotation.y = Math.PI;
          display.add(b);
          continue;
        }
      }
      const sb = makeShelfBottle(juice);
      sb.position.set(x, y + 0.014, 0.12 + (Math.random() - 0.5) * 0.025);
      sb.rotation.y = Math.PI + (Math.random() - 0.5) * 0.4;
      display.add(sb);
    }
  }

  function makeSignTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 1024, 256);
    x.fillStyle = '#d7b25c';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = 'italic 700 130px "Cormorant Garamond", serif';
    x.fillText('Dadios', 512, 120);
    x.font = '500 36px "Inter", sans-serif';
    x.fillStyle = '#e2c98a';
    x.fillText('MAISON DE PARFUM', 512, 210);
    return new T.CanvasTexture(c);
  }
  const sign = new T.Mesh(
    new T.PlaneGeometry(2.6, 0.65),
    new T.MeshBasicMaterial({ map: makeSignTexture(), transparent: true })
  );
  sign.position.set(0, DISP_BOTTOM + N_ROWS * DISP_STEP + 0.4, 0.06);
  display.add(sign);

  // mount display on the left wall (group origin at front-left hinge corner)
  // Display centered along the wall = at local Z = D/2.
  display.position.set(0.12, 0, ROOM_D / 2);
  display.rotation.y = Math.PI / 2;
  leftWallGroup.add(display);

  // horizontal tilted gold mirror
  const leftMirrorH = new T.Group();
  const mH = makeGoldFrame(2.6, 0.9);
  mH.rotation.z = -0.05;
  leftMirrorH.add(mH);
  leftMirrorH.position.set(0.13, 4.45, ROOM_D / 2 - 1.6);
  leftMirrorH.rotation.y = Math.PI / 2;
  leftWallGroup.add(leftMirrorH);

  // ====================================================
  // RIGHT WALL — white triangle tile + wall-mounted cabinet
  // (group origin at floor edge of right wall, x=ROOM_W/2)
  // ====================================================
  const rightWallMesh = new T.Mesh(
    new T.BoxGeometry(0.2, WALL_H, ROOM_D),
    new T.MeshStandardMaterial({ color: 0xf3ecdd, map: triTileTex, roughness: 0.95 })
  );
  rightWallMesh.material.map.repeat.set(2, 2);
  rightWallMesh.position.set(0.1, WALL_H / 2, ROOM_D / 2);
  rightWallMesh.receiveShadow = true;
  rightWallGroup.add(rightWallMesh);

  const trimRight = new T.Mesh(
    new T.BoxGeometry(0.32, 0.22, ROOM_D + 0.2),
    mat(0xfaf2e0, { roughness: 0.85 })
  );
  trimRight.position.set(-0.05, WALL_H + 0.05, ROOM_D / 2);
  rightWallGroup.add(trimRight);

  // cabinet
  const cabinet = new T.Group();
  const CB_W = 4.6;
  const CB_H = 1.65;
  const CB_D = 0.42;
  const cabBack = new T.Mesh(
    new T.BoxGeometry(CB_W, CB_H, 0.05),
    new T.MeshStandardMaterial({ color: 0xf3ecdd, map: triTileTex, roughness: 0.95 })
  );
  cabBack.position.set(0, 0, -CB_D / 2 + 0.025);
  cabinet.add(cabBack);
  const cabFrameMat = mat(0xf6efe1, { roughness: 0.75, metalness: 0.05 });
  const cabTop = new T.Mesh(new T.BoxGeometry(CB_W + 0.1, 0.12, CB_D + 0.04), cabFrameMat);
  cabTop.position.set(0, CB_H / 2 - 0.06, 0); cabinet.add(cabTop);
  const cabBot = new T.Mesh(new T.BoxGeometry(CB_W + 0.1, 0.12, CB_D + 0.04), cabFrameMat);
  cabBot.position.set(0, -CB_H / 2 + 0.06, 0); cabinet.add(cabBot);
  const cabDiv1 = new T.Mesh(new T.BoxGeometry(0.08, CB_H, CB_D), cabFrameMat);
  cabDiv1.position.set(-CB_W / 6, 0, 0); cabinet.add(cabDiv1);
  const cabDiv2 = new T.Mesh(new T.BoxGeometry(0.08, CB_H, CB_D), cabFrameMat);
  cabDiv2.position.set(CB_W / 6, 0, 0); cabinet.add(cabDiv2);
  [-CB_W / 2, CB_W / 2].forEach((xx) => {
    const sd = new T.Mesh(new T.BoxGeometry(0.08, CB_H, CB_D), cabFrameMat);
    sd.position.set(xx, 0, 0); cabinet.add(sd);
  });
  const glassShelfMat = new T.MeshPhysicalMaterial({
    color: 0xd6e4e2, roughness: 0.05, metalness: 0.0,
    transparent: true, opacity: 0.25, clearcoat: 1.0, reflectivity: 0.7,
  });
  const shelfYsCab = [-CB_H / 2 + 0.55, -CB_H / 2 + 1.05];
  const cabBayCenters = [-CB_W / 3, 0, CB_W / 3];
  const bayWidth = CB_W / 3;
  shelfYsCab.forEach((y) => {
    cabBayCenters.forEach((bayX) => {
      const sh = new T.Mesh(
        new T.BoxGeometry(bayWidth - 0.18, 0.025, CB_D - 0.1),
        glassShelfMat
      );
      sh.position.set(bayX, y, 0);
      cabinet.add(sh);
    });
  });
  cabBayCenters.forEach((bx) => {
    const br = new T.Mesh(
      new T.BoxGeometry(0.06, 0.28, 0.08),
      mat(COL.black, { roughness: 0.6, metalness: 0.4 })
    );
    br.position.set(bx, -CB_H / 2 - 0.15, 0);
    cabinet.add(br);
  });
  const cabShelfTops = [-CB_H / 2 + 0.06 + 0.06, shelfYsCab[0] + 0.02, shelfYsCab[1] + 0.02];
  let fillerIdx = 0;
  cabBayCenters.forEach((bayX) => {
    cabShelfTops.forEach((shelfY) => {
      for (let i = 0; i < 3; i++) {
        const spec = Bot.filler[(fillerIdx++) % Bot.filler.length];
        const b = Bot.make(spec, { h: 0.58 });
        b.scale.setScalar(0.68);
        const x = bayX - 0.35 + i * 0.35;
        const z = -0.03 + (Math.random() - 0.5) * 0.03;
        b.position.set(x, shelfY, z);
        b.rotation.y = (Math.random() - 0.5) * 0.4;
        cabinet.add(b);
      }
    });
  });
  cabinet.position.set(-CB_D / 2 - 0.1, 3.45, ROOM_D / 2);
  cabinet.rotation.y = -Math.PI / 2;
  rightWallGroup.add(cabinet);

  // ====================================================
  // CEILING SPOTLIGHTS (along front wall, lighting toward room)
  // ====================================================
  function makeSpot(x, z, color = 0xfff0c8) {
    const g = new T.Group();
    const arm = new T.Mesh(
      new T.BoxGeometry(0.08, 0.4, 0.08),
      mat(COL.black, { roughness: 0.6, metalness: 0.4 })
    );
    arm.position.y = -0.2; g.add(arm);
    const head = new T.Mesh(
      new T.CylinderGeometry(0.16, 0.13, 0.28, 18),
      mat(COL.black, { roughness: 0.6, metalness: 0.5 })
    );
    head.position.y = -0.5; g.add(head);
    const bulb = new T.Mesh(
      new T.CylinderGeometry(0.11, 0.11, 0.02, 18),
      new T.MeshBasicMaterial({ color })
    );
    bulb.position.y = -0.65; g.add(bulb);
    const sp = new T.SpotLight(color, 0.4, 7, Math.PI / 5, 0.5, 1.2);
    sp.position.set(0, -0.5, 0);
    sp.target.position.set(0, -3, 0.5);
    g.add(sp); g.add(sp.target);
    g.position.set(x, WALL_H - 0.05, z);
    return g;
  }
  // Phase 12: skip the ceiling spots in low-perf (saves 3 spot lights
  // with shadow casting and the geometry of their housings).
  if (!LOW_PERF) {
    [-2.5, 0, 2.5].forEach((sx) => {
      room.add(makeSpot(sx, -ROOM_D / 2 + 0.5));
    });
  }

  // ====================================================
  // FURNITURE (on floor, not part of any wall hinge group)
  // ====================================================
  const furnitureGroup = new T.Group();
  room.add(furnitureGroup);

  // ——— TABLE
  const table = new T.Group();
  const TABLE_W = 5.2;
  const TABLE_D = 1.05;
  const TABLE_H = 1.32;
  const tableBase = new T.Mesh(
    new T.BoxGeometry(TABLE_W, 0.08, TABLE_D),
    mat(COL.osbBase, { roughness: 0.92 })
  );
  tableBase.position.y = TABLE_H;
  tableBase.castShadow = true; tableBase.receiveShadow = true;
  table.add(tableBase);
  const chipColors = [COL.osbChipA, COL.osbChipB, COL.osbChipC, COL.osbChipD, 0xd6b27a, 0x9a7344];
  const chipGeoms = [
    new T.BoxGeometry(0.13, 0.005, 0.04),
    new T.BoxGeometry(0.18, 0.005, 0.05),
    new T.BoxGeometry(0.09, 0.005, 0.035),
    new T.BoxGeometry(0.22, 0.005, 0.06),
    new T.BoxGeometry(0.11, 0.005, 0.06),
  ];
  for (let i = 0; i < COUNT_TABLE_CHIPS; i++) {
    const geom = chipGeoms[i % chipGeoms.length];
    const ch = new T.Mesh(geom, mat(chipColors[i % chipColors.length], { roughness: 0.95 }));
    ch.position.set(
      (Math.random() - 0.5) * (TABLE_W - 0.1),
      TABLE_H + 0.04 + Math.random() * 0.002,
      (Math.random() - 0.5) * (TABLE_D - 0.1)
    );
    ch.rotation.y = Math.random() * Math.PI;
    table.add(ch);
  }
  const tableEdge = new T.Mesh(
    new T.BoxGeometry(TABLE_W, 0.04, 0.02),
    mat(COL.black, { roughness: 0.5, metalness: 0.5 })
  );
  tableEdge.position.set(0, TABLE_H - 0.02, TABLE_D / 2);
  table.add(tableEdge);
  [
    [-TABLE_W / 2 + 0.1, -TABLE_D / 2 + 0.1],
    [TABLE_W / 2 - 0.1, -TABLE_D / 2 + 0.1],
    [-TABLE_W / 2 + 0.1, TABLE_D / 2 - 0.1],
    [TABLE_W / 2 - 0.1, TABLE_D / 2 - 0.1],
  ].forEach(([x, z]) => {
    const leg = new T.Mesh(
      new T.BoxGeometry(0.06, TABLE_H, 0.06),
      mat(COL.black, { roughness: 0.5, metalness: 0.55 })
    );
    leg.position.set(x, TABLE_H / 2, z);
    leg.castShadow = true;
    table.add(leg);
  });
  const tableTopY = TABLE_H + 0.045;
  // Phase 12: 5 bottles on the table, drawn from the live catalogue.
  const tableProducts = (function () {
    const ids = (Bot.products || []).map((p) => p && p.id).filter(Boolean);
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < 5; i++) out.push(ids[i % ids.length]);
    return out;
  })();
  tableProducts.forEach((id, i) => {
    const spec = Bot.products.find((p) => p.id === id);
    const b = Bot.make(spec);
    const x = -TABLE_W / 2 + 0.7 + i * ((TABLE_W - 2.2) / (tableProducts.length - 1));
    const z = (i % 2 === 0 ? -0.18 : -0.02) + (Math.random() - 0.5) * 0.04;
    b.position.set(x, tableTopY, z);
    b.rotation.y = -0.35 + (Math.random() - 0.5) * 0.2;
    table.add(b);
  });
  // gift box
  function makeGiftBoxTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#6a3f24');
    g.addColorStop(0.5, '#7a4b2a');
    g.addColorStop(1, '#5a3520');
    x.fillStyle = g; x.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 80; i++) {
      x.strokeStyle = `rgba(40, 22, 10, ${0.05 + Math.random() * 0.12})`;
      x.lineWidth = 0.5 + Math.random();
      x.beginPath();
      const y = Math.random() * 128;
      x.moveTo(0, y);
      x.bezierCurveTo(170, y + (Math.random() - 0.5) * 6, 340, y + (Math.random() - 0.5) * 6, 512, y);
      x.stroke();
    }
    x.fillStyle = '#f3e7c8';
    x.font = '600 38px "Inter", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('DADIOS.FRAGRANCES', 256, 64);
    x.strokeStyle = '#e2c98a';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(160, 92); x.lineTo(352, 92);
    x.stroke();
    const tex = new T.CanvasTexture(c);
    tex.anisotropy = 8;
    return tex;
  }
  const giftBox = new T.Group();
  const GB_W = 1.05, GB_D = 0.65, GB_H_BACK = 0.62, GB_H_FRONT = 0.42;
  const gbBody = new T.Mesh(
    new T.BoxGeometry(GB_W, (GB_H_BACK + GB_H_FRONT) / 2, GB_D),
    new T.MeshStandardMaterial({ color: COL.giftWood, roughness: 0.65 })
  );
  gbBody.position.y = (GB_H_BACK + GB_H_FRONT) / 4;
  gbBody.castShadow = true;
  giftBox.add(gbBody);
  const labelPlane = new T.Mesh(
    new T.PlaneGeometry(GB_W * 0.95, 0.32),
    new T.MeshStandardMaterial({ map: makeGiftBoxTexture(), roughness: 0.55 })
  );
  labelPlane.rotation.x = -0.42;
  labelPlane.position.set(0, (GB_H_BACK + GB_H_FRONT) / 2 + 0.08, 0.04);
  giftBox.add(labelPlane);
  giftBox.position.set(TABLE_W / 2 - 0.75, tableTopY, 0.05);
  giftBox.rotation.y = -0.12;
  table.add(giftBox);

  table.position.set(ROOM_W / 2 - TABLE_D / 2 - 0.15, 0, 0);
  table.rotation.y = -Math.PI / 2;
  furnitureGroup.add(table);

  // ——— CHAIR (bistro)
  const chair = new T.Group();
  const SEAT_Y = 0.78, SEAT_R = 0.30, BACK_TOP_Y = 1.55;
  const blackMat = mat(COL.black, { roughness: 0.5, metalness: 0.25 });
  const seat = new T.Mesh(
    new T.CylinderGeometry(SEAT_R, SEAT_R, 0.05, 26), blackMat
  );
  seat.position.y = SEAT_Y; seat.castShadow = true;
  chair.add(seat);
  const seatRing = new T.Mesh(
    new T.TorusGeometry(SEAT_R - 0.01, 0.018, 8, 28), blackMat
  );
  seatRing.rotation.x = Math.PI / 2;
  seatRing.position.y = SEAT_Y - 0.06;
  chair.add(seatRing);
  const legAngles = [Math.PI * 0.22, Math.PI * 0.78, Math.PI * 1.22, Math.PI * 1.78];
  legAngles.forEach((a) => {
    const isBack = (a > Math.PI * 0.5 && a < Math.PI * 1.5);
    const legBottomR = SEAT_R + 0.04;
    const legTopR = SEAT_R - 0.04;
    const bx = Math.cos(a) * legBottomR;
    const bz = Math.sin(a) * legBottomR;
    const tx = Math.cos(a) * legTopR;
    const tz = Math.sin(a) * legTopR;
    const dy = SEAT_Y - 0.025;
    const len = Math.sqrt((bx - tx) ** 2 + dy ** 2 + (bz - tz) ** 2);
    const leg = new T.Mesh(
      new T.CylinderGeometry(0.024, 0.028, len, 10), blackMat
    );
    leg.position.set((bx + tx) / 2, dy / 2, (bz + tz) / 2);
    const dir = new T.Vector3(tx - bx, dy, tz - bz).normalize();
    const up = new T.Vector3(0, 1, 0);
    const q = new T.Quaternion().setFromUnitVectors(up, dir);
    leg.quaternion.copy(q);
    leg.castShadow = true;
    chair.add(leg);
    if (isBack) {
      const postLen = BACK_TOP_Y - SEAT_Y;
      const post = new T.Mesh(
        new T.CylinderGeometry(0.022, 0.024, postLen, 10), blackMat
      );
      post.position.set(tx, SEAT_Y + postLen / 2, tz);
      chair.add(post);
    }
  });
  const stretcher = new T.Mesh(
    new T.TorusGeometry(SEAT_R + 0.005, 0.016, 8, 28), blackMat
  );
  stretcher.rotation.x = Math.PI / 2;
  stretcher.position.y = SEAT_Y - 0.36;
  chair.add(stretcher);
  const backRail = new T.Mesh(
    new T.TorusGeometry(SEAT_R - 0.04, 0.024, 10, 22, Math.PI), blackMat
  );
  backRail.rotation.x = -Math.PI / 2;
  backRail.position.set(0, BACK_TOP_Y - 0.01, -SEAT_R + 0.04);
  chair.add(backRail);
  const backPostX = Math.cos(Math.PI * 0.78) * (SEAT_R - 0.04);
  for (let i = -1; i <= 1; i++) {
    const sp = new T.Mesh(
      new T.CylinderGeometry(0.015, 0.015, BACK_TOP_Y - SEAT_Y - 0.04, 8), blackMat
    );
    const tFraction = (i + 1) / 2;
    const x = -Math.abs(backPostX) + 2 * Math.abs(backPostX) * tFraction;
    sp.position.set(x, SEAT_Y + (BACK_TOP_Y - SEAT_Y - 0.04) / 2, -SEAT_R + 0.06);
    chair.add(sp);
  }
  chair.position.set(ROOM_W / 2 - TABLE_D - 0.55, 0, -0.3);
  chair.rotation.y = Math.PI / 2;
  furnitureGroup.add(chair);

  // ——— BLOSSOM TREE — front-right corner
  const tree = new T.Group();
  const pot = new T.Mesh(
    new T.CylinderGeometry(0.48, 0.4, 0.65, 24), mat(COL.pot, { roughness: 0.85 })
  );
  pot.position.y = 0.325;
  pot.castShadow = true; pot.receiveShadow = true;
  tree.add(pot);
  const rim = new T.Mesh(
    new T.CylinderGeometry(0.5, 0.5, 0.05, 24), mat(0xe5d8c3, { roughness: 0.8 })
  );
  rim.position.y = 0.65;
  tree.add(rim);
  const soil = new T.Mesh(
    new T.CylinderGeometry(0.46, 0.46, 0.04, 24), mat(0xede5cf, { roughness: 1 })
  );
  soil.position.y = 0.66;
  tree.add(soil);
  for (let i = 0; i < COUNT_PEBBLES; i++) {
    const peb = new T.Mesh(
      new T.SphereGeometry(0.045 + Math.random() * 0.025, 8, 6),
      mat(0xeae3cd, { roughness: 1 })
    );
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.38;
    peb.position.set(Math.cos(a) * r, 0.69, Math.sin(a) * r);
    tree.add(peb);
  }
  const trunk1 = new T.Mesh(
    new T.CylinderGeometry(0.06, 0.09, 1.0, 12), mat(COL.trunk, { roughness: 0.85 })
  );
  trunk1.position.set(0, 0.66 + 0.5, 0);
  trunk1.castShadow = true;
  tree.add(trunk1);
  const trunk2 = new T.Mesh(
    new T.CylinderGeometry(0.05, 0.06, 0.7, 12), mat(COL.trunk, { roughness: 0.85 })
  );
  trunk2.position.set(0.04, 0.66 + 1.0 + 0.3, 0.02);
  trunk2.rotation.z = -0.08;
  trunk2.castShadow = true;
  tree.add(trunk2);
  const stick = new T.Mesh(
    new T.CylinderGeometry(0.02, 0.03, 1.6, 8), mat(COL.trunk, { roughness: 0.9 })
  );
  stick.position.set(0.08, 2.6, -0.05);
  stick.rotation.z = -0.12;
  tree.add(stick);
  const foliage = new T.Group();
  const blossomGeom1 = new T.SphereGeometry(0.095, 8, 6);
  const blossomGeom2 = new T.SphereGeometry(0.14, 10, 8);
  const blossomColors = [COL.blossomA, COL.blossomB, COL.blossomC, 0xeedfc6, 0xf8ecd5];
  for (let i = 0; i < COUNT_BLOSSOMS; i++) {
    const c = blossomColors[i % blossomColors.length];
    const m = new T.Mesh(
      i % 4 === 0 ? blossomGeom2 : blossomGeom1,
      mat(c, { roughness: 0.78 })
    );
    const phi = Math.random() * Math.PI * 2;
    const theta = Math.acos(2 * Math.random() - 1);
    const r = 0.55 + Math.random() * 0.3;
    m.position.set(
      Math.cos(phi) * Math.sin(theta) * r,
      Math.cos(theta) * r * 1.05,
      Math.sin(phi) * Math.sin(theta) * r
    );
    m.castShadow = true;
    foliage.add(m);
  }
  foliage.position.y = 2.35;
  tree.add(foliage);
  tree.position.set(ROOM_W / 2 - 0.6, 0.08, ROOM_D / 2 - 0.9);
  furnitureGroup.add(tree);

  // ====================================================
  // RAYCAST INTERACTIONS
  // ====================================================
  const raycaster = new T.Raycaster();
  const pointer = new T.Vector2();
  let hovered = null;
  let selected = null;
  const productRoots = [];
  scene.traverse((o) => { if (o.userData && o.userData.product) productRoots.push(o); });
  const rayMeshes = [];
  productRoots.forEach((root) => { root.traverse((c) => { if (c.isMesh) rayMeshes.push(c); }); });

  function setPointerFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX != null ? e.clientX : e.touches?.[0]?.clientX);
    const cy = (e.clientY != null ? e.clientY : e.touches?.[0]?.clientY);
    const x = cx - rect.left, y = cy - rect.top;
    pointer.x = (x / rect.width) * 2 - 1;
    pointer.y = -(y / rect.height) * 2 + 1;
    return { x, y };
  }
  function findProductRoot(mesh) {
    let cur = mesh;
    while (cur && !cur.userData?.product) cur = cur.parent;
    return cur;
  }
  function hoverProduct(root) {
    if (hovered === root) return;
    if (hovered) hovered.scale.setScalar(hovered === selected ? 1.1 : 1);
    hovered = root;
    if (hovered) {
      hovered.scale.setScalar(hovered === selected ? 1.14 : 1.06);
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = '';
    }
  }
  function onMove(e) {
    const { x, y } = setPointerFromEvent(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(rayMeshes, false);
    if (hits.length > 0) {
      const root = findProductRoot(hits[0].object);
      hoverProduct(root);
      // Phase 12: tooltip is for cursor users only — touch devices get
      // the info panel after the tap instead.
      if (root?.userData?.product && !TOUCH_ONLY) {
        tooltip.textContent = root.userData.product.name;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
        tooltip.classList.add('show');
      }
    } else {
      hoverProduct(null);
      tooltip.classList.remove('show');
    }
  }
  function onClick(e) {
    setPointerFromEvent(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(rayMeshes, false);
    if (hits.length > 0) {
      const root = findProductRoot(hits[0].object);
      if (root?.userData?.product) {
        selectProduct(root);
        // Phase 12: on mobile, scroll the info panel into view so the user
        // doesn't miss it under the scene.
        if (TOUCH_ONLY) {
          try {
            productEl.scrollIntoView({ behavior: PREFERS_REDUCED ? 'auto' : 'smooth', block: 'center' });
          } catch {}
        }
      }
    }
  }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', () => {
    hoverProduct(null);
    tooltip.classList.remove('show');
  });
  let downX = 0, downY = 0, downT = 0;
  canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; downT = Date.now();
    wrap.classList.add('grabbing');
  });
  canvas.addEventListener('pointerup', (e) => {
    wrap.classList.remove('grabbing');
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.hypot(dx, dy) < 5 && Date.now() - downT < 350) onClick(e);
  });

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function selectProduct(root) {
    const p = root.userData.product;
    if (selected && selected !== root) selected.scale.setScalar(1);
    selected = root;
    selected.scale.setScalar(1.14);
    const slug = String(p.slug || p.id || '').trim();
    productEl.innerHTML = `
      <div class="product-eyebrow">${escHtml(p.family)} &middot; ${escHtml(p.year)}</div>
      <div class="product-name">${escHtml(p.name)}</div>
      <div class="product-notes">
        ${(p.notes || []).map((n) => `<span class="note-chip">${escHtml(n)}</span>`).join('')}
      </div>
      <div class="product-desc">${escHtml(p.desc)}</div>
      <div class="product-meta">
        <div class="price">${escHtml(p.price)}<span class="vol">${escHtml(p.vol)}</span></div>
        <button class="cta" data-slug="${escHtml(slug)}" data-name="${escHtml(p.name)}" data-price="${escHtml(p.price50ml || 0)}">Ajouter au panier — 50ml</button>
      </div>
    `;
    const cta = productEl.querySelector('.cta');
    if (cta && slug) {
      cta.addEventListener('click', (e) => {
        e.preventDefault();
        try {
          if (window.cart && typeof window.cart.addItem === 'function') {
            window.cart.addItem({
              slug,
              name: p.name,
              size: '50ml',
              price: Number(p.price50ml) || 0,
              qty: 1,
            });
            if (typeof window.cart.showAddedToast === 'function') {
              window.cart.showAddedToast(`Ajouté au panier ✓ ${p.name} (50ml)`);
            }
            cta.classList.add('added');
            cta.textContent = '✓ Ajouté au panier';
            setTimeout(() => {
              cta.classList.remove('added');
              cta.textContent = 'Ajouter au panier — 50ml';
            }, 1800);
          }
        } catch {}
      });
    }
  }

  // ====================================================
  // UNFOLD ANIMATION
  // ====================================================
  let unfolded = false;
  let unfoldProgress = 0;          // 0 = closed, 1 = fully unfolded
  let unfoldTarget = 0;
  let unfoldStartT = 0;

  // Pre-saved "room mode" camera params; "panorama mode" computed below.
  const roomCam = camStart.clone();
  const roomTarget = new T.Vector3(0, 1.8, -0.3);

  // Panorama view — in front of the unfolded triptych, framing all 3 walls in a row
  const panoCam = new T.Vector3(0, 3.0, 14);
  const panoTarget = new T.Vector3(0, 2.4, -ROOM_D / 2);
  const FOV_ROOM = 28;
  const FOV_PANO = 62;

  // Cached starting camera state for tween
  let camStartTween = roomCam.clone();
  let targetStartTween = roomTarget.clone();
  let camEndTween = roomCam.clone();
  let targetEndTween = roomTarget.clone();

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  btnUnfold.addEventListener('click', () => {
    unfolded = !unfolded;
    unfoldTarget = unfolded ? 1 : 0;
    unfoldStartT = performance.now();
    btnUnfold.classList.toggle('active', unfolded);
    camStartTween.copy(camera.position);
    targetStartTween.copy(controls.target);
    camEndTween.copy(unfolded ? panoCam : roomCam);
    targetEndTween.copy(unfolded ? panoTarget : roomTarget);
    // disable controls during the transition; tick() re-enables when done
    controls.enabled = false;
    controls.autoRotate = false;
  });

  // helper: set all materials inside a group to a given opacity
  function setGroupOpacity(g, op) {
    g.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mm) => {
          if (mm.userData._origOpacity == null) {
            mm.userData._origOpacity = mm.opacity != null ? mm.opacity : 1;
            mm.userData._origTransparent = mm.transparent;
          }
          mm.transparent = true;
          mm.opacity = mm.userData._origOpacity * op;
          mm.depthWrite = op > 0.95;
        });
      }
    });
  }

  // ——— Buttons (auto, reset) ———
  let autoOn = true;
  btnAuto.classList.add('active');
  btnAuto.addEventListener('click', () => {
    autoOn = !autoOn;
    if (!unfolded) controls.autoRotate = autoOn;
    btnAuto.classList.toggle('active', autoOn);
  });
  btnReset.addEventListener('click', () => {
    if (unfolded) {
      // first un-unfold, then reset will trigger the panorama→room transition
      btnUnfold.click();
      return;
    }
    const start = camera.position.clone();
    const tStart = controls.target.clone();
    const tEnd = roomTarget.clone();
    const t0 = performance.now();
    function step() {
      const k = Math.min(1, (performance.now() - t0) / 700);
      const e = easeInOut(k);
      camera.position.lerpVectors(start, roomCam, e);
      controls.target.lerpVectors(tStart, tEnd, e);
      controls.update();
      if (k < 1) requestAnimationFrame(step);
    }
    step();
  });

  setTimeout(() => hint.classList.add('show'), 600);
  setTimeout(() => hint.classList.remove('show'), 5400);

  let idleTimer;
  controls.addEventListener('start', () => {
    if (autoOn && !unfolded) controls.autoRotate = false;
    clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (autoOn && !unfolded) controls.autoRotate = true;
    }, 2200);
  });

  // ——— Resize ———
  function resize() {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ——— Animate ———
  const clock = new T.Clock();
  productRoots.forEach((p) => { p.userData._baseY = p.position.y; });
  const UNFOLD_DUR = 1100; // ms

  function tick() {
    const t = clock.getElapsedTime();

    // unfold transition progress
    const now = performance.now();
    const k = Math.min(1, (now - unfoldStartT) / UNFOLD_DUR);
    const target = unfoldTarget;
    const current = (target === 1) ? easeInOut(k) : (1 - easeInOut(k));
    // when transitioning, lerp progress from the value at click-time toward target.
    // simpler: blend purely on time when toggling
    unfoldProgress = (target === 1)
      ? easeInOut(k)
      : 1 - easeInOut(k);

    // apply rotations to the wall groups (triptych hinge)
    const ang = unfoldProgress * Math.PI / 2;
    leftWallGroup.rotation.y = -ang;          // left wall hinges out to -X, ends up facing +Z
    rightWallGroup.rotation.y = ang;          // right wall hinges out to +X
    // front wall stays put (it's the spine of the triptych)

    // animate camera FOV between room (28°) and pano (62°)
    const newFov = FOV_ROOM + (FOV_PANO - FOV_ROOM) * unfoldProgress;
    if (Math.abs(camera.fov - newFov) > 0.01) {
      camera.fov = newFov;
      camera.updateProjectionMatrix();
    }

    // camera tween during transition (controls disabled while transitioning)
    if (k < 1) {
      const e = easeInOut(k);
      camera.position.lerpVectors(camStartTween, camEndTween, e);
      controls.target.lerpVectors(targetStartTween, targetEndTween, e);
      camera.lookAt(controls.target);
    } else if (k >= 1 && !controls.enabled) {
      // transition just finished — settle camera to exact end state and re-enable controls
      camera.position.copy(unfolded ? panoCam : roomCam);
      controls.target.copy(unfolded ? panoTarget : roomTarget);
      camera.lookAt(controls.target);
      controls.enabled = true;
      if (unfolded) {
        controls.enableRotate = false;
        controls.autoRotate = false;
      } else {
        controls.enableRotate = true;
        if (autoOn) controls.autoRotate = true;
      }
    }

    // fade furniture in/out — visible in room mode, mostly hidden in panorama
    const furnitureVis = 1 - unfoldProgress * 0.85;
    setGroupOpacity(furnitureGroup, furnitureVis);

    // Phase 12: gentle blossom sway disabled under reduced-motion.
    if (!PREFERS_REDUCED && unfoldProgress < 0.9) {
      foliage.rotation.z = Math.sin(t * 0.85) * 0.045;
      foliage.rotation.x = Math.cos(t * 0.6) * 0.03;
      foliage.position.y = 2.35 + Math.sin(t * 0.7) * 0.02;
    }

    productRoots.forEach((p) => {
      // Phase 12: skip the hover float under reduced-motion (keeps the
      // scale-up cue but stops the bobbing).
      if (!PREFERS_REDUCED && p === hovered && unfoldProgress < 0.1) {
        p.position.y = (p.userData._baseY ?? p.position.y) + Math.sin(t * 4) * 0.015 + 0.04;
      } else if (p.userData._baseY != null) {
        p.position.y = p.userData._baseY;
      }
    });

    if (controls.enabled) controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  // Phase 12: one-time ready signal. BoutiqueScene.astro listens for
  // this on the wrap to fade the card in and hide the loader.
  function fireReadyOnce() {
    if (fireReadyOnce._fired) return;
    fireReadyOnce._fired = true;
    try {
      wrap.dispatchEvent(new CustomEvent('dadios-scene-ready', { bubbles: true }));
    } catch {}
  }
  renderer.render(scene, camera);
  fireReadyOnce();
  tick();
})();
