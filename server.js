const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: path.join(os.tmpdir(), "uploads"),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  },
});

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

function makeTempFile(ext = ".mp4") {
  return path.join(
    os.tmpdir(),
    `enhance-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`
  );
}

function normalizeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function hasValue(v) {
  return typeof v === "string" ? v.trim().length > 0 : !!v;
}

function buildLog(step, message) {
  return `[${new Date().toLocaleTimeString()}] ${step}: ${message}`;
}

async function runFFmpegFastEnhance(inputPath, outputPath, options = {}) {
  const {
    upscale = false,
    targetHeight = 1080,
    crf = 20,
    audioBitrate = "192k",
  } = options;

  const vf = [];

  // Gentle cleanup / scaling
  if (upscale) {
    vf.push(
      `scale=-2:${targetHeight}:flags=lanczos,unsharp=5:5:0.8:3:3:0.4`
    );
  } else {
    vf.push(`scale='min(1280,iw)':-2:flags=lanczos`);
  }

  // Mild contrast/saturation polish
  vf.push("eq=contrast=1.03:saturation=1.05:brightness=0.01");

  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    vf.join(","),
    "-af",
    "highpass=f=80,lowpass=f=12000,loudnorm",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    outputPath,
  ];

  await execFileAsync("ffmpeg", args);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function callElevenLabsIsolation({ inputPath, apiKey, logs }) {
  if (!hasValue(apiKey)) {
    throw new Error("ELEVENLABS_KEY_MISSING");
  }

  logs.push(buildLog("AI", "Step 1/3 - Voice isolation via ElevenLabs"));

  const fileBuffer = fs.readFileSync(inputPath);
  const form = new FormData();

  // field names may vary based on your exact ElevenLabs endpoint
  form.append("file", new Blob([fileBuffer]), path.basename(inputPath));

  const response = await fetchWithTimeout(
    "https://api.elevenlabs.io/v1/audio-isolation",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
    },
    180000
  );

  const contentType = response.headers.get("content-type") || "";
  const raw = contentType.includes("application/json")
    ? await response.text()
    : Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const detail =
      typeof raw === "string" ? raw : `binary response (${raw.length} bytes)`;
    throw new Error(`ELEVENLABS_FAILED_${response.status}: ${detail}`);
  }

  const isolatedAudioPath = makeTempFile(".mp3");
  fs.writeFileSync(isolatedAudioPath, Buffer.from(raw));
  return isolatedAudioPath;
}

async function callFalUpscale({ inputPath, apiKey, model, logs }) {
  if (!hasValue(apiKey)) {
    throw new Error("FAL_KEY_MISSING");
  }

  if (!hasValue(model)) {
    throw new Error("FAL_MODEL_MISSING");
  }

  logs.push(buildLog("AI", `Step 2/3 - Video upscaling via fal (${model})`));

  // IMPORTANT:
  // Replace this block with the exact fal endpoint / SDK flow you use.
  // This example shows safe auth/error handling and clear diagnostics.
  const fileBuffer = fs.readFileSync(inputPath);
  const base64Video = fileBuffer.toString("base64");

  const response = await fetchWithTimeout(
    `https://fal.run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        video_url: null,
        video_base64: base64Video,
      }),
    },
    300000
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`FAL_FAILED_${response.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`FAL_BAD_JSON: ${text}`);
  }

  // Adjust this according to your fal response structure
  const outputUrl =
    json.video?.url || json.output?.url || json.url || json.data?.url;

  if (!outputUrl) {
    throw new Error(`FAL_NO_OUTPUT_URL: ${text}`);
  }

  const downloadRes = await fetchWithTimeout(outputUrl, {}, 300000);
  if (!downloadRes.ok) {
    const body = await downloadRes.text();
    throw new Error(`FAL_DOWNLOAD_FAILED_${downloadRes.status}: ${body}`);
  }

  const outputBuffer = Buffer.from(await downloadRes.arrayBuffer());
  const upscaledPath = makeTempFile(".mp4");
  fs.writeFileSync(upscaledPath, outputBuffer);

  return upscaledPath;
}

async function muxVideoWithAudio(videoPath, audioPath, outputPath, logs) {
  logs.push(buildLog("AI", "Step 3/3 - Final mux and encode via FFmpeg"));

  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await execFileAsync("ffmpeg", args);
}

function classifyProviderError(message = "") {
  const m = String(message).toLowerCase();

  if (
    m.includes("forbidden") ||
    m.includes("_403") ||
    m.includes("unauthorized") ||
    m.includes("_401") ||
    m.includes("invalid api key") ||
    m.includes("access denied") ||
    m.includes("insufficient")
  ) {
    return "auth";
  }

  if (
    m.includes("model") &&
    (m.includes("missing") || m.includes("not found") || m.includes("invalid"))
  ) {
    return "model";
  }

  if (m.includes("timeout") || m.includes("abort")) {
    return "timeout";
  }

  return "other";
}

