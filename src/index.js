import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadSecrets } from './config/secrets.js';
import authRoutes from './routes/auth.js';
import mastersRoutes from './routes/masters.js';
import jobsRoutes from './routes/jobs.js';
import { initializeS3Bucket, streamToBuffer } from './services/s3Service.js';
import { initializeQueue } from './services/queueService.js';
import { initializeWorker } from './workers/documentWorker.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────
// CORS — only needed for local dev.
// In production, browser and API are on the same ALB origin
// so CORS is not triggered. Keep it here for local convenience.
// ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://afllriuat.axisb.com',
  credentials: true
}));

// Body parser — skip for multipart upload routes (Busboy handles those directly)
// Applying body parser to multipart streams can corrupt or prematurely consume
// the request body before Busboy gets it, causing silent upload failures.
app.use((req, res, next) => {
  const isUpload = req.path.includes('/upload') && req.method === 'POST';
  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  if (isUpload && isMultipart) return next(); // skip body parser for uploads
  express.json({ limit: '100mb' })(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ limit: '100mb', extended: true })(req, res, next);
  });
});

// ─────────────────────────────────────────────────────────────
// S3 bucket configuration
//
// TWO separate buckets are used:
//
//   FRONTEND_BUCKET_NAME  — holds only the compiled React build
//                           (index.html, JS, CSS, assets).
//                           Backend reads from here to serve the UI.
//                           Nothing is ever written here at runtime.
//
//   S3_BUCKET_NAME        — the App Bucket. holds all job data:
//                           uploads, processing queue, reports,
//                           users, masters. Backend + Worker both
//                           read/write here.
//
// Previously S3_BUCKET_NAME was mistakenly set to the frontend bucket,
// causing jobs to land there. That is now fixed in the CFN template.
// ─────────────────────────────────────────────────────────────
const FRONTEND_BUCKET = process.env.FRONTEND_BUCKET_NAME;
const FRONTEND_S3_PREFIX = process.env.FRONTEND_S3_PREFIX || 'frontend';

// Dedicated S3 client for reading frontend assets from the frontend bucket.
// This is intentionally separate from the s3Service client (which targets
// the App Bucket) so the two buckets never get mixed up.
const frontendS3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
});

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// API Routes — registered first so /api/* never hits the proxy
// ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/masters', mastersRoutes);
app.use('/api/jobs', jobsRoutes);

// ─────────────────────────────────────────────────────────────
// S3 Frontend Proxy
//
// How it works:
//   1. Browser requests GET /  or GET /dashboard  or GET /assets/index-abc.js
//   2. Express maps the path → S3 key under the FRONTEND_S3_PREFIX folder
//   3. Fetches the object from the FRONTEND bucket (not the app bucket)
//   4. Streams it back to the browser with the correct Content-Type
//
// Both S3 buckets stay 100% private — no public access, no presigned URLs.
// Only the ECS task role can read these objects via IAM.
//
// React Router support:
//   - Requests for known asset extensions → served as-is from S3
//   - All other paths → serve index.html so React Router handles routing
// ─────────────────────────────────────────────────────────────

// File extensions that are real static assets (not React routes)
const ASSET_EXTENSIONS = /\.(js|css|png|jpg|jpeg|svg|ico|woff|woff2|ttf|eot|map|json|txt|webmanifest)$/i;

// MIME type map for correct Content-Type headers
const MIME_TYPES = {
  '.js':          'application/javascript',
  '.css':         'text/css',
  '.html':        'text/html; charset=utf-8',
  '.json':        'application/json',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.jpeg':        'image/jpeg',
  '.svg':         'image/svg+xml',
  '.ico':         'image/x-icon',
  '.woff':        'font/woff',
  '.woff2':       'font/woff2',
  '.ttf':         'font/ttf',
  '.eot':         'application/vnd.ms-fontobject',
  '.map':         'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt':         'text/plain',
};

