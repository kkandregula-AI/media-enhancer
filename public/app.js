
const $ = (id) => document.getElementById(id);

const state = {
  mode: "fast",
  previewUrl: null,
  downloadUrl: null,
  installPrompt: null,
};

const els = {
  file: $("fileInput"),
  preview: $("preview"),
  progressBar: $("progressBar"),
  status: $("statusText"),
  log: $("log"),
  downloadBox: $("downloadBox"),
  downloadLink: $("downloadLink"),
  aiBox: $("aiBox"),
  fastBtn: $("modeFast"),
  aiBtn: $("modeAi"),
  installBtn: $("installBtn"),
  trimStart: $("trimStart"),
  trimEnd: $("trimEnd"),
  resolution: $("resolution"),
  preset: $("preset"),
  audioPreset: $("audioPreset"),
  crf: $("crf"),
  crfValue: $("crfValue"),
  audioGain: $("audioGain"),
  audioGainValue: $("audioGainValue"),
  modelId: $("modelId"),
  scaleFactor: $("scaleFactor"),
  elevenKey: $("elevenKey"),
  falKey: $("falKey"),
  rememberKeys: $("rememberKeys"),
  clearKeys: $("clearKeys"),
  fastAction: $("fastAction"),
  aiAction: $("aiAction"),
  resetAction: $("resetAction"),
};

function setMode(mode){
  state.mode = mode;
  const isAi = mode === "ai";
  els.aiBox.classList.toggle("hidden", !isAi);
  els.fastBtn.className = "mode-btn" + (mode === "fast" ? " active-fast" : "");
  els.aiBtn.className = "mode-btn" + (mode === "ai" ? " active-ai" : "");
  els.fastAction.classList.toggle("hidden", isAi);
  els.aiAction.classList.toggle("hidden", !isAi);
}

function setStatus(text){
  els.status.textContent = text;
}

