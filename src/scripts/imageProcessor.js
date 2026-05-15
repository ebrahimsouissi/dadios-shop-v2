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