function getMimeType(filePath) {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Reads a file from the FRONTEND bucket specifically — never touches the app bucket
async function proxyFromS3(s3Key, res) {
  const response = await frontendS3Client.send(new GetObjectCommand({
    Bucket: FRONTEND_BUCKET,
    Key: s3Key,
  }));

  const buffer = await streamToBuffer(response.Body);
  const mimeType = getMimeType(s3Key);

  res.setHeader('Content-Type', mimeType);
  // Cache assets aggressively, never cache HTML
  if (mimeType === 'text/html; charset=utf-8') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  res.send(buffer);
}

// Frontend proxy handler — catches everything that isn't /api/* or /health
app.get('*', async (req, res) => {
  const reqPath = req.path;

  // Determine the S3 key to fetch
  let s3Key;
  if (reqPath === '/' || !ASSET_EXTENSIONS.test(reqPath)) {
    // React route — always serve index.html
    s3Key = `${FRONTEND_S3_PREFIX}/index.html`;
  } else {
    // Real static asset — serve the exact file
    s3Key = `${FRONTEND_S3_PREFIX}${reqPath}`;
  }

  try {
    await proxyFromS3(s3Key, res);
  } catch (err) {
    // If asset not found, fall back to index.html (handles deep links)
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') {
      try {
        await proxyFromS3(`${FRONTEND_S3_PREFIX}/index.html`, res);
      } catch (fallbackErr) {
        console.error('[Frontend Proxy] index.html not found in S3:', fallbackErr.message);
        res.status(404).send('Frontend not deployed. Upload your React build to S3.');
      }
    } else {
      console.error('[Frontend Proxy] S3 fetch error:', err.message);
      res.status(502).send('Error fetching frontend from S3.');
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 4GB.' });
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ─────────────────────────────────────────────────────────────
// Boot sequence
// ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // ── Step 1: Load secrets first (required before anything else) ──────────
    await loadSecrets();

    // ── Step 2: Start HTTP server IMMEDIATELY so ALB health checks pass ─────
    // Redis and S3 initialization happens in the background AFTER the server
    // is already listening. This prevents ALB from marking the task unhealthy
    // during the Redis retry window (which can take 15+ seconds on cold start).
    const server = app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`  Environment:          ${process.env.NODE_ENV || 'development'}`);
      console.log(`  Frontend Bucket:      ${FRONTEND_BUCKET}`);
      console.log(`  Frontend S3 prefix:   ${FRONTEND_S3_PREFIX}`);
      console.log(`  App Bucket:           ${process.env.S3_BUCKET_NAME}`);
    });

    // ── Timeouts for large file uploads (4GB+ ZIPs) ──────────────────────
    // Default Node.js keepAliveTimeout is 5s and headersTimeout is 60s —
    // both will kill a long-running upload before it completes.
    // Set to 0 (disabled) so the ALB idle_timeout (4000s) is the only limit.
    server.keepAliveTimeout  = 0;
    server.headersTimeout    = 0;
    server.requestTimeout    = 0;
    server.timeout           = 0;   // socket inactivity timeout

    // ── Step 3: Initialize everything else in background ────────────────────
    // Errors here are logged but do NOT crash the server — the app stays up
    // and retries are handled inside each init function.
    (async () => {
      try {
        console.log('Initializing queue...');
        const queueResult = await initializeQueue();
        if (queueResult.useInMemory) {
          console.log('✓ Using in-memory queue');
        } else {
          console.log('✓ Redis queue initialized');
        }

        await initializeS3Bucket();
        console.log('✓ S3 bucket initialized');

        await initializeWorker();
        console.log('✓ Document processing worker initialized');
      } catch (bgError) {
        console.error('Background initialization error:', bgError.message);
        // Do NOT call process.exit() — server stays up, ALB stays healthy
      }
    })();

  } catch (error) {
    // Only secrets failure should crash the server
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
