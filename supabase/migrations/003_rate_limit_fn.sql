-- Migration 003: Rate limiting stored procedure
-- check_and_consume_tokens: atomic token-bucket operation

CREATE OR REPLACE FUNCTION check_and_consume_tokens(
    p_org_id        uuid,
    p_consume       int,
    p_max_tokens    float8,
    p_refill_per_ms float8
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER  -- runs with owner privileges bypassing RLS (intentional — called from service role context)
AS $$
DECLARE
    v_tokens        float8;
    v_last_refill   timestamptz;
    v_elapsed_ms    float8;
    v_refilled      float8;
    v_new_tokens    float8;
    v_allowed       boolean;
BEGIN
    -- Lock the row for atomic update
    SELECT tokens, last_refill
      INTO v_tokens, v_last_refill
      FROM rate_limit_state
     WHERE org_id = p_org_id
      FOR UPDATE;

    IF NOT FOUND THEN
        -- First request for this org — initialise
        INSERT INTO rate_limit_state (org_id, tokens, last_refill)
        VALUES (p_org_id, p_max_tokens, now())
        ON CONFLICT (org_id) DO NOTHING;

        v_tokens      := p_max_tokens;
        v_last_refill := now();
    END IF;

    -- Calculate tokens added since last refill
    v_elapsed_ms := extract(epoch FROM (now() - v_last_refill)) * 1000;
    v_refilled   := v_elapsed_ms * p_refill_per_ms;
    v_new_tokens := LEAST(p_max_tokens, v_tokens + v_refilled);

    -- Attempt to consume
    v_allowed := v_new_tokens >= p_consume;

    IF v_allowed THEN
        v_new_tokens := v_new_tokens - p_consume;
    END IF;

    -- Update state
    UPDATE rate_limit_state
       SET tokens      = v_new_tokens,
           last_refill = now()
     WHERE org_id = p_org_id;

    RETURN jsonb_build_object(
        'allowed',    v_allowed,
        'remaining',  floor(v_new_tokens)
    );
END;
$$;