async function runAIPipelineWithFallback({
  inputPath,
  outputPath,
  elevenLabsKey,
  falKey,
  falModel,
  logs,
}) {
  const canUseAI =
    hasValue(elevenLabsKey) && hasValue(falKey) && hasValue(falModel);

  if (!canUseAI) {
    logs.push(buildLog("INFO", "AI keys/model not complete. Running Fast Mode."));
    await runFFmpegFastEnhance(inputPath, outputPath, { upscale: true });
    return {
      modeUsed: "fast",
      fallbackUsed: true,
      fallbackReason: "Missing AI credentials or model.",
    };
  }

  let isolatedAudioPath = null;
  let upscaledVideoPath = null;

  try {
    logs.push(buildLog("INFO", "Starting AI enhancement pipeline."));

    isolatedAudioPath = await callElevenLabsIsolation({
      inputPath,
      apiKey: elevenLabsKey,
      logs,
    });

    upscaledVideoPath = await callFalUpscale({
      inputPath,
      apiKey: falKey,
      model: falModel,
      logs,
    });

    await muxVideoWithAudio(
      upscaledVideoPath,
      isolatedAudioPath,
      outputPath,
      logs
    );

    logs.push(buildLog("SUCCESS", "AI enhancement completed successfully."));
    return {
      modeUsed: "ai",
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch (err) {
    const reasonType = classifyProviderError(err.message);

    logs.push(buildLog("WARN", `AI enhancement failed: ${err.message}`));
    logs.push(buildLog("INFO", "Falling back to Fast Mode (FFmpeg only)."));

    await runFFmpegFastEnhance(inputPath, outputPath, { upscale: true });

    logs.push(buildLog("SUCCESS", "Fast Mode completed after AI fallback."));

    return {
      modeUsed: "fast",
      fallbackUsed: true,
      fallbackReason:
        reasonType === "auth"
          ? "AI provider authentication or access issue."
          : reasonType === "model"
          ? "Selected fal model is invalid or unavailable."
          : reasonType === "timeout"
          ? "AI provider timeout."
          : "AI provider error.",
    };
  } finally {
    safeUnlink(isolatedAudioPath);
    safeUnlink(upscaledVideoPath);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "video-enhancer" });
});

app.post("/api/enhance", upload.single("video"), async (req, res) => {
  const logs = [];
  let inputPath = null;
  let outputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No video file uploaded.",
        logs,
      });
    }

    inputPath = req.file.path;
    outputPath = makeTempFile(".mp4");

    const requestedMode = (req.body.mode || "fast").toLowerCase();
    const elevenLabsKey = req.body.elevenLabsKey || "";
    const falKey = req.body.falKey || "";
    const falModel = req.body.falModel || "";
    const allowAIFallback = normalizeBool(
      req.body.allowAIFallback !== undefined ? req.body.allowAIFallback : true
    );

    logs.push(buildLog("INFO", `Requested mode: ${requestedMode}`));

    let result;

    if (requestedMode === "ai") {
      if (allowAIFallback) {
        result = await runAIPipelineWithFallback({
          inputPath,
          outputPath,
          elevenLabsKey,
          falKey,
          falModel,
          logs,
        });
      } else {
        logs.push(buildLog("INFO", "AI-only mode enabled. No fallback allowed."));
        await runAIPipelineWithFallback({
          inputPath,
          outputPath,
          elevenLabsKey,
          falKey,
          falModel,
          logs,
        });
      }
    } else {
      logs.push(buildLog("INFO", "Running Fast Mode."));
      await runFFmpegFastEnhance(inputPath, outputPath, { upscale: true });
      logs.push(buildLog("SUCCESS", "Fast enhancement completed successfully."));
      result = {
        modeUsed: "fast",
        fallbackUsed: false,
        fallbackReason: null,
      };
    }

    const finalBuffer = fs.readFileSync(outputPath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="enhanced-video.mp4"'
    );
    res.setHeader("X-Enhancement-Mode", result.modeUsed);
    res.setHeader("X-Fallback-Used", String(result.fallbackUsed));
    if (result.fallbackReason) {
      res.setHeader(
        "X-Fallback-Reason",
        encodeURIComponent(result.fallbackReason)
      );
    }
    res.setHeader("X-Logs", encodeURIComponent(JSON.stringify(logs)));

    return res.status(200).send(finalBuffer);
  } catch (err) {
    console.error("Enhancement route error:", err);

    logs.push(buildLog("ERROR", err.message || "Unknown server error"));

    return res.status(500).json({
      ok: false,
      error: err.message || "Enhancement failed.",
      logs,
    });
  } finally {
    safeUnlink(inputPath);
    safeUnlink(outputPath);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});