function setProgress(pct){
  els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function log(msg){
  const stamp = new Date().toLocaleTimeString();
  els.log.textContent += `\n[${stamp}] ${msg}`;
  els.log.scrollTop = els.log.scrollHeight;
}

function clearLog(){
  els.log.textContent = "Ready.";
}

function setBusy(busy){
  [els.fastAction, els.aiAction, els.resetAction, els.file].forEach(el => el.disabled = busy);
}

function revokeUrls(){
  if(state.previewUrl){
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
  if(state.downloadUrl){
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}

function updateRangeLabels(){
  els.crfValue.textContent = els.crf.value;
  els.audioGainValue.textContent = `+${els.audioGain.value} dB`;
}

function saveKeysIfNeeded(){
  if(!els.rememberKeys.checked) return;
  localStorage.setItem("mei_eleven_key", els.elevenKey.value || "");
  localStorage.setItem("mei_fal_key", els.falKey.value || "");
  localStorage.setItem("mei_fal_model", els.modelId.value || "");
  localStorage.setItem("mei_scale_factor", els.scaleFactor.value || "");
}

function loadSavedKeys(){
  els.elevenKey.value = localStorage.getItem("mei_eleven_key") || "";
  els.falKey.value = localStorage.getItem("mei_fal_key") || "";
  els.modelId.value = localStorage.getItem("mei_fal_model") || "clarityai/crystal-video-upscaler";
  els.scaleFactor.value = localStorage.getItem("mei_scale_factor") || "2";
}

function clearSavedKeys(){
  localStorage.removeItem("mei_eleven_key");
  localStorage.removeItem("mei_fal_key");
  localStorage.removeItem("mei_fal_model");
  localStorage.removeItem("mei_scale_factor");
  els.elevenKey.value = "";
  els.falKey.value = "";
  els.modelId.value = "clarityai/crystal-video-upscaler";
  els.scaleFactor.value = "2";
  log("Saved AI keys cleared from this device.");
}

async function doRequest(url, formData, filenameStem){
  setBusy(true);
  setProgress(8);
  setStatus("Uploading & processing");
  els.downloadBox.style.display = "none";
  if(state.downloadUrl){
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }

  let pulse = 8;
  const timer = setInterval(() => {
    pulse += 2.8;
    if (pulse > 92) pulse = 20;
    setProgress(pulse);
  }, 900);

  try{
    const res = await fetch(url, { method: "POST", body: formData });
    log(`Server responded with status ${res.status}.`);

    if(!res.ok){
      const type = res.headers.get("content-type") || "";
      let message = "Processing failed.";
      if(type.includes("application/json")){
        const payload = await res.json();
        message = payload.error || message;
        if(payload.details) message += `\nDetails: ${payload.details}`;
        if(payload.stderr) message += `\nFFmpeg: ${payload.stderr}`;
      }else{
        const raw = await res.text();
        if(raw) message = raw;
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    if(!blob.size) throw new Error("Processed file is empty.");

    state.downloadUrl = URL.createObjectURL(blob);
    els.downloadLink.href = state.downloadUrl;
    els.downloadLink.download = `${filenameStem}-enhanced.mp4`;
    els.downloadBox.style.display = "block";
    setProgress(100);
    setStatus("Processing complete");
    log(`Done. Output size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  }catch(err){
    setProgress(0);
    setStatus("Failed");
    log(`Error: ${err.message || err}`);
  }finally{
    clearInterval(timer);
    setBusy(false);
  }
}

function buildCommonFormData(){
  const file = els.file.files?.[0];
  if(!file){
    alert("Please upload a video file first.");
    return null;
  }
  const fd = new FormData();
  fd.append("media", file);
  fd.append("trimStart", els.trimStart.value || "0");
  fd.append("trimEnd", els.trimEnd.value || "0");
  fd.append("resolution", els.resolution.value);
  fd.append("preset", els.preset.value);
  fd.append("audioPreset", els.audioPreset.value);
  fd.append("crf", els.crf.value);
  fd.append("audioGain", els.audioGain.value);
  return { fd, file };
}

async function runFastEnhance(){
  const built = buildCommonFormData();
  if(!built) return;
  clearLog();
  log("Starting fast enhancement.");
  await doRequest("/api/enhance-fast", built.fd, (built.file.name || "output").replace(/\.[^.]+$/, ""));
}

async function runAiEnhance(){
  const built = buildCommonFormData();
  if(!built) return;

  if(!els.elevenKey.value || !els.falKey.value){
    alert("Please enter both ElevenLabs and fal API keys for AI Enhance.");
    return;
  }

  saveKeysIfNeeded();

  built.fd.append("elevenKey", els.elevenKey.value.trim());
  built.fd.append("falKey", els.falKey.value.trim());
  built.fd.append("falModelId", els.modelId.value.trim() || "clarityai/crystal-video-upscaler");
  built.fd.append("scaleFactor", els.scaleFactor.value || "2");

  clearLog();
  log("Starting AI enhancement.");
  log("Step 1/3: Voice isolation via ElevenLabs.");
  log("Step 2/3: Video upscaling via fal.");
  log("Step 3/3: Final mux and encode via FFmpeg.");

  await doRequest("/api/enhance-ai", built.fd, (built.file.name || "output").replace(/\.[^.]+$/, ""));
}

function resetForm(){
  revokeUrls();
  els.file.value = "";
  els.preview.removeAttribute("src");
  els.preview.load();
  setStatus("Waiting for video");
  setProgress(0);
  els.downloadBox.style.display = "none";
  clearLog();
}

els.file.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if(!file) return;
  if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  els.preview.src = state.previewUrl;
  els.preview.load();
  setStatus("Video loaded");
  clearLog();
  log(`Loaded file: ${file.name}`);
  log(`Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
});

els.crf.addEventListener("input", updateRangeLabels);
els.audioGain.addEventListener("input", updateRangeLabels);
els.fastBtn.addEventListener("click", () => setMode("fast"));
els.aiBtn.addEventListener("click", () => setMode("ai"));
els.fastAction.addEventListener("click", runFastEnhance);
els.aiAction.addEventListener("click", runAiEnhance);
els.resetAction.addEventListener("click", resetForm);
els.clearKeys.addEventListener("click", clearSavedKeys);

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
  els.installBtn.disabled = false;
});

els.installBtn.addEventListener("click", async () => {
  if(!state.installPrompt) return;
  await state.installPrompt.prompt();
  state.installPrompt = null;
  els.installBtn.disabled = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

loadSavedKeys();
updateRangeLabels();
setMode("fast");
