
# Media Enhancer Pro — Railway Production AI Build

This package keeps your **Fast Enhance** path and adds a real **AI Enhance** path.

## Included
- Fast Enhance: FFmpeg-based trim, cleanup, scaling, loudness shaping, MP4 export
- AI Enhance:
  - ElevenLabs Voice Isolation
  - fal video upscaling
  - FFmpeg mux of AI-upscaled video + isolated audio
- Premium UI
- PWA manifest + service worker
- Premium app icons

## Dynamic keys
AI mode asks the user for:
- ElevenLabs API key
- fal API key

These keys are:
- not stored on the server
- optional to remember in the browser only

## Railway deployment
1. Push this repo to GitHub
2. In Railway: New Project → Deploy from GitHub Repo
3. Railway detects the `Dockerfile`
4. Generate a public domain in Railway settings if needed

## First test
- Use a short clip
- Start with 1080p
- Use AI scale factor 2× first

## Notes
- The default fal model is `clarityai/crystal-video-upscaler`
- If your fal account uses another compatible video upscaler, change the model ID in the UI
- AI requests depend on your own ElevenLabs and fal account access, quotas, and billing
