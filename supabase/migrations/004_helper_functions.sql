-- Migration 004: Helper functions for RLS context and org management

-- set_org_context: called by API routes to establish the RLS session variable
-- Using a function rather than raw SET LOCAL so it can be called via supabase.rpc()
CREATE OR REPLACE FUNCTION set_org_context(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM set_config('app.current_org_id', p_org_id::text, true);  -- true = LOCAL (transaction-scoped)
END;
$$;

-- get_current_org: convenience function to read back the current org context
CREATE OR REPLACE FUNCTION get_current_org()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT (current_setting('app.current_org_id', true))::uuid;
$$;

-- create_org_with_owner: atomically create an org and add the creator as owner
-- Called on first sign-in / new org creation
CREATE OR REPLACE FUNCTION create_org_with_owner(
    p_user_id   uuid,
    p_org_name  text,
    p_org_slug  text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_org_id uuid;
BEGIN
    -- Validate slug (alphanumeric + hyphens only)
    IF p_org_slug !~ '^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$' THEN
        RAISE EXCEPTION 'Invalid slug format. Use lowercase letters, numbers, and hyphens only.';
    END IF;

    INSERT INTO organisations (name, slug)
    VALUES (p_org_name, p_org_slug)
    RETURNING id INTO v_org_id;

    INSERT INTO org_members (org_id, user_id, role)
    VALUES (v_org_id, p_user_id, 'owner');

    -- Initialise rate limit state for this org
    INSERT INTO rate_limit_state (org_id, tokens, last_refill)
    VALUES (v_org_id, 1000, now());

    RETURN v_org_id;
END;
$$;

-- accept_invitation: accept an invitation and add the user to the org
CREATE OR REPLACE FUNCTION accept_invitation(
    p_token_hash    text,
    p_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invitation    invitations%ROWTYPE;
BEGIN
    SELECT * INTO v_invitation
      FROM invitations
     WHERE token_hash = p_token_hash
       AND accepted_at IS NULL
       AND expires_at > now();

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired invitation');
    END IF;

    -- Add member (UPSERT in case they're re-accepting)
    INSERT INTO org_members (org_id, user_id, role)
    VALUES (v_invitation.org_id, p_user_id, v_invitation.role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    -- Mark invitation as accepted
    UPDATE invitations SET accepted_at = now() WHERE id = v_invitation.id;

    RETURN jsonb_build_object(
        'success', true,
        'org_id', v_invitation.org_id
    );
END;
$$;
