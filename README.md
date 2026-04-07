# Media Enhancer Pro — Railway Ready

This version is prepared for Railway using Docker and system FFmpeg.

## Files
- Dockerfile
- server.js
- package.json
- public/index.html

## Deploy on Railway
1. Create a new GitHub repo
2. Upload all files from this folder
3. Push to GitHub
4. In Railway, click New Project
5. Choose Deploy from GitHub Repo
6. Select this repo
7. Railway will build from the Dockerfile
8. After deploy, open /healthz to confirm the backend is live

## First test
- short clip
- 1080p
- Balanced

## Notes
- Railway docs support deploying Express apps from GitHub and also support Docker-based deployments.
- This app uses Docker so FFmpeg is installed at the OS level.
