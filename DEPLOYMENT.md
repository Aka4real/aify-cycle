# 🚀 AifyCycle Deployment Guide

This guide details how to deploy **AifyCycle** across **Vercel**, **Coolify (VPS)**, **OpenShip**, and standard **Docker / Node.js** environments with zero 404 routing errors.

---

## 🔑 Environment Variables Required

On **ALL** platforms, configure the following environment variable in the platform dashboard:

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | **Yes** | Your Google Gemini API Key | `AIzaSy...` |
| `GEMINI_MODEL` | No (Default: `gemini-3.6-flash`) | Gemini model version | `gemini-3.6-flash` |
| `PORT` | Auto (Default: `3000`) | Listening port | `3000` |

> [!CAUTION]
> Never commit `.env` or your raw `GEMINI_API_KEY` to GitHub. Always inject it via the hosting dashboard.

---

## 1. Deploying on Vercel (Recommended for Serverless)

AifyCycle is fully configured for Vercel with dedicated serverless functions (`api/gemini.js`, `api/gemini/status.js`, `api/compliance/status.js`) and SPA fallback routing.

### Step-by-Step:
1. Log in to [Vercel Dashboard](https://vercel.com/dashboard).
2. Click **Add New...** -> **Project**.
3. Select the **`Aka4real/aify-cycle`** repository and click **Import**.
4. Configure Project Settings:
   - **Framework Preset:** `Other` (or leave default)
   - **Root Directory:** `./`
   - **Build Command:** Leave default (`npm run build` or empty)
   - **Output Directory:** Leave empty (serves root static assets)
5. Under **Environment Variables**:
   - Add Key: `GEMINI_API_KEY`
   - Value: `<Your Google Gemini API Key>`
6. Click **Deploy**.
7. Once deployed, visit your `https://<your-project>.vercel.app`. Both the frontend and `/api/gemini/status` will be live.

---

## 2. Deploying on Coolify (VPS via Docker & Traefik)

Coolify routes external web traffic through its Traefik reverse proxy directly to port **`3000`**. AifyCycle's `Dockerfile` is standardized on port `3000` with an automatic secondary listener on `4180`.

### Step-by-Step:
1. Open your **Coolify Dashboard** on your VPS.
2. Navigate to **Projects** -> Select your environment -> **+ New Resource**.
3. Choose **Public Repository** (or Private with GitHub App) and enter:
   ```
   https://github.com/Aka4real/aify-cycle.git
   ```
   Branch: `main`
4. In the Application configuration:
   - **Build Pack:** `Dockerfile`
   - **Ports Exposes:** `3000` (Coolify's default)
   - **Domains:** Set your custom domain or Coolify preview domain (e.g., `https://aify.yourdomain.com`).
5. In **Environment Variables**:
   - Add `GEMINI_API_KEY=<your-key>`
   - (Optional) `PORT=3000`
6. Click **Deploy**.
7. Coolify builds the Docker container and Traefik connects to port `3000`. No more 404 errors!

---

## 3. Deploying on OpenShip

OpenShip requires an active Docker build and a connected domain or public endpoint.

### Step-by-Step:
1. Open your **OpenShip Console**.
2. Select or create project **`aify-cycle`**.
3. Under **Settings / General**:
   - **Framework:** `docker`
   - **Build Strategy:** `dockerfile`
   - **Container Port:** `3000`
4. Under **Domains / Endpoints**:
   - Click **Add Domain** (e.g. `aify.yourdomain.com` or free subdomain).
   - Verify DNS points to your server IP.
5. Under **Environment Variables**:
   - Set `GEMINI_API_KEY`
   - Set `PORT=3000`
6. Trigger **Redeploy**.

---

## 4. Deploying with Docker Standalone (VPS / Cloud Server)

To run directly on any Linux VPS or server with Docker:

```bash
# 1. Clone repository
git clone https://github.com/Aka4real/aify-cycle.git
cd aify-cycle

# 2. Build Docker container
docker build -t aify-cycle .

# 3. Run container binding to port 3000 (and optional 4180)
docker run -d \
  --name aify-cycle \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 4180:4180 \
  -e GEMINI_API_KEY="your-gemini-api-key" \
  aify-cycle
```

Verify in browser at: `http://<your-vps-ip>:3000`

---

## 5. Local Node.js Development

```bash
# Install / ensure Node 20+
node -v

# Create .env file with your key
echo "GEMINI_API_KEY=your_key_here" > .env

# Start server (listens on both 3000 and 4180)
npm start
```
Open [http://localhost:3000](http://localhost:3000) or [http://localhost:4180](http://localhost:4180).
