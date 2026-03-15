const { createClient } = require('@supabase/supabase-js');
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY, 
  { auth: { persistSession: false } }
);

(async () => {
  const orgId = 'c28a57bb-2fe7-4d2a-863e-0e01f45565fc';
  
  console.log('\n=== RESULTS AFTER CURL TESTS ===\n');
  
  // Check queue
  const { data: queue } = await db.from('ingestion_queue')
    .select('id, event_type, attempts, last_error')
    .eq('org_id', orgId);
  console.log('Queue remaining:', queue?.length ?? 0);
  if (queue?.length > 0) {
    queue.forEach(q => console.log('  - ', q.event_type, 'attempts:', q.attempts, q.last_error || 'no error'));
  }
  
  // Check error groups
  const { data: groups } = await db.from('error_groups')
    .select('fingerprint, title, occurrence_count, last_seen')
    .eq('org_id', orgId)
    .order('last_seen', { ascending: false })
    .limit(5);
  console.log('\nError Groups (recent 5):', groups?.length ?? 0);
  groups?.forEach(g => console.log('  -', g.title, '| count:', g.occurrence_count, '| last:', new Date(g.last_seen).toLocaleTimeString()));
  
  // Check sessions
  const { data: sessions } = await db.from('sessions')
    .select('session_id, user_id, started_at')
    .eq('org_id', orgId)
    .order('started_at', { ascending: false })
    .limit(5);
  console.log('\nSessions (recent 5):', sessions?.length ?? 0);
  sessions?.forEach(s => console.log('  -', s.session_id, '| user:', s.user_id || 'anonymous', '| started:', new Date(s.started_at).toLocaleTimeString()));
  
  // Check session events
  const { data: events } = await db.from('session_events')
    .select('session_id, event_name, occurred_at')
    .eq('org_id', orgId)
    .order('occurred_at', { ascending: false })
    .limit(5);
  console.log('\nSession Events (recent 5):', events?.length ?? 0);
  events?.forEach(e => console.log('  -', e.event_name, '| session:', e.session_id, '| at:', new Date(e.occurred_at).toLocaleTimeString()));
  
  // Check traces
  const { data: traces } = await db.from('traces')
    .select('operation, duration_ms, status, started_at')
    .eq('org_id', orgId)
    .order('started_at', { ascending: false })
    .limit(5);
  console.log('\nTraces (recent 5):', traces?.length ?? 0);
  traces?.forEach(t => console.log('  -', t.operation, '| duration:', t.duration_ms + 'ms', '| status:', t.status, '| at:', new Date(t.started_at).toLocaleTimeString()));
  
  // Check identity map
  const { data: identity } = await db.from('identity_map')
    .select('anonymous_id, user_id, identified_at')
    .eq('org_id', orgId)
    .order('identified_at', { ascending: false })
    .limit(3);
  console.log('\nIdentity Mapping (recent 3):', identity?.length ?? 0);
  identity?.forEach(i => console.log('  -', i.anonymous_id, '→', i.user_id, '| at:', new Date(i.identified_at).toLocaleTimeString()));
  
  console.log('\n=== Test Summary ===');
  console.log('✓ Error tracking working:', (groups?.length || 0) > 0);
  console.log('✓ Session tracking working:', (sessions?.length || 0) > 0);
  console.log('✓ Activity events working:', (events?.length || 0) > 0);
  console.log('✓ Performance traces working:', (traces?.length || 0) > 0);
  console.log('✓ Identity stitching working:', (identity?.length || 0) > 0);
})();
