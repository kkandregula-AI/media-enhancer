const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const util = require("util");
const { execFile } = require("child_process");

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const upload = multer({
  dest: path.join(os.tmpdir(), "uploads"),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

function logLine(step, message) {
  return `[${new Date().toLocaleTimeString()}] ${step} ${message}`;
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

function tempFile(ext) {
  return path.join(
    os.tmpdir(),
    `enhancer-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`
  );
}

function hasValue(v) {
  return typeof v === "string" ? v.trim().length > 0 : !!v;
}

function asBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === "") return defaultValue;
  return v === true || v === "true" || v === 1 || v === "1";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function runFastEnhance(inputPath, outputPath) {
  const vf = [
    "scale='min(1280,iw)':-2:flags=lanczos",
    "eq=contrast=1.03:saturation=1.05:brightness=0.01",
    "unsharp=5:5:0.8:3:3:0.4",
  ].join(",");

  const af = [
    "highpass=f=80",
    "lowpass=f=12000",
    "loudnorm",
  ].join(",");

  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-af",
    af,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath,
  ];

  await execFileAsync("ffmpeg", args);
}

async function extractAudio(inputPath, outputAudioPath) {
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-acodec",
    "mp3",
    "-b:a",
    "192k",
    outputAudioPath,
  ];

  await execFileAsync("ffmpeg", args);
}

async function replaceVideoAudio(videoPath, audioPath, outputPath) {
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

async function callElevenLabsIsolation({ inputPath, apiKey, logs }) {
  if (!hasValue(apiKey)) {
    throw new Error("ELEVENLABS_KEY_MISSING");
  }

  logs.push(logLine("AI", "Step 1/3: Voice isolation via ElevenLabs."));

  const audioInputPath = tempFile(".mp3");
  const isolatedOutputPath = tempFile(".mp3");

  try {
    await extractAudio(inputPath, audioInputPath);

    const audioBuffer = fs.readFileSync(audioInputPath);
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), "audio.mp3");

    const res = await fetchWithTimeout(
      "https://api.elevenlabs.io/v1/audio-isolation",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
        },
        body: form,
      },
      240000
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ELEVENLABS_FAILED_${res.status}: ${text}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(isolatedOutputPath, Buffer.from(arrayBuffer));

    return isolatedOutputPath;
  } finally {
    safeUnlink(audioInputPath);
  }
}

async function callFalUpscale({ inputPath, apiKey, model, logs }) {
  if (!hasValue(apiKey)) {
    throw new Error("FAL_KEY_MISSING");
  }

  if (!hasValue(model)) {
    throw new Error("FAL_MODEL_MISSING");
  }

  logs.push(logLine("AI", `Step 2/3: Video upscaling via fal (${model}).`));

  const fileBuffer = fs.readFileSync(inputPath);
  const base64Video = fileBuffer.toString("base64");

  const res = await fetchWithTimeout(
    `https://fal.run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        video_base64: base64Video,
      }),
    },
    300000
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`FAL_FAILED_${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`FAL_BAD_JSON: ${text}`);
  }

  const outputUrl =
    json.video?.url ||
    json.output?.url ||
    json.url ||
    json.data?.url ||
    null;

  if (!outputUrl) {
    throw new Error(`FAL_NO_OUTPUT_URL: ${text}`);
  }

  const downloadRes = await fetchWithTimeout(outputUrl, {}, 300000);

  if (!downloadRes.ok) {
    const body = await downloadRes.text();
    throw new Error(`FAL_DOWNLOAD_FAILED_${downloadRes.status}: ${body}`);
  }

  const upscaledPath = tempFile(".mp4");
  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  fs.writeFileSync(upscaledPath, buffer);

  return upscaledPath;
}

function classifyError(message = "") {
  const m = String(message).toLowerCase();

  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("forbidden") ||
    m.includes("unauthorized") ||
    m.includes("invalid api key") ||
    m.includes("access denied") ||
    m.includes("insufficient")
  ) {
    return "auth";
  }

  if (
    m.includes("model") &&
    (m.includes("missing") || m.includes("invalid") || m.includes("not found"))
  ) {
    return "model";
  }

  if (m.includes("abort") || m.includes("timeout")) {
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
  const aiReady =
    hasValue(elevenLabsKey) && hasValue(falKey) && hasValue(falModel);

  if (!aiReady) {
    logs.push(
      logLine(
        "INFO",
        "AI credentials or model missing. Switching to Fast Mode."
      )
    );

    await runFastEnhance(inputPath, outputPath);

    logs.push(logLine("SUCCESS", "Fast enhancement completed."));
    return {
      modeUsed: "fast",
      fallbackUsed: true,
      fallbackReason: "Missing AI credentials or model.",
    };
  }

  let isolatedAudioPath = null;
  let upscaledVideoPath = null;

  try {
    logs.push(logLine("INFO", "Starting AI enhancement."));

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

    logs.push(logLine("AI", "Step 3/3: Final mux and encode via FFmpeg."));
    await replaceVideoAudio(upscaledVideoPath, isolatedAudioPath, outputPath);

    logs.push(logLine("SUCCESS", "AI enhancement completed successfully."));

    return {
      modeUsed: "ai",
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch (err) {
    const type = classifyError(err.message);

    logs.push(logLine("WARN", `AI enhancement failed: ${err.message}`));
    logs.push(logLine("INFO", "Falling back to Fast Mode."));

    await runFastEnhance(inputPath, outputPath);

    logs.push(logLine("SUCCESS", "Fast enhancement completed after fallback."));

    return {
      modeUsed: "fast",
      fallbackUsed: true,
      fallbackReason:
        type === "auth"
          ? "Authentication or provider access issue."
          : type === "model"
          ? "Selected fal model is invalid or unavailable."
          : type === "timeout"
          ? "AI provider timeout."
          : "AI provider error.",
    };
  } finally {
    safeUnlink(isolatedAudioPath);
    safeUnlink(upscaledVideoPath);
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "video-enhancer",
  });
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
    outputPath = tempFile(".mp4");

    const mode = (req.body.mode || "fast").toLowerCase();
    const elevenLabsKey = req.body.elevenLabsKey || "";
    const falKey = req.body.falKey || "";
    const falModel = req.body.falModel || "";
    const allowAIFallback = asBool(req.body.allowAIFallback, true);

    logs.push(logLine("INFO", `Requested mode: ${mode}.`));

    let result;

    if (mode === "ai") {
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
        logs.push(logLine("INFO", "AI-only mode enabled. No fallback allowed."));

        let isolatedAudioPath = null;
        let upscaledVideoPath = null;

        try {
          logs.push(logLine("INFO", "Starting AI enhancement."));

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

          logs.push(logLine("AI", "Step 3/3: Final mux and encode via FFmpeg."));
          await replaceVideoAudio(
            upscaledVideoPath,
            isolatedAudioPath,
            outputPath
          );

          logs.push(logLine("SUCCESS", "AI enhancement completed successfully."));

          result = {
            modeUsed: "ai",
            fallbackUsed: false,
            fallbackReason: null,
          };
        } finally {
          safeUnlink(isolatedAudioPath);
          safeUnlink(upscaledVideoPath);
        }
      }
    } else {
      logs.push(logLine("INFO", "Running Fast Mode."));
      await runFastEnhance(inputPath, outputPath);
      logs.push(logLine("SUCCESS", "Fast enhancement completed."));
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

    logs.push(logLine("ERROR", err.message || "Unknown server error."));

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