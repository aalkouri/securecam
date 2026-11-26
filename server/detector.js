// Local object detection, vehicle re-identification and face recognition.
// Models are downloaded once into data/models so nothing runs in the cloud.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { DATA_DIR } from './store.js';

const MODEL_DIR = path.join(DATA_DIR, 'models');
const MODELS = {
  detect: {
    file: 'yolov8n.onnx',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx',
    sha256: 'b2bc52f40e8e1c532427d5bde3575a5d5b571b739fab2c6df443733ed1589cbd',
  },
  reid: {
    file: 'yolo26n-reid.onnx',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n-reid.onnx',
    sha256: '8529c383197ae4c468eda535d1b165f8b4162cf17bf5fbcff49c7cb6455bc0bb',
  },
  // YOLOv10n-Face: output is [1,300,6] with x1,y1,x2,y2,confidence,class.
  face: {
    file: 'yolov10n-face.onnx',
    url: 'https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov10n-face.onnx',
    sha256: '759ca70ef7654a47177e3f124416f27d21dabba632269f80b19b49966353a2a3',
  },
  // InsightFace ArcFace MobileFaceNet: 512-d embeddings from a 112x112 face.
  faceEmbed: {
    file: 'w600k_mbf.onnx',
    url: 'https://github.com/yakhyo/face-reidentification/releases/download/v0.0.1/w600k_mbf.onnx',
    sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
  },
};

// COCO class ids we care about. Everything else is ignored.
const KINDS = {
  0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle',
  5: 'bus', 7: 'truck', 15: 'cat', 16: 'dog',
};
const INPUT = 640;
const CONFIDENCE = 0.35;
const FACE_CONFIDENCE = 0.5;
const NMS_IOU = 0.45;
const FACE_PADDING = 0.15; // a little context around the face, but still a face shot

const downloads = new Map();
let sessions = null;
let loading = null;

export const modelStatus = () => Object.fromEntries(
  Object.entries(MODELS).map(([key, spec]) => [key, fs.existsSync(path.join(MODEL_DIR, spec.file))]),
);

