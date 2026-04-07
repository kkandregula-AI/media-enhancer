const express = require("express")
const multer = require("multer")
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")
const fsp = require("fs/promises")
const os = require("os")
const path = require("path")
const axios = require("axios")
const FormData = require("form-data")

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg")

const app = express()
const upload = multer({ dest: os.tmpdir() })

app.use(express.static("public"))

const tmp = name => path.join(os.tmpdir(), Date.now() + "-" + name)

// ------------------
// TRIM
// ------------------
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

// ------------------
// ELEVENLABS FIXED
// ------------------
async function isolateAudio(inputPath, filename, key){
  const form = new FormData()

  form.append("file", fs.createReadStream(inputPath), {
    filename: filename || "input.mp4",
    contentType: "video/mp4"
  })

  try {
    const response = await axios.post(
      "https://api.elevenlabs.io/v1/audio-isolation",
      form,
      {
        headers: {
          "xi-api-key": key,
          ...form.getHeaders()
        },
        responseType: "arraybuffer"
      }
    )

    const out = tmp("audio.mp3")
    await fsp.writeFile(out, response.data)
    return out

  } catch (err) {
    if (err.response) {
      throw new Error("ElevenLabs failed: " + JSON.stringify(err.response.data))
    }
    throw err
  }
}

// ------------------
// FAL UPSCALE
// ------------------
async function falUpscale(input, key){

  const uploadRes = await fetch("https://fal.run/storage/upload", {
    method: "POST",
    headers: { "Authorization": `Key ${key}` },
    body: fs.createReadStream(input)
  })

  const uploadData = await uploadRes.json()
  const video_url = uploadData.url

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

// ------------------
// MERGE
// ------------------
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

// ------------------
// FAST ROUTE
// ------------------
app.post("/api/enhance-fast", upload.single("media"), async(req,res)=>{
  const input=req.file.path
  const output=tmp("fast.mp4")

  await new Promise((resolve,reject)=>{
    ffmpeg(input).save(output).on("end",resolve).on("error",reject)
  })

  res.sendFile(output)
})

// ------------------
// AI ROUTE
// ------------------
app.post("/api/enhance-ai", upload.single("media"), async(req,res)=>{
  let input=req.file.path
  let trimmed=tmp("trim.mp4")
  let audio=null
  let video=null
  let output=tmp("final.mp4")

  try{
    const eleven=req.body.elevenKey
    const fal=req.body.falKey

    if(!eleven || !fal) throw new Error("Missing API keys")

    await trimVideo(input, trimmed, 0, 15)

    audio = await isolateAudio(trimmed, req.file.originalname, eleven)
    video = await falUpscale(trimmed, fal)

    await merge(video, audio, output)

    res.sendFile(output)

  }catch(e){
    res.status(500).send(e.message)
  }
})

// ------------------
app.get("/healthz",(req,res)=>res.json({ok:true}))

app.listen(process.env.PORT||3000,"0.0.0.0")