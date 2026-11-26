// Local object detection + vehicle re-identification.
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
};

// COCO class ids we care about. Everything else is ignored.
const KINDS = {
  0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle',
  5: 'bus', 7: 'truck', 15: 'cat', 16: 'dog',
};
const INPUT = 640;
const CONFIDENCE = 0.35;
const NMS_IOU = 0.45;

const downloads = new Map();
let sessions = null;
let loading = null;

export const modelStatus = () => ({
  detect: fs.existsSync(path.join(MODEL_DIR, MODELS.detect.file)),
  reid: fs.existsSync(path.join(MODEL_DIR, MODELS.reid.file)),
});

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

export async function loadModels() {
  if (sessions) return sessions;
  if (!loading) {
    loading = (async () => {
      const detectPath = await ensureModel('detect');
      const detect = await ort.InferenceSession.create(detectPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      let reid = null;
      try {
        const reidPath = await ensureModel('reid');
        reid = await ort.InferenceSession.create(reidPath, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });
      } catch (err) {
        console.warn(`ReID model unavailable, using image fingerprints instead: ${err.message}`);
      }
      sessions = { detect, reid };
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

function iou(a, b) {
  const ax = a[0] - a[2] / 2; const ay = a[1] - a[3] / 2;
  const bx = b[0] - b[2] / 2; const by = b[1] - b[3] / 2;
  const w = Math.min(ax + a[2], bx + b[2]) - Math.max(ax, bx);
  const h = Math.min(ay + a[3], by + b[3]) - Math.max(ay, by);
  if (w <= 0 || h <= 0) return 0;
  const area = w * h;
  return area / (a[2] * a[3] + b[2] * b[3] - area);
}

function nonMaxSuppression(candidates) {
  const kept = [];
  for (const item of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (kept.every((other) => iou(item.box, other.box) < NMS_IOU)) kept.push(item);
    if (kept.length >= 12) break;
  }
  return kept;
}

// 8x8 difference hash: stable enough to recognise the same car from a
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

async function embedding(session, crop) {
  if (!session) return null;
  const raw = await sharp(crop).resize(128, 256, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  const tensor = new ort.Tensor('float32', nchw(raw, 128, 256), [1, 3, 256, 128]);
  const result = await session.run({ images: tensor });
  const values = Array.from(result.embeddings.data);
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

export async function detect(buffer) {
  const { detect: detector, reid } = await loadModels();
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read captured frame');

  const resized = await sharp(buffer).resize(INPUT, INPUT, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const input = new ort.Tensor('float32', nchw(resized, INPUT, INPUT), [1, 3, INPUT, INPUT]);
  const result = await detector.run({ images: input });
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

  const detections = [];
  for (const item of nonMaxSuppression(candidates)) {
    const [cx, cy, w, h] = item.box;
    const sx = meta.width / INPUT;
    const sy = meta.height / INPUT;
    const left = Math.max(0, Math.round((cx - w / 2) * sx));
    const top = Math.max(0, Math.round((cy - h / 2) * sy));
    const width = Math.max(1, Math.min(Math.round(w * sx), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(h * sy), meta.height - top));
    const crop = await sharp(buffer).extract({ left, top, width, height }).jpeg({ quality: 82 }).toBuffer();
    detections.push({
      kind: item.kind,
      confidence: item.confidence,
      bbox: [left, top, width, height],
      snapshot: crop,
      fingerprint: await fingerprint(sharp(crop)),
      embedding: await embedding(reid, crop),
    });
  }
  return detections;
}