async function ensureModel(key) {
  const spec = MODELS[key];
  const target = path.join(MODEL_DIR, spec.file);
  const valid = () => {
    if (!fs.existsSync(target)) return false;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return hash === spec.sha256;
  };
  if (valid()) return target;
  if (!downloads.has(key)) {
    downloads.set(key, (async () => {
      fs.mkdirSync(MODEL_DIR, { recursive: true });
      const response = await fetch(spec.url);
      if (!response.ok) throw new Error(`Could not download ${spec.file} (HTTP ${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hash !== spec.sha256) throw new Error(`${spec.file} failed its checksum`);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, target);
      return target;
    })().finally(() => downloads.delete(key)));
  }
  return downloads.get(key);
}

async function optionalSession(key) {
  try {
    const file = await ensureModel(key);
    return await ort.InferenceSession.create(file, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    console.warn(`${key} model unavailable (${err.message}); related detections will be skipped`);
    return null;
  }
}

export async function loadModels() {
  if (sessions) return sessions;
  if (!loading) {
    loading = (async () => {
      const detectPath = await ensureModel('detect');
      const detect = await ort.InferenceSession.create(detectPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      const reid = await optionalSession('reid');
      const face = await optionalSession('face');
      const faceEmbed = await optionalSession('faceEmbed');
      if (!face || !faceEmbed) {
        console.warn('People are only recorded when a clear face is visible; face models are required.');
      }
      sessions = { detect, reid, face, faceEmbed };
      return sessions;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

function nchw(raw, width, height) {
  const pixels = width * height;
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    data[i] = raw[i * 3] / 255;
    data[pixels + i] = raw[i * 3 + 1] / 255;
    data[pixels * 2 + i] = raw[i * 3 + 2] / 255;
  }
  return data;
}

// ArcFace expects RGB pixels scaled to [-1, 1].
function arcfaceInput(raw, size) {
  const pixels = size * size;
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    data[i] = (raw[i * 3] - 127.5) / 127.5;
    data[pixels + i] = (raw[i * 3 + 1] - 127.5) / 127.5;
    data[pixels * 2 + i] = (raw[i * 3 + 2] - 127.5) / 127.5;
  }
  return data;
}

function iou(a, b) {
  const ax = a[0] - a[2] / 2; const ay = a[1] - a[3] / 2;
  const bx = b[0] - b[2] / 2; const by = b[1] - b[3] / 2;
  const w = Math.min(ax + a[2], bx + b[2]) - Math.max(ax, bx);
  const h = Math.min(ay + a[3], by + b[3]) - Math.max(ay, by);
  if (w <= 0 || h <= 0) return 0;
  const area = w * h;
  return area / (a[2] * a[3] + b[2] * b[3] - area);
}

function nonMaxSuppression(candidates, limit = 12) {
  const kept = [];
  for (const item of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (kept.every((other) => iou(item.box, other.box) < NMS_IOU)) kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

// 8x8 difference hash: stable enough to recognise the same vehicle from a
// fixed camera, and useful when the ReID model can't be loaded.
async function fingerprint(image) {
  const raw = await image.clone().resize(9, 8, { fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits += raw[y * 9 + x] < raw[y * 9 + x + 1] ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

async function vehicleEmbedding(session, crop) {
  if (!session) return null;
  const raw = await sharp(crop).resize(128, 256, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  const tensor = new ort.Tensor('float32', nchw(raw, 128, 256), [1, 3, 256, 128]);
  const result = await session.run({ images: tensor });
  const values = Array.from(result.embeddings.data);
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

// Find faces in the full frame once per scan, then match each to a person box.
async function findFaces(session, tensor, meta) {
  if (!session) return [];
  const result = await session.run({ images: tensor });
  const output = result.output0.data;
  const sx = meta.width / INPUT;
  const sy = meta.height / INPUT;
  const found = [];
  for (let i = 0; i < 300; i += 1) {
    const confidence = output[i * 6 + 4];
    if (confidence < FACE_CONFIDENCE) continue;
    const x1 = Math.max(0, Math.round(output[i * 6] * sx));
    const y1 = Math.max(0, Math.round(output[i * 6 + 1] * sy));
    const x2 = Math.min(meta.width, Math.round(output[i * 6 + 2] * sx));
    const y2 = Math.min(meta.height, Math.round(output[i * 6 + 3] * sy));
    const width = x2 - x1;
    const height = y2 - y1;
    if (width < 12 || height < 12) continue;
    found.push({ box: [x1, y1, width, height], confidence });
  }
  return nonMaxSuppression(found, 20);
}

function faceForPerson(personBox, faces) {
  const [px, py, pw, ph] = personBox;
  const cx = px + pw / 2;
  const cy = py + ph / 2;
  let best = null;
  for (const face of faces) {
    const [fx, fy, fw, fh] = face.box;
    const faceCx = fx + fw / 2;
    const faceCy = fy + fh / 2;
    // The face must sit inside the person box (centre + most of the face).
    if (faceCx < px || faceCx > px + pw || faceCy < py || faceCy > py + ph) continue;
    if (fw > pw * 1.2 || fh > ph * 1.2) continue;
    if (!best || face.confidence > best.confidence) best = face;
    // Prefer the largest face when confidences are close.
    if (best && Math.abs(face.confidence - best.confidence) < 0.05
      && fw * fh > best.box[2] * best.box[3]) best = face;
  }
  return best;
}

function paddedFace(box, width, height) {
  const [x, y, w, h] = box;
  const padX = Math.round(w * FACE_PADDING);
  const padY = Math.round(h * FACE_PADDING);
  const left = Math.max(0, x - padX);
  const top = Math.max(0, y - padY);
  const right = Math.min(width, x + w + padX);
  const bottom = Math.min(height, y + h + padY);
  return { left, top, width: right - left, height: bottom - top };
}

async function faceEmbedding(session, buffer, box) {
  if (!session) return null;
  const [x, y, w, h] = box;
  const raw = await sharp(buffer)
    .extract({ left: x, top: y, width: w, height: h })
    .resize(112, 112, { fit: 'fill' })
    .removeAlpha().raw().toBuffer();
  const tensor = new ort.Tensor('float32', arcfaceInput(raw, 112), [1, 3, 112, 112]);
  const result = await session.run({ 'input.1': tensor });
  const values = Array.from(result['516'].data);
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

export async function detect(buffer) {
  const { detect: detector, reid, face, faceEmbed } = await loadModels();
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read captured frame');

  const resized = await sharp(buffer).resize(INPUT, INPUT, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const tensor = new ort.Tensor('float32', nchw(resized, INPUT, INPUT), [1, 3, INPUT, INPUT]);
  const result = await detector.run({ images: tensor });
  const output = result.output0.data;
  const count = result.output0.dims[2];
  const classes = (result.output0.dims[1] - 4);

  const candidates = [];
  for (let anchor = 0; anchor < count; anchor += 1) {
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < classes; c += 1) {
      const score = output[(4 + c) * count + anchor];
      if (score > bestScore) { bestScore = score; bestClass = c; }
    }
    if (!KINDS[bestClass] || bestScore < CONFIDENCE) continue;
    candidates.push({
      kind: KINDS[bestClass],
      confidence: bestScore,
      box: [output[anchor], output[count + anchor], output[2 * count + anchor], output[3 * count + anchor]],
    });
  }

  const kept = nonMaxSuppression(candidates);
  const needsFaces = kept.some((item) => item.kind === 'person');
  const faces = needsFaces ? await findFaces(face, tensor, meta) : [];
  const detections = [];

  for (const item of kept) {
    const [cx, cy, w, h] = item.box;
    const sx = meta.width / INPUT;
    const sy = meta.height / INPUT;
    const left = Math.max(0, Math.round((cx - w / 2) * sx));
    const top = Math.max(0, Math.round((cy - h / 2) * sy));
    const width = Math.max(1, Math.min(Math.round(w * sx), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(h * sy), meta.height - top));
    const personBox = [left, top, width, height];

    // People are stored as face shots only. If no face is visible, skip them
    // entirely rather than saving a body shot or matching on clothing.
    if (item.kind === 'person') {
      const matched = faceForPerson(personBox, faces);
      if (!matched) continue;
      const cropBox = paddedFace(matched.box, meta.width, meta.height);
      const snapshot = await sharp(buffer).extract(cropBox).jpeg({ quality: 88 }).toBuffer();
      detections.push({
        kind: 'person',
        confidence: matched.confidence,
        bbox: matched.box,
        snapshot,
        fingerprint: null,
        embedding: await faceEmbedding(faceEmbed, buffer, matched.box),
      });
      continue;
    }

    const crop = await sharp(buffer).extract({ left, top, width, height }).jpeg({ quality: 82 }).toBuffer();
    detections.push({
      kind: item.kind,
      confidence: item.confidence,
      bbox: personBox,
      snapshot: crop,
      fingerprint: await fingerprint(sharp(crop)),
      embedding: await vehicleEmbedding(reid, crop),
    });
  }
  return detections;
}
