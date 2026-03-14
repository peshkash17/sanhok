// Hand-written Supabase Database types — compatible with @supabase/supabase-js v2.99+
// Regenerate with: npx supabase gen types typescript --project-id <id> > src/lib/supabase/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      ingestion_queue: {
        Row: {
          id: string
          org_id: string
          event_type: 'error' | 'activity' | 'trace'
          payload: Json
          idempotency_key: string
          processed_at: string | null
          failed_at: string | null
          error_message: string | null
          received_at: string
        }
        Insert: {
          id?: string
          org_id: string
          event_type: 'error' | 'activity' | 'trace'
          payload: Json
          idempotency_key: string
          received_at?: string
        }
        Update: {
          processed_at?: string | null
          failed_at?: string | null
          error_message?: string | null
        }
        Relationships: []
      }
      rate_limit_state: {
        Row: {
          org_id: string
          tokens: number
          last_refill: string
          capacity: number
          refill_rate: number
        }
        Insert: {
          org_id: string
          tokens?: number
          last_refill?: string
          capacity?: number
          refill_rate?: number
        }
        Update: {
          tokens?: number
          last_refill?: string
          capacity?: number
          refill_rate?: number
        }
        Relationships: []
      }
      organisations: {
        Row: {
          id: string
          name: string
          slug: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          created_at?: string
        }
        Update: {
          name?: string
          slug?: string
        }
        Relationships: []
      }
      org_members: {
        Row: {
          org_id: string
          user_id: string
          role: 'owner' | 'admin' | 'member'
          joined_at: string
        }
        Insert: {
          org_id: string
          user_id: string
          role: 'owner' | 'admin' | 'member'
          joined_at?: string
        }
        Update: {
          role?: 'owner' | 'admin' | 'member'
        }
        Relationships: [
          {
            foreignKeyName: 'org_members_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organisations'
            referencedColumns: ['id']
          }
        ]
      }
      api_keys: {
        Row: {
          id: string
          org_id: string
          key_hash: string
          prefix: string
          name: string
          created_at: string
          last_used_at: string | null
          revoked_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          key_hash: string
          prefix: string
          name: string
        }
        Update: {
          name?: string
          revoked_at?: string | null
          last_used_at?: string | null
        }
        Relationships: []
      }
      invitations: {
        Row: {
          id: string
          org_id: string
          email: string
          role: 'admin' | 'member'
          token_hash: string
          expires_at: string
          accepted_at: string | null
          invited_by: string
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          email: string
          role: 'admin' | 'member'
          token_hash: string
          expires_at: string
          invited_by: string
        }
        Update: {
          accepted_at?: string | null
        }
        Relationships: []
      }
      error_groups: {
        Row: {
          id: string
          org_id: string
          fingerprint: string
          title: string
          culprit: string | null
          status: 'open' | 'resolved' | 'regressed' | 'ignored'
          first_seen: string
          last_seen: string
          occurrence_count: number
          user_count: number
          resolved_at: string | null
          resolved_by: string | null
          regressed_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          fingerprint: string
          title: string
          culprit?: string | null
          status?: 'open' | 'resolved' | 'regressed' | 'ignored'
          first_seen?: string
          last_seen?: string
          occurrence_count?: number
          user_count?: number
          resolved_at?: string | null
          resolved_by?: string | null
          regressed_at?: string | null
        }
        Update: {
          title?: string
          culprit?: string | null
          status?: 'open' | 'resolved' | 'regressed' | 'ignored'
          last_seen?: string
          occurrence_count?: number
          user_count?: number
          resolved_at?: string | null
          resolved_by?: string | null
          regressed_at?: string | null
        }
        Relationships: []
      }
      error_occurrences: {
        Row: {
          id: string
          org_id: string
          group_id: string
          message: string
          exception_type: string | null
          stack_trace: Json | null
          user_id: string | null
          user_email: string | null
          tags: Json | null
          breadcrumbs: Json | null
          request_url: string | null
          request_method: string | null
          occurred_at: string
          sdk_version: string | null
          environment: string | null
          release: string | null
        }
        Insert: {
          id?: string
          org_id: string
          group_id: string
          message: string
          exception_type?: string | null
          stack_trace?: Json | null
          user_id?: string | null
          user_email?: string | null
          tags?: Json | null
          breadcrumbs?: Json | null
          request_url?: string | null
          request_method?: string | null
          occurred_at?: string
          sdk_version?: string | null
          environment?: string | null
          release?: string | null
        }
        Update: {
          occurred_at?: string
        }
        Relationships: []
      }
      sessions: {
        Row: {
          id: string
          org_id: string
          session_id: string
          anonymous_id: string
          user_id: string | null
          started_at: string
          ended_at: string | null
          duration_seconds: number | null
        }
        Insert: {
          id?: string
          org_id: string
          session_id: string
          anonymous_id: string
          user_id?: string | null
          started_at?: string
          ended_at?: string | null
          duration_seconds?: number | null
        }
        Update: {
          user_id?: string | null
          ended_at?: string | null
          duration_seconds?: number | null
        }
        Relationships: []
      }
      session_events: {
        Row: {
          id: string
          org_id: string
          session_id: string
          event_type: string
          event_name: string
          properties: Json | null
          url: string | null
          referrer: string | null
          occurred_at: string
        }
        Insert: {
          id?: string
          org_id: string
          session_id: string
          event_type: string
          event_name: string
          properties?: Json | null
          url?: string | null
          referrer?: string | null
          occurred_at?: string
        }
        Update: {
          event_name?: string
        }
        Relationships: []
      }
      identity_map: {
        Row: {
          org_id: string
          anonymous_id: string
          user_id: string
          identified_at: string
        }
        Insert: {
          org_id: string
          anonymous_id: string
          user_id: string
          identified_at?: string
        }
        Update: {
          user_id?: string
          identified_at?: string
        }
        Relationships: []
      }
      traces: {
        Row: {
          id: string
          org_id: string
          trace_id: string
          span_id: string
          parent_span_id: string | null
          operation: string
          duration_ms: number
          status: 'ok' | 'error' | 'timeout'
          started_at: string
          ended_at: string | null
          tags: Json | null
          resource_attributes: Json | null
        }
        Insert: {
          id?: string
          org_id: string
          trace_id: string
          span_id: string
          parent_span_id?: string | null
          operation: string
          duration_ms: number
          status?: 'ok' | 'error' | 'timeout'
          started_at?: string
          ended_at?: string | null
          tags?: Json | null
          resource_attributes?: Json | null
        }
        Update: {
          status?: 'ok' | 'error' | 'timeout'
          ended_at?: string | null
        }
        Relationships: []
      }
      perf_aggregates_hourly: {
        Row: {
          org_id: string
          operation: string
          hour: string
          p50: number | null
          p90: number | null
          p99: number | null
          sample_count: number
          total_ms: number
        }
        Insert: {
          org_id: string
          operation: string
          hour: string
          p50?: number | null
          p90?: number | null
          p99?: number | null
          sample_count?: number
          total_ms?: number
        }
        Update: {
          p50?: number | null
          p90?: number | null
          p99?: number | null
          sample_count?: number
          total_ms?: number
        }
        Relationships: []
      }
      alerts: {
        Row: {
          id: string
          org_id: string
          type: 'error_spike' | 'latency_drift' | 'activity_drop' | 'error_regression'
          metric_value: number
          baseline_value: number
          deviation_percent: number
          duration_minutes: number
          started_at: string
          resolved_at: string | null
          ai_explanation: string | null
          context: Json | null
        }
        Insert: {
          id?: string
          org_id: string
          type: 'error_spike' | 'latency_drift' | 'activity_drop' | 'error_regression'
          metric_value: number
          baseline_value: number
          deviation_percent: number
          duration_minutes?: number
          started_at?: string
          resolved_at?: string | null
          ai_explanation?: string | null
          context?: Json | null
        }
        Update: {
          resolved_at?: string | null
          ai_explanation?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      set_org_context: {
        Args: { org_id: string }
        Returns: void
      }
      get_current_org: {
        Args: Record<string, never>
        Returns: string
      }
      create_org_with_owner: {
        Args: { p_user_id: string; p_org_name: string; p_org_slug: string }
        Returns: string
      }
      accept_invitation: {
        Args: { p_token_hash: string; p_user_id: string }
        Returns: Json
      }
      check_and_consume_tokens: {
        Args: {
          p_org_id: string
          p_consume: number
          p_max_tokens: number
          p_refill_per_ms: number
        }
        Returns: Json
      }
    }
    Enums: Record<string, never>
  }
}
