/* Dadios — bottle factory + product catalogue v3 (Phase 12)
 *
 * Phase-12 adaptation of the original gist version:
 *   - The hardcoded `products` array is kept as a FALLBACK so the scene
 *     still renders if /api/products is down or returns 0 entries.
 *   - At runtime, scene.js calls DadiosBottles.setProducts(arr) to swap
 *     in the live catalogue from the Worker. After that call, every
 *     subsequent Bot.products.find(...) sees the real product list.
 *   - Also exports deduceJuiceColor(text) and a small mapping helper so
 *     other code (and tests) can reuse the same juice-color rules.
 *
 * Everything else (label texture, glass mat, Dadios flacon geometry) is
 * unchanged.
 */

(function () {
  const T = THREE;

  // ——— Shared label texture (Dadios brand) ———
  let _labelTex = null;
  function getLabelTexture() {
    if (_labelTex) return _labelTex;
    const c = document.createElement('canvas');
    c.width = 320; c.height = 400;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(160, 200, 20, 160, 200, 240);
    g.addColorStop(0, '#13533c');
    g.addColorStop(1, '#0a2d20');
    x.fillStyle = g;
    x.fillRect(0, 0, 320, 400);
    for (let i = 0; i < 1200; i++) {
      x.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
      x.fillRect(Math.random() * 320, Math.random() * 400, 1, 1);
    }
    x.strokeStyle = '#dcb352';
    x.lineWidth = 4;
    x.strokeRect(14, 16, 292, 368);
    x.lineWidth = 1.4;
    x.strokeRect(24, 26, 272, 348);
    x.fillStyle = '#dcb352';
    function corner(cx, cy, flipX, flipY) {
      x.save();
      x.translate(cx, cy);
      x.scale(flipX, flipY);
      x.beginPath();
      x.moveTo(0, 0);
      x.bezierCurveTo(12, 0, 22, 4, 28, 14);
      x.lineTo(26, 14);
      x.bezierCurveTo(20, 6, 12, 4, 0, 4);
      x.closePath();
      x.fill();
      x.fillRect(2, 8, 6, 1.5);
      x.restore();
    }
    corner(28, 30, 1, 1);
    corner(292, 30, -1, 1);
    corner(28, 370, 1, -1);
    corner(292, 370, -1, -1);
    x.fillStyle = '#f1c768';
    x.textAlign = 'center';
    x.font = 'italic 700 78px "Cormorant Garamond", "Times New Roman", serif';
    x.fillText('Dadios', 160, 175);
    x.font = 'italic 500 36px "Cormorant Garamond", serif';
    x.fillStyle = '#e6b95a';
    x.fillText('Fragrance', 160, 220);
    x.strokeStyle = '#dcb352';
    x.lineWidth = 1.2;
    x.beginPath();
    x.moveTo(60, 260);
    x.lineTo(260, 260);
    x.stroke();
    x.fillStyle = '#dcb352';
    [60, 160, 260].forEach((px) => {
      x.beginPath();
      x.moveTo(px, 256); x.lineTo(px + 4, 260); x.lineTo(px, 264); x.lineTo(px - 4, 260);
      x.closePath();
      x.fill();
    });
    x.font = '500 16px "Cormorant Garamond", serif';
    x.fillStyle = '#e6b95a';
    // Phase 12 typo fix: 'Timless' -> 'Timeless'
    x.fillText('Essence of Timeless Elegance', 160, 295);
    x.fillStyle = '#dcb352';
    [120, 200].forEach((px) => {
      x.beginPath();
      x.arc(px, 330, 2, 0, Math.PI * 2);
      x.fill();
    });
    const tex = new T.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    _labelTex = tex;
    return tex;
  }

  // ——— Shared materials cache ———
  let _glassMat = null;
  function glassShellMat() {
    if (_glassMat) return _glassMat;
    _glassMat = new T.MeshPhysicalMaterial({
      color: 0xf0f3ee, roughness: 0.06, metalness: 0.0,
      transparent: true, opacity: 0.22, clearcoat: 1.0,
      clearcoatRoughness: 0.04, reflectivity: 0.7, envMapIntensity: 1.0,
    });
    return _glassMat;
  }
  function liquidMat(color, opacity = 0.85) {
    return new T.MeshStandardMaterial({
      color, roughness: 0.3, metalness: 0.0, transparent: true, opacity,
    });
  }
  let _collarMat = null;
  function collarMat() {
    if (_collarMat) return _collarMat;
    _collarMat = new T.MeshStandardMaterial({ color: 0xc4c4cc, roughness: 0.22, metalness: 0.95 });
    return _collarMat;
  }
  let _woodCapMat = null;
  function woodCapMat() {
    if (_woodCapMat) return _woodCapMat;
    _woodCapMat = new T.MeshStandardMaterial({ color: 0xdcb583, roughness: 0.55, metalness: 0.0 });
    return _woodCapMat;
  }
  let _labelMat = null;
  function labelMat() {
    if (_labelMat) return _labelMat;
    _labelMat = new T.MeshStandardMaterial({ map: getLabelTexture(), roughness: 0.55, metalness: 0.0 });
    return _labelMat;
  }

  function makeDadiosBottle(juiceColor, opts = {}) {
    const h = opts.h ?? 0.95;
    const w = opts.w ?? 0.34;
    const d = opts.d ?? 0.18;
    const bodyH = h * 0.72;
    const capH = h * 0.22;
    const g = new T.Group();
    const liquidH = bodyH * 0.82;
    const liquid = new T.Mesh(new T.BoxGeometry(w * 0.92, liquidH, d * 0.86), liquidMat(juiceColor));
    liquid.position.y = liquidH / 2 + 0.01;
    g.add(liquid);
    const tube = new T.Mesh(
      new T.CylinderGeometry(0.008, 0.008, bodyH * 0.85, 8),
      new T.MeshStandardMaterial({ color: 0xeeeae0, roughness: 0.5 })
    );
    tube.position.set(0, bodyH * 0.85 / 2 + 0.01, 0);
    g.add(tube);
    const shell = new T.Mesh(new T.BoxGeometry(w, bodyH, d), glassShellMat());
    shell.position.y = bodyH / 2;
    shell.castShadow = true;
    shell.renderOrder = 2;
    g.add(shell);
    const rim = new T.Mesh(new T.BoxGeometry(w * 0.6, 0.04, d * 0.6), glassShellMat());
    rim.position.y = bodyH + 0.02;
    g.add(rim);
    const collar = new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 0.04, 20), collarMat());
    collar.position.y = bodyH + 0.04 + 0.02;
    g.add(collar);
    const cap = new T.Mesh(new T.CylinderGeometry(0.105, 0.115, capH, 22), woodCapMat());
    cap.position.y = bodyH + 0.06 + capH / 2;
    cap.castShadow = true;
    g.add(cap);
    const capTop = new T.Mesh(
      new T.CylinderGeometry(0.105, 0.105, 0.018, 22),
      new T.MeshStandardMaterial({ color: 0xeac896, roughness: 0.45 })
    );
    capTop.position.y = bodyH + 0.06 + capH - 0.009;
    g.add(capTop);
    const labelW = w * 0.78;
    const labelH = bodyH * 0.48;
    const label = new T.Mesh(new T.PlaneGeometry(labelW, labelH), labelMat());
    label.position.set(0, bodyH * 0.42, d / 2 + 0.002);
    g.add(label);
    const labelBack = new T.Mesh(new T.PlaneGeometry(labelW, labelH), labelMat());
    labelBack.position.set(0, bodyH * 0.42, -d / 2 - 0.002);
    labelBack.rotation.y = Math.PI;
    g.add(labelBack);
    return g;
  }

  // ——— Juice colour deduction (Phase 12) ———
  // Case-insensitive keyword match against a "family + name" haystack.
  // First rule that matches wins. Used both by setProducts (when mapping
  // /api/products into the bottle factory's expected shape) and exposed
  // on window.DadiosBottles for any consumer that needs it.
  const COLOR_RULES = [
    [['oriental', 'oud', 'ambre', 'amber'], 0xc88a3a],
    [['floral', 'rose', 'fleur', 'jasmin'], 0xd47894],
    [['boisé', 'boise', 'woody', 'cèdre', 'cedre', 'santal'], 0x8a6534],
    [['vert', 'green', 'fougère', 'fougere'], 0x5f8a5a],
    [['cuir', 'leather'], 0x5a2a26],
    [['frais', 'aquatique', 'citrus', 'bergamote'], 0xe4dca8],
    [['vanille', 'gourmand', 'sucré', 'sucre'], 0xeae3cd],
    [['musc', 'poudré', 'poudre'], 0xf3e9c8],
    [['épicé', 'epice', 'spicy', 'poivre'], 0x8a3a2a],
    [['nuit', 'noir', 'black'], 0x2a2326],
  ];
  function deduceJuiceColor(text) {
    const s = String(text == null ? '' : text).toLowerCase();
    for (const [keywords, color] of COLOR_RULES) {
      if (keywords.some((k) => s.includes(k))) return color;
    }
    return 0xd7c66e; // default pale gold
  }

  // ——— Note translation EN → FR for olfactive notes coming from old data ———
  const NOTE_FR = {
    'bergamot': 'Bergamote',
    'cedar': 'Cèdre',
    'white musk': 'Musc blanc',
    'fig leaf': 'Feuille de figuier',
    'vetiver': 'Vétiver',
    'cardamom': 'Cardamome',
    'cambodian oud': 'Oud cambodgien',
    'saffron': 'Safran',
    'black amber': 'Ambre noir',
    'labdanum': 'Labdanum',
    'honey': 'Miel',
    'tonka': 'Fève tonka',
    'damask rose': 'Rose de Damas',
    'sea salt': 'Sel marin',
    'neroli': 'Néroli',
    'driftwood': 'Bois flotté',
    'iris': 'Iris',
    'black leather': 'Cuir noir',
    'patchouli': 'Patchouli',
    'black fig': 'Figue noire',
    'pink pepper': 'Poivre rose',
    'tuberose': 'Tubéreuse',
    'gardenia': 'Gardénia',
    'sandalwood': 'Bois de santal',
    'birch tar': 'Goudron de bouleau',
    'suede': 'Daim',
  };
  function frenchifyNote(n) {
    const key = String(n || '').toLowerCase().trim();
    return NOTE_FR[key] || n;
  }

  // ——— Fallback product catalogue (kept for offline / API-down case) ———
  // Same shape the scene.js feature/table lookups expect.
  const FALLBACK_PRODUCTS = [
    { id: 'eau-de-cedre', name: 'Eau de Cèdre',     family: 'Boisé / Citrus',     year: 2021, notes: ['Bergamote', 'Cèdre', 'Musc blanc'],     desc: 'Lumière à travers une cédraie, fraîche aux chevilles, chaude aux épaules.', price: '180 DT', vol: '50 ML', juice: 0xe4dca8, h: 0.95 },
    { id: 'nuit-verte',   name: 'Nuit Verte',       family: 'Vert / Boisé',       year: 2022, notes: ['Feuille de figuier', 'Vétiver', 'Cardamome'], desc: 'Le retour à travers le verger, le dîner terminé.', price: '220 DT', vol: '50 ML', juice: 0x5f8a5a, h: 0.95 },
    { id: 'oud-nocturne', name: 'Oud Nocturne',     family: 'Oriental / Boisé',   year: 2020, notes: ['Oud cambodgien', 'Safran', 'Ambre noir'], desc: "Fumée d'un petit feu, entretenu longtemps.", price: '310 DT', vol: '50 ML', juice: 0x5a2a26, h: 0.95 },
    { id: 'ambre-dore',   name: 'Ambre Doré',       family: 'Ambré',              year: 2019, notes: ['Labdanum', 'Miel', 'Fève tonka'],          desc: 'Résine chaude, miel lent, et la dernière lumière de l\'après-midi.', price: '195 DT', vol: '50 ML', juice: 0xc88a3a, h: 0.95 },
    { id: 'rose-ete',     name: "Rose d'Été",       family: 'Floral',             year: 2021, notes: ['Rose de Damas', 'Bergamote', 'Musc blanc'], desc: 'Un jardin du matin après la pluie — doux, ensoleillé, rose sans détour.', price: '180 DT', vol: '50 ML', juice: 0xd47894, h: 0.95 },
    { id: 'fleur-sel',    name: 'Fleur de Sel',     family: 'Aquatique / Minéral', year: 2023, notes: ['Sel marin', 'Néroli', 'Bois flotté'],     desc: "Une chemise de lin pâle séchant au vent du littoral.", price: '165 DT', vol: '50 ML', juice: 0xeae3cd, h: 0.95 },
  ];
  let products = FALLBACK_PRODUCTS.slice();

  // ——— Filler juice tints for decorative shelf bottles ———
  const filler = [
    { juice: 0xe4dca8 }, { juice: 0x5f8a5a }, { juice: 0x5a2a26 },
    { juice: 0xc88a3a }, { juice: 0xd47894 }, { juice: 0xeae3cd },
    { juice: 0x2a2326 }, { juice: 0x8a3a2a }, { juice: 0xf3e9c8 },
    { juice: 0x6a3a1f }, { juice: 0xd7c66e }, { juice: 0x4a5a7a },
  ];

  /**
   * Convert one raw /api/products record into the shape the bottle
   * factory + scene.js info panel expect. Server stays the source of
   * truth — this is a pure transform.
   *
   * Sizes come from the global products.json (passed in); per-product
   * pricing isn't part of our schema, so every flacon shows the 50 ML
   * price by default.
   */
  function buildSceneProduct(raw, sizes) {
    const get = (code, fallback) => {
      const s = (Array.isArray(sizes) ? sizes : []).find((x) => x && x.code === code);
      return s ? Number(s.price) : fallback;
    };
    const price50 = get('50ml', 20);
    const price20 = get('20ml', 10);
    const notesRaw = [
      ...(Array.isArray(raw.topNotes)   ? raw.topNotes   : []),
      ...(Array.isArray(raw.heartNotes) ? raw.heartNotes : []),
      ...(Array.isArray(raw.baseNotes)  ? raw.baseNotes  : []),
    ].filter(Boolean).slice(0, 4);
    const notes = notesRaw.length ? notesRaw.map(frenchifyNote) : ['—'];
    let year = 2024;
    if (raw.createdAt) {
      try { year = new Date(raw.createdAt).getFullYear() || 2024; } catch {}
    }
    const slug = String(raw.slug || '').trim();
    return {
      id: slug,
      slug,
      name: String(raw.name || '').trim() || 'Parfum Dadios',
      family: String(raw.family || 'Signature').trim(),
      year,
      notes,
      desc: String(raw.shortDescription || '').trim(),
      price: `${price50} DT`,
      vol: '50 ML',
      juice: deduceJuiceColor((raw.family || '') + ' ' + (raw.name || '')),
      h: 0.95,
      price50ml: price50,
      price20ml: price20,
      image: raw.image || null,
    };
  }

  /**
   * Replace the in-memory catalogue with a freshly-fetched list. scene.js
   * calls this before instancing any bottles. If `arr` is empty or null,
   * leave the fallback untouched.
   *
   * Also handles the spec's filling logic: if there are fewer than 6
   * products, duplicate them to reach `targetCount` so the shelves
   * don't look bare; if there are more than 20, take the first 10
   * (featured first, then the rest).
   */
  function setProducts(arr, targetCount = 18) {
    if (!Array.isArray(arr) || !arr.length) return;
    let list = arr.slice();
    if (list.length > 20) {
      const featured = list.filter((p) => p && p.featured);
      const rest = list.filter((p) => p && !p.featured);
      list = [...featured, ...rest].slice(0, 10);
    }
    if (list.length < 6) {
      const seed = list.slice();
      while (list.length < targetCount && seed.length) {
        for (const p of seed) {
          list.push(p);
          if (list.length >= targetCount) break;
        }
      }
    }
    products = list;
  }

  window.DadiosBottles = {
    /** Mutable live array. Replaced by setProducts. */
    get products() { return products; },
    filler,
    getLabelTexture,
    make(spec, opts = {}) {
      const juice = (spec && spec.juice) != null ? spec.juice : 0xe4dca8;
      const h = opts.h != null ? opts.h : (spec && spec.h != null ? spec.h : 0.95);
      const b = makeDadiosBottle(juice, { h });
      if (spec && spec.id) {
        b.userData.product = spec;
        b.traverse((o) => { if (o.isMesh) o.userData.productRoot = b; });
      }
      return b;
    },
    setProducts,
    buildSceneProduct,
    deduceJuiceColor,
    frenchifyNote,
  };
})();
