-- ============================================================================
-- AifyCycle - Export Public Table Data from Self-Hosted Supabase
--
-- HOW TO USE:
-- 1. Open your OLD self-hosted Supabase Studio -> SQL Editor.
-- 2. Run this query (read-only; does NOT export passwords or auth tokens).
-- 3. Copy the generated SQL statements from the `insert_sql` column.
-- 4. In your NEW Supabase Cloud project -> SQL Editor:
--      a) Run supabase/migrations/20260924_initial_schema.sql
--      b) Run supabase/migrations/20261121_legacy_data_claim.sql
--      c) Paste & run the generated `INSERT INTO public.legacy_user_imports ...` rows
-- 5. When each user signs in with Google (or re-registers & confirms the same
--    email), their profiles, cycle logs, AI memories, and chat history are
--    automatically attached to their new Supabase Cloud account.
--
-- NOTE FOR ANONYMOUS OR DIFFERENT-EMAIL ACCOUNTS:
-- Any anonymous account is exported as 'anonymous-<old-uuid>'. To attach an
-- anonymous or old-email record to a user who signed in with a new email, run:
--   SELECT public.claim_legacy_user_data('<new-auth-user-uuid>', 'old@email.com');
-- ============================================================================

WITH ranked_users AS (
  SELECT DISTINCT ON (COALESCE(NULLIF(lower(trim(u.email)), ''), 'anonymous-' || u.id::text))
    u.id,
    COALESCE(NULLIF(lower(trim(u.email)), ''), 'anonymous-' || u.id::text) AS migration_key,
    u.created_at
  FROM auth.users u
  WHERE (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
    OR EXISTS (SELECT 1 FROM public.cycle_logs cl WHERE cl.user_id = u.id)
    OR EXISTS (SELECT 1 FROM public.ai_memories m WHERE m.user_id = u.id)
    OR EXISTS (SELECT 1 FROM public.ai_chat_history c WHERE c.user_id = u.id)
  )
  ORDER BY COALESCE(NULLIF(lower(trim(u.email)), ''), 'anonymous-' || u.id::text), u.created_at DESC
),
user_payloads AS (
  SELECT
    ru.migration_key AS email,
    jsonb_build_object(
      'profile', (
        SELECT to_jsonb(p) - 'id'
        FROM public.profiles p
        WHERE p.id = ru.id
      ),
      'cycle_logs', COALESCE((
        SELECT jsonb_agg(to_jsonb(cl) - 'id' - 'user_id' ORDER BY cl.date_key)
        FROM public.cycle_logs cl
        WHERE cl.user_id = ru.id
      ), '[]'::jsonb),
      'ai_memories', COALESCE((
        SELECT jsonb_agg(to_jsonb(m) - 'id' - 'user_id' ORDER BY m.created_at)
        FROM public.ai_memories m
        WHERE m.user_id = ru.id
      ), '[]'::jsonb),
      'ai_chat_history', COALESCE((
        SELECT jsonb_agg(to_jsonb(c) - 'id' - 'user_id' ORDER BY c.created_at)
        FROM public.ai_chat_history c
        WHERE c.user_id = ru.id
      ), '[]'::jsonb)
    ) AS payload
  FROM ranked_users ru
)
SELECT
  email,
  jsonb_array_length(payload->'cycle_logs') AS log_count,
  jsonb_array_length(payload->'ai_memories') AS memory_count,
  jsonb_array_length(payload->'ai_chat_history') AS chat_count,
  format(
    'INSERT INTO public.legacy_user_imports (email, payload) VALUES (%L, %L::jsonb) ON CONFLICT (email) DO UPDATE SET payload = EXCLUDED.payload, claimed_at = NULL, claimed_by = NULL;',
    email,
    payload::text
  ) AS insert_sql
FROM user_payloads
ORDER BY email;
