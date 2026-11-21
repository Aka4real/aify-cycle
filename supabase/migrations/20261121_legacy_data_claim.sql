-- ============================================================================
-- AifyCycle - Legacy Table Data Claim Migration (Self-Hosted -> Supabase Cloud)
-- Migration: 20261121_legacy_data_claim.sql
--
-- Allows migrating public table rows (profiles, cycle_logs, ai_memories,
-- ai_chat_history) without migrating auth.users password hashes.
--
-- When a user signs in with Google (or confirms an email/password signup)
-- on Supabase Cloud using the same email address, their historical records
-- are automatically attached to their new auth.uid() once.
-- ============================================================================

-- 1. Locked-down staging table (RLS enabled with zero client policies)
CREATE TABLE IF NOT EXISTS public.legacy_user_imports (
  email TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claimed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.legacy_user_imports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.legacy_user_imports FROM PUBLIC, anon, authenticated;

-- 2. Atomic claim function (callable by trigger or manually by admin in SQL Editor)
CREATE OR REPLACE FUNCTION public.claim_legacy_user_data(p_user_id UUID, p_email TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_email TEXT := lower(trim(COALESCE(p_email, '')));
  v_payload JSONB;
  v_profile JSONB;
BEGIN
  IF p_user_id IS NULL OR v_email = '' THEN
    RETURN FALSE;
  END IF;

  SELECT payload
    INTO v_payload
    FROM public.legacy_user_imports
   WHERE email = v_email
     AND claimed_at IS NULL
     FOR UPDATE;

  IF v_payload IS NULL THEN
    RETURN FALSE;
  END IF;

  -- A. Profile
  v_profile := v_payload->'profile';
  IF v_profile IS NOT NULL AND jsonb_typeof(v_profile) = 'object' THEN
    INSERT INTO public.profiles (
      id,
      user_name,
      partner_name,
      cycle_length,
      period_length,
      last_period_start,
      reminder_enabled,
      notifications,
      telemetry_enabled,
      created_at,
      updated_at
    ) VALUES (
      p_user_id,
      COALESCE(NULLIF(v_profile->>'user_name', ''), 'User'),
      COALESCE(v_profile->>'partner_name', ''),
      LEAST(45, GREATEST(21, COALESCE((v_profile->>'cycle_length')::integer, 28))),
      LEAST(10, GREATEST(2, COALESCE((v_profile->>'period_length')::integer, 5))),
      NULLIF(v_profile->>'last_period_start', '')::date,
      COALESCE((v_profile->>'reminder_enabled')::boolean, true),
      COALESCE(v_profile->'notifications', '{"periodReminderDays": 2, "fertileWindowAlert": true}'::jsonb),
      COALESCE((v_profile->>'telemetry_enabled')::boolean, false),
      COALESCE(NULLIF(v_profile->>'created_at', '')::timestamptz, NOW()),
      COALESCE(NULLIF(v_profile->>'updated_at', '')::timestamptz, NOW())
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- B. Daily Cycle Logs
  INSERT INTO public.cycle_logs (
    user_id,
    date_key,
    flow,
    symptoms,
    moods,
    water_glasses,
    sleep_hours,
    basal_temp,
    cervical_mucus,
    intercourse,
    intercourse_protected,
    notes,
    encrypted_payload,
    created_at,
    updated_at
  )
  SELECT
    p_user_id,
    (elem->>'date_key')::date,
    CASE WHEN elem->>'flow' IN ('none', 'spotting', 'light', 'medium', 'heavy') THEN elem->>'flow' ELSE NULL END,
    COALESCE(
      (SELECT array_agg(s) FROM jsonb_array_elements_text(COALESCE(elem->'symptoms', '[]'::jsonb)) AS s),
      '{}'::text[]
    ),
    COALESCE(
      (SELECT array_agg(m) FROM jsonb_array_elements_text(COALESCE(elem->'moods', '[]'::jsonb)) AS m),
      '{}'::text[]
    ),
    GREATEST(0, COALESCE((elem->>'water_glasses')::integer, 0)),
    LEAST(24.0, GREATEST(0.0, COALESCE(NULLIF(elem->>'sleep_hours', '')::numeric, 0.0))),
    CASE
      WHEN NULLIF(elem->>'basal_temp', '') IS NOT NULL
       AND (elem->>'basal_temp')::numeric BETWEEN 35.0 AND 42.0
      THEN (elem->>'basal_temp')::numeric
      ELSE NULL
    END,
    CASE WHEN elem->>'cervical_mucus' IN ('dry', 'sticky', 'creamy', 'egg_white', 'watery') THEN elem->>'cervical_mucus' ELSE NULL END,
    COALESCE((elem->>'intercourse')::boolean, false),
    COALESCE((elem->>'intercourse_protected')::boolean, true),
    elem->>'notes',
    elem->>'encrypted_payload',
    COALESCE(NULLIF(elem->>'created_at', '')::timestamptz, NOW()),
    COALESCE(NULLIF(elem->>'updated_at', '')::timestamptz, NOW())
  FROM jsonb_array_elements(COALESCE(v_payload->'cycle_logs', '[]'::jsonb)) AS elem
  WHERE NULLIF(elem->>'date_key', '') IS NOT NULL
  ON CONFLICT (user_id, date_key) DO NOTHING;

  -- C. AI Memories
  INSERT INTO public.ai_memories (
    user_id,
    category,
    fact,
    source,
    confidence,
    created_at,
    updated_at
  )
  SELECT
    p_user_id,
    CASE
      WHEN elem->>'category' IN ('remedy_preference', 'cycle_pattern', 'lifestyle_habit', 'personal_goal', 'sensitivity_trigger', 'general')
      THEN elem->>'category'
      ELSE 'general'
    END,
    elem->>'fact',
    COALESCE(elem->>'source', 'Migrated record'),
    CASE WHEN elem->>'confidence' IN ('low', 'medium', 'high') THEN elem->>'confidence' ELSE 'high' END,
    COALESCE(NULLIF(elem->>'created_at', '')::timestamptz, NOW()),
    COALESCE(NULLIF(elem->>'updated_at', '')::timestamptz, NOW())
  FROM jsonb_array_elements(COALESCE(v_payload->'ai_memories', '[]'::jsonb)) AS elem
  WHERE NULLIF(trim(COALESCE(elem->>'fact', '')), '') IS NOT NULL;

  -- D. AI Chat History
  INSERT INTO public.ai_chat_history (
    user_id,
    role,
    content,
    action_card,
    latency_ms,
    created_at
  )
  SELECT
    p_user_id,
    CASE WHEN elem->>'role' = 'assistant' THEN 'assistant' ELSE 'user' END,
    COALESCE(elem->>'content', ''),
    elem->'action_card',
    NULLIF(elem->>'latency_ms', '')::integer,
    COALESCE(NULLIF(elem->>'created_at', '')::timestamptz, NOW())
  FROM jsonb_array_elements(COALESCE(v_payload->'ai_chat_history', '[]'::jsonb)) AS elem
  WHERE NULLIF(COALESCE(elem->>'content', ''), '') IS NOT NULL;

  UPDATE public.legacy_user_imports
     SET claimed_at = NOW(),
         claimed_by = p_user_id
   WHERE email = v_email;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Restrict manual execution strictly to database owner / service_role
REVOKE ALL ON FUNCTION public.claim_legacy_user_data(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- 3. Trigger on auth.users: auto-claim ONLY once email is confirmed (automatic for Google OAuth)
CREATE OR REPLACE FUNCTION public.handle_auth_user_claim_legacy()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    BEGIN
      PERFORM public.claim_legacy_user_data(NEW.id, NEW.email);
    EXCEPTION WHEN OTHERS THEN
      -- Never block user sign-up if a legacy row has unexpected data
      RAISE WARNING '[AifyCycle] Legacy data claim skipped for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.handle_auth_user_claim_legacy() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_claim_legacy_data ON auth.users;
CREATE TRIGGER on_auth_user_claim_legacy_data
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_claim_legacy();
