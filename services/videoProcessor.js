const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

// Always write temporary files to the writable /tmp directory
const TMP_DIR = os.tmpdir();

async function downloadVideo(url, outputPath, onProgress) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    timeout: 30000,                 // give up if the host stops answering
    maxRedirects: 3,
    maxContentLength: 2 * 1024 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });

  const totalLength = parseInt(response.headers['content-length'], 10) || 0;
  let downloaded = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);

    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (totalLength && onProgress) {
        onProgress(Math.round((downloaded / totalLength) * 100));
      }
    });

    response.data.pipe(writer);
    writer.on('finish', () => resolve(outputPath));
    writer.on('error', reject);
  });
}

// Letterboxes the video into an 800x800 square (no cropping) at max 30 fps.
// opts.onProgress(percent 0-100) reports conversion progress; opts.timeoutMs stops ffmpeg cleanly if it runs too long,
// so the API can answer with a readable error instead of Vercel killing the whole function (504 FUNCTION_INVOCATION_TIMEOUT).
function makeSquare800(inputPath, outputPath, opts = {}) {
  const { onProgress, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    let timer = null;
    let timedOut = false;
    const cmd = ffmpeg(inputPath)
      .outputOptions([
        '-vf scale=800:800:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=800:800:(800-iw)/2:(800-ih)/2:black',
        '-c:v libx264',
        '-preset ultrafast',   // fastest encode: essential on serverless
        '-crf 28',             // smaller output = faster upload to X (still fine at 800x800)
        '-threads 0',
        '-pix_fmt yuv420p',
        '-r 30',               // X accepts up to 60 fps; 30 keeps the encode fast
        '-c:a aac',
        '-b:a 96k',
        '-movflags +faststart'
      ])
      .toFormat('mp4')
      .on('progress', (p) => {
        if (onProgress && Number.isFinite(p.percent)) onProgress(Math.max(0, Math.min(100, p.percent)));
      })
      .on('end', () => { clearTimeout(timer); resolve(outputPath); })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(timedOut
          ? new Error('Converting this video took longer than the server allows. Try a shorter video, or compress it first.')
          : err);
      });
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; try { cmd.kill('SIGKILL'); } catch { /* already finished */ } }, timeoutMs);
    }
    cmd.save(outputPath);
  });
}

function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:01.000'],
        filename: path.basename(thumbnailPath),
        folder: path.dirname(thumbnailPath),
        size: '240x240'   // small on purpose: thumbnails are stored in the database
      })
      .on('end', () => resolve(thumbnailPath))
      .on('error', (err) => reject(err));
  });
}

module.exports = {
  TMP_DIR,
  downloadVideo,
  makeSquare800,
  generateThumbnail
};
