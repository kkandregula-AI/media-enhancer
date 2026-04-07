const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
ffmpeg.setFfprobePath("/usr/bin/ffprobe");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, "public")));

function cleanup(paths) {
  for (const p of paths) {
    if (!p) continue;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      resolve(Number(data?.format?.duration || 0));
    });
  });
}

function pickVideoFilter({ preset, resolution }) {
  const targetH = Number(resolution) || 1080;
  const scale = `scale=-2:${targetH}:flags=bicubic`;
  if (preset === "clarity") return `${scale},eq=contrast=1.05:brightness=0.01:saturation=1.04,unsharp=3:3:0.4:3:3:0.0`;
  if (preset === "social") return `${scale},eq=contrast=1.07:brightness=0.02:saturation=1.06`;
  if (preset === "cinematic") return `${scale},hqdn3d=0.6:0.6:2:2,eq=contrast=1.03:brightness=0.01:saturation=1.02`;
  return `${scale},eq=contrast=1.03:brightness=0.01:saturation=1.02`;
}

function pickAudioFilter({ audioPreset, audioGain }) {
  const gain = Number(audioGain) || 0;
  const base = [`volume=${gain}dB`];
  if (audioPreset === "voice") base.push("highpass=f=100", "lowpass=f=8000", "acompressor=threshold=-18dB:ratio=3:attack=20:release=200");
  else if (audioPreset === "loud") base.push("loudnorm=I=-14:LRA=11:TP=-1.5");
  else base.push("loudnorm=I=-16:LRA=11:TP=-1.5");
  return base.join(",");
}

function runFfmpeg({ inputPath, outputPath, trimStart, clipDuration, videoFilter, audioFilter, crf }) {
  return new Promise((resolve, reject) => {
    let stderrLines = [];
    let cmd = ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-movflags +faststart", "-pix_fmt yuv420p", "-preset ultrafast", `-crf ${crf}`])
      .videoFilters(videoFilter)
      .audioFilters(audioFilter)
      .format("mp4")
      .on("stderr", line => {
        console.log("FFmpeg:", line);
        stderrLines.push(line);
        if (stderrLines.length > 30) stderrLines.shift();
      })
      .on("end", resolve)
      .on("error", err => {
        err.ffmpegStderr = stderrLines.join(" | ");
        reject(err);
      });

    if (trimStart > 0) cmd = cmd.setStartTime(trimStart);
    if (clipDuration > 0) cmd = cmd.duration(clipDuration);
    cmd.save(outputPath);
  });
}

app.post("/api/enhance", upload.single("media"), async (req, res) => {
  let inputPath = req.file?.path || null;
  let outputPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No media file uploaded." });

    outputPath = path.join(os.tmpdir(), `enhanced-${Date.now()}.mp4`);
    const trimStart = Math.max(0, Number(req.body.trimStart || 0));
    const trimEnd = Math.max(0, Number(req.body.trimEnd || 0));
    const preset = req.body.preset || "balanced";
    const resolution = req.body.resolution || "1080";
    const audioPreset = req.body.audioPreset || "balanced";
    const crf = Math.min(32, Math.max(18, Number(req.body.crf || 23)));
    const audioGain = Math.min(8, Math.max(0, Number(req.body.audioGain || 2)));

    const totalDuration = await probeDuration(inputPath);
    if (!totalDuration || totalDuration <= 0) throw new Error("Could not read video duration.");

    const endAt = Math.max(trimStart, totalDuration - trimEnd);
    const clipDuration = Math.max(0, endAt - trimStart);
    if (clipDuration <= 0.1) return res.status(400).json({ error: "Trim values leave no usable video." });

    await runFfmpeg({
      inputPath, outputPath, trimStart, clipDuration,
      videoFilter: pickVideoFilter({ preset, resolution }),
      audioFilter: pickAudioFilter({ audioPreset, audioGain }),
      crf
    });

    const stat = fs.statSync(outputPath);
    if (!stat.size) throw new Error("Processed file is empty.");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="enhanced-${Date.now()}.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("close", () => cleanup([inputPath, outputPath]));
    stream.on("error", () => cleanup([inputPath, outputPath]));
  } catch (error) {
    cleanup([inputPath, outputPath]);
    res.status(500).json({
      error: error.message || "Server processing failed.",
      details: "Open Railway deploy logs if this persists.",
      stderr: error.ffmpegStderr || ""
    });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => console.log(`Media Enhancer Pro listening on port ${PORT}`));
