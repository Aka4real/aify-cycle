-- ============================================================================
-- AifyCycle - Admin Panel, Live Presence & Full Telemetry Schema
-- Migration: 20261127_admin_telemetry.sql
-- Safe to run idempotently in Supabase Cloud SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extend public.profiles with presence & admin role metadata
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_active_view TEXT DEFAULT 'dial',
  ADD COLUMN IF NOT EXISTS last_client_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS session_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_profiles_last_seen
  ON public.profiles(last_seen_at DESC NULLS LAST);

-- Prevent authenticated end-users from self-escalating is_admin via client RLS
CREATE OR REPLACE FUNCTION public.guard_profile_admin_flag()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_admin := false;
    ELSIF TG_OP = 'UPDATE' AND NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      NEW.is_admin := OLD.is_admin;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS trg_profiles_guard_admin ON public.profiles;
CREATE TRIGGER trg_profiles_guard_admin
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_admin_flag();

-- ----------------------------------------------------------------------------
-- 2. TABLE: telemetry_sessions
-- Tracks active & historical sessions for registered users and guests
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_guest BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL DEFAULT 'guest',
  active_view TEXT NOT NULL DEFAULT 'dial',
  device_type TEXT NOT NULL DEFAULT 'desktop' CHECK (device_type IN ('desktop', 'mobile', 'tablet')),
  browser TEXT NOT NULL DEFAULT 'unknown',
  os TEXT NOT NULL DEFAULT 'unknown',
  app_version TEXT NOT NULL DEFAULT '1.1.0',
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'offline')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  heartbeat_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_last_seen
  ON public.telemetry_sessions(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_user
  ON public.telemetry_sessions(user_id, last_seen_at DESC);

ALTER TABLE public.telemetry_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telemetry_sessions FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. TABLE: presence_snapshots
-- 5-minute time-series snapshots of concurrent online users for charting
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.presence_snapshots (
  id BIGSERIAL PRIMARY KEY,
  bucket_at TIMESTAMPTZ NOT NULL UNIQUE,
  online_total INTEGER NOT NULL DEFAULT 0,
  online_registered INTEGER NOT NULL DEFAULT 0,
  online_guests INTEGER NOT NULL DEFAULT 0,
  active_views JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presence_snapshots_bucket
  ON public.presence_snapshots(bucket_at DESC);

ALTER TABLE public.presence_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.presence_snapshots FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. TABLE: telemetry_events
-- Privacy-safe aggregate product telemetry (never stores raw health text)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_guest BOOLEAN NOT NULL DEFAULT false,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_created
  ON public.telemetry_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_cat_act
  ON public.telemetry_events(category, action);

ALTER TABLE public.telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telemetry_events FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. TABLE: gemini_telemetry
-- Persistent Gemini API model cascade, latency, failover, and token telemetry
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gemini_telemetry (
  id BIGSERIAL PRIMARY KEY,
  task TEXT NOT NULL DEFAULT 'chat',
  requested_model TEXT NOT NULL,
  model_used TEXT,
  cascaded BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 1,
  status_code INTEGER NOT NULL DEFAULT 200,
  success BOOLEAN NOT NULL DEFAULT true,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  error_code TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gemini_telemetry_created
  ON public.gemini_telemetry(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gemini_telemetry_model
  ON public.gemini_telemetry(model_used, created_at DESC);

ALTER TABLE public.gemini_telemetry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gemini_telemetry FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. TABLE: client_error_logs
-- Sanitized frontend runtime & API error stream
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_error_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  error_type TEXT NOT NULL DEFAULT 'runtime',
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  view_name TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT 'desktop',
  app_version TEXT NOT NULL DEFAULT '1.1.0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_error_logs_created
  ON public.client_error_logs(created_at DESC);

ALTER TABLE public.client_error_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.client_error_logs FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. TABLE: admin_audit_logs
-- Immutable record of administrative actions, probes, and exports
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_identity TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
  ON public.admin_audit_logs(created_at DESC);

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_audit_logs FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. RPC: public.get_db_integrity_report()
-- Service-role-only comprehensive PostgreSQL & schema integrity inspector
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_db_integrity_report()
RETURNS JSONB AS $$
DECLARE
  v_tables JSONB;
  v_orphans JSONB;
  v_anomalies JSONB;
  v_functions JSONB;
  v_db_stats JSONB;
  v_legacy JSONB;
  v_orphan_profiles BIGINT := 0;
  v_orphan_logs BIGINT := 0;
  v_orphan_memories BIGINT := 0;
  v_orphan_chats BIGINT := 0;
  v_orphan_shares BIGINT := 0;
  v_users_without_profile BIGINT := 0;
  v_future_logs BIGINT := 0;
  v_null_lps_profiles BIGINT := 0;
  v_telemetry_opt_in BIGINT := 0;
  v_total_profiles BIGINT := 0;
  v_legacy_total BIGINT := 0;
  v_legacy_unclaimed BIGINT := 0;
BEGIN
  -- A. Table-level RLS, policy count, estimated rows, storage size, dead tuples
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.table_name), '[]'::jsonb)
  INTO v_tables
  FROM (
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      COALESCE(pol.policy_count, 0) AS policy_count,
      COALESCE(s.n_live_tup, 0) AS live_rows,
      COALESCE(s.n_dead_tup, 0) AS dead_tuples,
      COALESCE(s.seq_scan, 0) AS seq_scans,
      COALESCE(s.idx_scan, 0) AS idx_scans,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_indexes_size(c.oid) AS index_bytes,
      s.last_autovacuum,
      s.last_autoanalyze
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    LEFT JOIN (
      SELECT tablename, count(*)::int AS policy_count
      FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY tablename
    ) pol ON pol.tablename = c.relname
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  ) t;

  -- B. Referential & orphan scans
  SELECT count(*) INTO v_orphan_profiles
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.id IS NULL;

  SELECT count(*) INTO v_orphan_logs
  FROM public.cycle_logs l
  LEFT JOIN auth.users u ON u.id = l.user_id
  WHERE u.id IS NULL;

  SELECT count(*) INTO v_orphan_memories
  FROM public.ai_memories m
  LEFT JOIN auth.users u ON u.id = m.user_id
  WHERE u.id IS NULL;

  SELECT count(*) INTO v_orphan_chats
  FROM public.ai_chat_history h
  LEFT JOIN auth.users u ON u.id = h.user_id
  WHERE u.id IS NULL;

  SELECT count(*) INTO v_orphan_shares
  FROM public.partner_shares s
  LEFT JOIN auth.users u ON u.id = s.owner_id
  WHERE u.id IS NULL;

  SELECT count(*) INTO v_users_without_profile
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE p.id IS NULL AND COALESCE(u.is_anonymous, false) = false;

  v_orphans := jsonb_build_object(
    'orphan_profiles', v_orphan_profiles,
    'orphan_cycle_logs', v_orphan_logs,
    'orphan_ai_memories', v_orphan_memories,
    'orphan_ai_chat_history', v_orphan_chats,
    'orphan_partner_shares', v_orphan_shares,
    'registered_users_without_profile', v_users_without_profile
  );

  -- C. Data domain & privacy posture metrics
  SELECT count(*) INTO v_total_profiles FROM public.profiles;
  SELECT count(*) INTO v_null_lps_profiles FROM public.profiles WHERE last_period_start IS NULL;
  SELECT count(*) INTO v_telemetry_opt_in FROM public.profiles WHERE telemetry_enabled = true;
  SELECT count(*) INTO v_future_logs FROM public.cycle_logs WHERE date_key > (CURRENT_DATE + INTERVAL '30 days');

  v_anomalies := jsonb_build_object(
    'total_profiles', v_total_profiles,
    'profiles_missing_last_period_start', v_null_lps_profiles,
    'future_dated_cycle_logs', v_future_logs,
    'telemetry_opt_in_count', v_telemetry_opt_in
  );

  -- D. Legacy user import queue (if table exists)
  IF to_regclass('public.legacy_user_imports') IS NOT NULL THEN
    EXECUTE 'SELECT count(*), count(*) FILTER (WHERE claimed_at IS NULL) FROM public.legacy_user_imports'
      INTO v_legacy_total, v_legacy_unclaimed;
  END IF;

  v_legacy := jsonb_build_object(
    'table_exists', to_regclass('public.legacy_user_imports') IS NOT NULL,
    'total_imports', v_legacy_total,
    'unclaimed_imports', v_legacy_unclaimed
  );

  -- E. Critical security functions check
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', p.proname,
    'security_definer', p.prosecdef,
    'config', p.proconfig
  ) ORDER BY p.proname), '[]'::jsonb)
  INTO v_functions
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'set_updated_at',
      'delete_user_data',
      'claim_legacy_user_data',
      'handle_auth_user_claim_legacy',
      'guard_profile_admin_flag',
      'get_db_integrity_report'
    );

  -- F. Database-wide engine health stats
  SELECT jsonb_build_object(
    'pg_version', split_part(version(), ' ', 2),
    'database_size_bytes', pg_database_size(current_database()),
    'active_connections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
    'cache_hit_ratio', COALESCE((
      SELECT ROUND((blks_hit::numeric / NULLIF(blks_hit + blks_read, 0)) * 100, 2)
      FROM pg_stat_database
      WHERE datname = current_database()
    ), 100),
    'tx_commit_ratio', COALESCE((
      SELECT ROUND((xact_commit::numeric / NULLIF(xact_commit + xact_rollback, 0)) * 100, 2)
      FROM pg_stat_database
      WHERE datname = current_database()
    ), 100),
    'deadlocks', COALESCE((
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()
    ), 0)
  ) INTO v_db_stats;

  RETURN jsonb_build_object(
    'generated_at', NOW(),
    'tables', v_tables,
    'orphans', v_orphans,
    'anomalies', v_anomalies,
    'legacy', v_legacy,
    'functions', v_functions,
    'database', v_db_stats
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.get_db_integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_integrity_report() TO service_role;
