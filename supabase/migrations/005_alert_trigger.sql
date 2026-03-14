-- Migration 005: Alert explanation trigger via pg_net
--
-- After an alert row is inserted, fires an async HTTP POST to /api/ai/explain-alert
-- which generates an AI explanation and stores it back on the row.
--
-- Requirements:
--   * pg_net extension must be enabled (available on Supabase by default)
--   * Two GUC settings must be configured in Supabase dashboard:
--       app.api_base_url        → your deployed URL, e.g. https://your-app.vercel.app
--       app.internal_api_secret → matches INTERNAL_API_SECRET env var in Next.js
--
-- If either GUC is absent or pg_net is unavailable, the function exits silently.
-- Alerts are always created; the AI explanation is an optional async annotation.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- Function: called by the trigger after each alert INSERT
CREATE OR REPLACE FUNCTION fn_notify_alert_explanation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_api_base_url  text;
  v_internal_key  text;
BEGIN
  -- Retrieve config; true = return NULL if not set (do not raise)
  v_api_base_url := current_setting('app.api_base_url',        true);
  v_internal_key := current_setting('app.internal_api_secret', true);

  -- If not configured, skip silently — alerts still work without AI
  IF v_api_base_url IS NULL OR v_api_base_url = ''
  OR v_internal_key IS NULL OR v_internal_key = ''
  THEN
    RETURN NEW;
  END IF;

  -- Fire async HTTP POST (non-blocking — does not delay the INSERT transaction)
  PERFORM net.http_post(
    url     := v_api_base_url || '/api/ai/explain-alert',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'X-Internal-Key', v_internal_key
               ),
    body    := jsonb_build_object('alertId', NEW.id)::text,
    timeout_milliseconds := 10000
  );

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Never fail the INSERT because of a webhook error
  RETURN NEW;
END;
$$;

-- Trigger: fires once per alert row, after the INSERT is committed
CREATE TRIGGER trg_alert_explanation
  AFTER INSERT ON alerts
  FOR EACH ROW
  EXECUTE FUNCTION fn_notify_alert_explanation();
