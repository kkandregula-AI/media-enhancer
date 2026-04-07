const express = require("express")
const multer = require("multer")
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")
const fsp = require("fs/promises")
const os = require("os")
const path = require("path")
const FormData = require("form-data")

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg")

const app = express()
const upload = multer({ dest: os.tmpdir() })

app.use(express.static("public"))

const tmp = name => path.join(os.tmpdir(), Date.now() + "-" + name)

// ----------------------
// STEP 1: TRIM VIDEO
// ----------------------
function trimVideo(input, output, start, duration){
  return new Promise((res, rej)=>{
    ffmpeg(input)
      .setStartTime(start)
      .duration(duration)
      .outputOptions(["-preset ultrafast"])
      .save(output)
      .on("end", res)
      .on("error", rej)
  })
}

// ----------------------
// STEP 2: ELEVENLABS
// ----------------------
async function isolateAudio(input, filename, key){
  const form = new FormData()

  form.append("file", fs.createReadStream(input), {
    filename: filename || "input.mp4",
    contentType: "video/mp4"
  })

  const res = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
    method: "POST",
    headers: {
      "xi-api-key": key,
      ...form.getHeaders()
    },
    body: form
  })

  if(!res.ok){
    throw new Error("ElevenLabs failed: " + await res.text())
  }

  const out = tmp("audio.mp3")
  const buffer = await res.arrayBuffer()
  await fsp.writeFile(out, Buffer.from(buffer))
  return out
}

// ----------------------
// STEP 3: FAL UPLOAD + POLL
// ----------------------
async function falUpscale(input, filename, key){

  // upload file
  const uploadRes = await fetch("https://fal.run/storage/upload", {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`
    },
    body: fs.createReadStream(input)
  })

  const uploadData = await uploadRes.json()
  const video_url = uploadData.url

  // submit job
  const submit = await fetch("https://fal.run/fal-ai/video-upscale", {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ video_url })
  })

  const job = await submit.json()
  const id = job.request_id

  // poll
  while(true){
    await new Promise(r=>setTimeout(r,4000))

    const statusRes = await fetch(`https://fal.run/fal-ai/video-upscale/requests/${id}`,{
      headers:{ "Authorization": `Key ${key}` }
    })

    const status = await statusRes.json()

    if(status.status==="COMPLETED"){
      const url = status.output.video.url

      const out = tmp("video.mp4")
      const res = await fetch(url)
      const buf = await res.arrayBuffer()
      await fsp.writeFile(out, Buffer.from(buf))
      return out
    }

    if(status.status==="FAILED"){
      throw new Error("fal failed")
    }
  }
}

// ----------------------
// STEP 4: MERGE
// ----------------------
function merge(video, audio, out){
  return new Promise((res,rej)=>{
    ffmpeg()
      .input(video)
      .input(audio)
      .outputOptions([
        "-map 0:v",
        "-map 1:a",
        "-c:v copy",
        "-c:a aac",
        "-shortest"
      ])
      .save(out)
      .on("end", res)
      .on("error", rej)
  })
}

// ----------------------
// ROUTES
// ----------------------

app.post("/api/enhance-fast", upload.single("media"), async(req,res)=>{
  const input=req.file.path
  const output=tmp("fast.mp4")

  await new Promise((resolve,reject)=>{
    ffmpeg(input).save(output).on("end",resolve).on("error",reject)
  })

  res.sendFile(output)
})

app.post("/api/enhance-ai", upload.single("media"), async(req,res)=>{
  let input=req.file.path
  let trimmed=tmp("trim.mp4")
  let audio=null
  let video=null
  let output=tmp("final.mp4")

  try{
    const eleven=req.body.elevenKey
    const fal=req.body.falKey

    if(!eleven || !fal) throw new Error("Missing keys")

    // trim
    await trimVideo(input, trimmed, 0, 15)

    // AI steps
    audio = await isolateAudio(trimmed, req.file.originalname, eleven)
    video = await falUpscale(trimmed, req.file.originalname, fal)

    // merge
    await merge(video, audio, output)

    res.sendFile(output)

  }catch(e){
    res.status(500).send(e.message)
  }
})

// health
app.get("/healthz",(req,res)=>res.json({ok:true}))

app.listen(process.env.PORT||3000,"0.0.0.0")