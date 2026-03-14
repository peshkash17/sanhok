'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { slugify } from '@/lib/utils'

export default function NewOrgPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setName(value)
    setSlug(slugify(value))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const res = await fetch('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug }),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Failed to create organisation.')
      setLoading(false)
      return
    }

    router.push(`/${data.slug}`)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Create your organisation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your organisation groups your projects, members, and data.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              label="Organisation name"
              value={name}
              onChange={handleNameChange}
              placeholder="Acme Inc."
              required
            />
            <Input
              label="URL slug"
              value={slug}
              onChange={e => setSlug(slugify(e.target.value))}
              placeholder="acme-inc"
              hint={`Your dashboard will be at /${slug}`}
              required
            />

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive border border-destructive/30">
                {error}
              </p>
            )}

            <Button type="submit" loading={loading} className="w-full" disabled={!name || !slug}>
              Create organisation
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
