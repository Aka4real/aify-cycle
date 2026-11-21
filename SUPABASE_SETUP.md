# AifyCycle — Supabase Cloud Migration & Google OAuth Setup

This guide walks through running **AifyCycle** on **Supabase Cloud (`*.supabase.co`)** with **Google Sign-In (PKCE OAuth)** on **Vercel** and localhost, plus migrating public table data from an older self-hosted Supabase instance.

---

## 1. Apply Database Schema on Supabase Cloud

1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** → **New query**.
3. Run [`supabase/migrations/20260924_initial_schema.sql`](./supabase/migrations/20260924_initial_schema.sql) to create all tables (`profiles`, `cycle_logs`, `ai_memories`, `ai_chat_history`, `partner_shares`), RLS policies, `updated_at` triggers, and the hardened `delete_user_data()` RPC.
4. *(If migrating table data from self-hosted Supabase)* Run [`supabase/migrations/20261121_legacy_data_claim.sql`](./supabase/migrations/20261121_legacy_data_claim.sql) to install the locked-down `legacy_user_imports` staging table and automatic claim-on-confirmed-signin trigger.

---

## 2. Migrate Public Table Data (Self-Hosted → Supabase Cloud)

Users do **not** need password hashes migrated — they simply sign in with Google (or re-register with their email) on Supabase Cloud, and their historical data attaches automatically to their new account.

1. Open your **old self-hosted Supabase Studio → SQL Editor**.
2. Paste and run [`supabase/export_from_self_hosted.sql`](./supabase/export_from_self_hosted.sql).
3. Copy all statements from the `insert_sql` column.
4. Paste and run them in your **new Supabase Cloud → SQL Editor**.
5. When a user signs in with Google (or confirms an email signup) matching their previous email, their profile, cycle logs, AI memories, and chat history are automatically migrated once.
   - If a user signs in with a **different** email or had an **anonymous** account (`anonymous-<old-uuid>`), attach their records manually in SQL Editor:
     ```sql
     SELECT public.claim_legacy_user_data('<new-auth-user-uuid>', 'old@email.com');
     ```

---

## 3. Configure Google OAuth

### A. Google Cloud Console
1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Configure the **OAuth consent screen** (User Type: **External**, add your app name and support email; while in Testing mode, add your Gmail under **Test users**, or publish to Production when ready).
3. Click **Create Credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add:
   ```text
   https://<your-project>.vercel.app
   http://localhost:3000
   ```
5. Under **Authorized redirect URIs**, add your Supabase Cloud callback URL:
   ```text
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
6. Copy the generated **Client ID** and **Client Secret**.

### B. Supabase Cloud Dashboard
1. Go to **Authentication → Providers → Google**.
2. Toggle **Enable Sign in with Google** to **ON**.
3. Paste the Google **Client ID** and **Client Secret**, then click **Save**.
4. *(Optional)* Under **Authentication → Providers → Anonymous Sign-ins**, toggle **ON** if you want Guest Mode to create temporary cloud sessions (otherwise Guest Mode runs locally).
5. Go to **Authentication → URL Configuration**:
   - **Site URL**: `https://<your-project>.vercel.app`
   - **Redirect URLs**:
     ```text
     https://<your-project>.vercel.app/**
     https://*.vercel.app/**
     http://localhost:3000/**
     http://localhost:4180/**
     ```
   - Click **Save**.

> **Sign in with Apple (later):** The Apple button stays hidden automatically until **Authentication → Providers → Apple** is enabled in Supabase Cloud. Once enabled with your Apple Developer Services ID + `.p8` key, the button appears automatically with no code changes.

---

## 4. Configure Environment Variables (Local + Vercel)

Find **Project URL** and **anon public key** in **Supabase Dashboard → Project Settings → API** (or **Data API / API Keys**).

### Local (`.env`)
```env
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-supabase-anon-key>
```

### Vercel
1. Open your project in **Vercel Dashboard → Settings → Environment Variables** (or run `vercel env add`).
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` for **Production** and **Preview**.
3. Trigger a redeploy.

> **Important:** If you previously saved custom self-hosted Supabase credentials inside the app's **Settings → Supabase Cloud Sync → Configure Custom Credentials**, click **Disconnect / Reset** once so your browser switches to the new server-configured Supabase Cloud URL.
