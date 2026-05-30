/**
 * Takes a File from a file input, returns a Blob that's:
 *  - cropped to a centered square
 *  - resized so the longest side = maxDim (default 1200px)
 *  - encoded as JPEG quality 0.86 (good balance of size vs quality)
 *
 * Returns: { blob, dataUrl } — dataUrl is for instant preview
 */
export async function processImage(file, maxDim = 1200, quality = 0.86) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Le fichier doit être une image');
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('Image trop grosse (max 15 MB avant traitement)');
  }

  // Load image
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);

  // Crop to square: take the smaller dimension, center the crop
  const size = Math.min(img.width, img.height);
  const sx = (img.width - size) / 2;
  const sy = (img.height - size) / 2;

  // Target square size = min(size, maxDim)
  const targetSize = Math.min(size, maxDim);

  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, size, size, 0, 0, targetSize, targetSize);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );
  const previewUrl = canvas.toDataURL('image/jpeg', 0.7); // smaller for in-memory preview
  return { blob, dataUrl: previewUrl, width: targetSize, height: targetSize };
}

/**
 * Compresse un File en JPEG sans crop, en respectant le ratio. Si
 * l'image est déjà sous maxDim sur les deux axes, on la convertit
 * quand même en JPEG (compression utile pour les PNG/screenshots
 * lourds). Utilisé par l'éditeur d'articles pour les hero images.
 *
 * - maxDim : longueur max de l'axe le plus long (par défaut 1600px,
 *   suffisant pour retina sur une carte 800px)
 * - quality : 0.85 par défaut, bon ratio poids/qualité
 *
 * Retourne le Blob compressé OU le File original si la compression
 * a produit un fichier plus gros (ex. petit PNG très optimisé).
 */
export async function compressImage(file, maxDim = 1600, quality = 0.85) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Le fichier doit être une image');
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('Image trop grosse (max 20 MB avant compression)');
  }

  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);

  // Calcule la taille cible en gardant le ratio.
  const longest = Math.max(img.width, img.height);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const targetW = Math.round(img.width * scale);
  const targetH = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );

  // Si la compression a produit un fichier plus gros (rare mais
  // possible sur de petites images déjà compressées), on garde
  // l'original — sauf si c'est un PNG/WebP qu'on convertit en JPEG.
  if (blob && blob.size < file.size) return blob;
  return file;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Lecture du fichier échouée'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image invalide ou corrompue'));
    img.src = src;
  });
}
