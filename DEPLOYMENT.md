# Production Deployment Runbook

This guide covers building and hosting **HBD 3D Craft** on static edge networks.

---

## ⚡ Option 1: Cloudflare Pages (Recommended)

1. Build static distribution bundle:
   ```bash
   npm run build
   ```
2. Deploy directly via Wrangler:
   ```bash
   npx wrangler pages deploy dist --project-name hbd-3d-craft
   ```

---

## 🚀 Option 2: Vercel / Netlify / GitHub Pages

1. Connect your GitHub repository to Vercel or Netlify.
2. Set Build Command: `npm run build`
3. Set Output Directory: `dist`
4. Deploy!

---

## 🐳 Option 3: Dockerized Nginx

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

---

## 🔍 Pre-Deployment Verification

- [ ] Execute `npm run build` to confirm zero Vite bundling errors.
- [ ] Test card creation and share link generation in development server.
- [ ] Verify Web Audio API microphone permission prompt works in HTTPS environments.
