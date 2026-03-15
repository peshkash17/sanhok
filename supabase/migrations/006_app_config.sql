-- Migration 006: App config table for trigger settings
--
-- Replaces GUC-based config (ALTER DATABASE SET app.* = ...)
-- which requires superuser on Supabase hosted instances.
-- The trigger function reads from this table instead.

CREATE TABLE IF NOT EXISTS app_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Only the service role can read/write this table
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config FORCE ROW LEVEL SECURITY;

-- No public policies — accessible only via SECURITY DEFINER functions
-- and the Supabase service role (which bypasses RLS via the server client)

-- Seed placeholder values — UPDATE these with your actual values:
--   api_base_url      → your deployed URL (e.g. https://your-app.vercel.app)
--                        or http://localhost:3000 for local dev
--   internal_api_secret → must match INTERNAL_API_SECRET in .env.local
INSERT INTO app_config (key, value) VALUES
  ('api_base_url',        'http://localhost:3000'),
  ('internal_api_secret', 'change_me')
ON CONFLICT (key) DO NOTHING;

-- Replace the trigger function to read from app_config instead of current_setting()
CREATE OR REPLACE FUNCTION fn_notify_alert_explanation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_api_base_url  text;
  v_internal_key  text;
BEGIN
  SELECT value INTO v_api_base_url  FROM app_config WHERE key = 'api_base_url';
  SELECT value INTO v_internal_key  FROM app_config WHERE key = 'internal_api_secret';

  -- If not configured, skip silently
  IF v_api_base_url IS NULL OR v_api_base_url = ''
  OR v_internal_key IS NULL OR v_internal_key = '' OR v_internal_key = 'change_me'
  THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_api_base_url || '/api/ai/explain-alert',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'X-Internal-Key', v_internal_key
               ),
    body    := jsonb_build_object('alertId', NEW.id)::text,
    timeout_milliseconds := 10000
  );

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;
