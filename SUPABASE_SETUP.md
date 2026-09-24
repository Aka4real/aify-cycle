# 🚀 AifyCycle: Supabase Integration & Cloud Setup Guide

This guide details how to connect **Supabase** to your AifyCycle deployment to enable **secure cloud backups, multi-device synchronization, real-time partner sharing, and persistent account authentication**, while maintaining our sub-50ms local-first offline speed.

---

## 📋 Overview of Architecture

- **Local-First Speed**: Reads and writes complete instantly (0ms latency) in local storage, so cycle tracking works seamlessly even on airplanes or without an internet connection.
- **Background Cloud Sync**: When connected to Supabase, logs, symptoms, cycle settings, and AI memories automatically replicate to your PostgreSQL database.
- **Row-Level Security (RLS)**: Sensitive reproductive health data is locked strictly to `auth.uid() = user_id`.
- **Zero-Crash Resilience**: If Supabase is unconfigured or offline, AifyCycle automatically falls back to standalone local mode.

---

## 🛠️ Step-by-Step Setup

### Step 1: Create a Free Supabase Project
1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New Project**, choose an organization, and give your project a name (e.g. `aify-cycle`).
3. Set a strong database password and select the region closest to your users.

---

### Step 2: Run the Database Migration
1. In your Supabase Dashboard, navigate to the **SQL Editor** (icon on the left navigation bar).
2. Click **New query**.
3. Copy the entire contents of [`supabase/migrations/20260924_initial_schema.sql`](./supabase/migrations/20260924_initial_schema.sql) and paste it into the editor.
4. Click **Run** (or `Ctrl+Enter` / `Cmd+Enter`).
5. You should see a confirmation that all tables (`profiles`, `cycle_logs`, `ai_memories`, `ai_chat_history`, `partner_shares`) and Row Level Security (RLS) policies were created successfully.

---

### Step 3: Enable Anonymous Sign-ins (Recommended)
To allow users to track their cycles immediately as a Guest without friction:
1. In Supabase Dashboard, go to **Authentication** ➔ **Providers**.
2. Scroll to **Anonymous Sign-ins** and toggle it **ON**.
3. Click **Save**.

---

### Step 4: Configure Environment Variables

1. In Supabase Dashboard, navigate to **Project Settings** (gear icon) ➔ **API**.
2. Find:
   - **Project URL**: e.g., `https://xyzcompany.supabase.co`
   - **Project API Keys** ➔ `anon` `public`: e.g., `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

3. In your server `.env` file (or in your **Coolify** / **Vercel** environment dashboard), add:
```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

4. Restart your Node server or trigger a redeploy in Coolify.

---

## 🔒 Security & Privacy Guarantees

| Feature | Implementation | Protection Level |
| :--- | :--- | :--- |
| **Row Level Security (RLS)** | Postgres RLS policies on all tables | Only `auth.uid()` can read/write their own health logs |
| **Public API Key Safe** | Uses Supabase `anon` public key | Safe in client-side code; cannot bypass RLS |
| **GDPR Article 17** | `rpc('delete_user_data')` function | Permanently purges all profile records, symptoms, AI chats, and memories |
| **Offline Sandbox** | Local-First Storage Adapter | Operates 100% offline if cloud is unreachable |
