const express=require("express")
const multer=require("multer")
const ffmpeg=require("fluent-ffmpeg")
const fs=require("fs")
const os=require("os")
const path=require("path")

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg")

const app=express()
const upload=multer({dest:os.tmpdir()})

app.use(express.static("public"))

app.post("/api/enhance", upload.single("media"), async(req,res)=>{
 const input=req.file.path
 const output=path.join(os.tmpdir(),Date.now()+".mp4")

 try{
  await new Promise((resolve,reject)=>{
   ffmpeg(input).outputOptions(["-preset ultrafast"])
   .save(output).on("end",resolve).on("error",reject)
  })

  res.sendFile(output, ()=>{fs.unlinkSync(input);fs.unlinkSync(output)})
 }catch(e){
  res.status(500).send(e.message)
 }
})

app.get("/healthz",(req,res)=>res.json({ok:true}))
app.listen(process.env.PORT||3000,"0.0.0.0")
