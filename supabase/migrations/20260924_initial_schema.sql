-- ============================================================================
-- AifyCycle - Supabase PostgreSQL Schema & Security Policies
-- Migration: 20260924_initial_schema.sql
-- ============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: profiles
-- Stores user cycle calibration, notification preferences, and metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL DEFAULT 'User',
  partner_name TEXT DEFAULT 'Partner',
  cycle_length INTEGER NOT NULL DEFAULT 28 CHECK (cycle_length BETWEEN 21 AND 45),
  period_length INTEGER NOT NULL DEFAULT 5 CHECK (period_length BETWEEN 2 AND 10),
  last_period_start DATE NOT NULL,
  reminder_enabled BOOLEAN NOT NULL DEFAULT true,
  notifications JSONB NOT NULL DEFAULT '{"periodReminderDays": 2, "fertileWindowAlert": true}'::jsonb,
  telemetry_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view and manage their own profile" ON public.profiles;
CREATE POLICY "Users can view and manage their own profile"
  ON public.profiles
  FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ============================================================================
-- TABLE: cycle_logs
-- Daily reproductive, symptom, mood, and biometric health logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cycle_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key DATE NOT NULL,
  flow TEXT CHECK (flow IN ('none', 'spotting', 'light', 'medium', 'heavy')),
  symptoms TEXT[] DEFAULT '{}',
  moods TEXT[] DEFAULT '{}',
  water_glasses INTEGER DEFAULT 0 CHECK (water_glasses >= 0),
  sleep_hours NUMERIC(3,1) DEFAULT 0.0 CHECK (sleep_hours >= 0 AND sleep_hours <= 24),
  basal_temp NUMERIC(4,2) CHECK (basal_temp BETWEEN 35.0 AND 42.0),
  cervical_mucus TEXT CHECK (cervical_mucus IN ('dry', 'sticky', 'creamy', 'egg_white', 'watery')),
  intercourse BOOLEAN DEFAULT false,
  intercourse_protected BOOLEAN DEFAULT true,
  notes TEXT,
  encrypted_payload TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_cycle_logs_user_date ON public.cycle_logs(user_id, date_key DESC);

ALTER TABLE public.cycle_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own cycle logs" ON public.cycle_logs;
CREATE POLICY "Users can manage their own cycle logs"
  ON public.cycle_logs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- TABLE: ai_memories
-- Personalized learned habits, remedy preferences, and sensitivities
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ai_memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('remedy_preference', 'cycle_pattern', 'lifestyle_habit', 'personal_goal', 'sensitivity_trigger', 'general')),
  fact TEXT NOT NULL,
  source TEXT DEFAULT 'Chat conversation',
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('low', 'medium', 'high')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_memories_user ON public.ai_memories(user_id);

ALTER TABLE public.ai_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view and manage their AI memories" ON public.ai_memories;
CREATE POLICY "Users can view and manage their AI memories"
  ON public.ai_memories
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- TABLE: ai_chat_history
-- Conversational logs with the AI Coach
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ai_chat_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  action_card JSONB,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_user_created ON public.ai_chat_history(user_id, created_at DESC);

ALTER TABLE public.ai_chat_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own chat history" ON public.ai_chat_history;
CREATE POLICY "Users can manage their own chat history"
  ON public.ai_chat_history
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- TABLE: partner_shares
-- Granular access-controlled sharing between partners
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.partner_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_email TEXT,
  partner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  share_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  permissions JSONB NOT NULL DEFAULT '{
    "show_current_phase": true,
    "show_fertile_window": false,
    "show_moods": true,
    "show_symptoms": true,
    "show_daily_tip": true,
    "show_private_notes": false,
    "show_intercourse_logs": false
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.partner_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner has full access to partner shares" ON public.partner_shares;
CREATE POLICY "Owner has full access to partner shares"
  ON public.partner_shares
  FOR ALL
  USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Partner can view active share grants" ON public.partner_shares;
CREATE POLICY "Partner can view active share grants"
  ON public.partner_shares
  FOR SELECT
  USING (auth.uid() = partner_user_id AND status = 'active');

-- ============================================================================
-- GDPR / CCPA ARTICLE 17: Right to Erasure Cascade Function
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_user_data()
RETURNS void AS $$
BEGIN
  DELETE FROM public.profiles WHERE id = auth.uid();
  DELETE FROM public.cycle_logs WHERE user_id = auth.uid();
  DELETE FROM public.ai_memories WHERE user_id = auth.uid();
  DELETE FROM public.ai_chat_history WHERE user_id = auth.uid();
  DELETE FROM public.partner_shares WHERE owner_id = auth.uid() OR partner_user_id = auth.uid();
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
