import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary/20 text-primary',
        secondary:   'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/20 text-red-400 border-red-900/50',
        outline:     'text-foreground',
        // domain-specific
        error:       'border-red-900/50 bg-red-950/50 text-red-400',
        warning:     'border-amber-900/50 bg-amber-950/50 text-amber-400',
        success:     'border-emerald-900/50 bg-emerald-950/50 text-emerald-400',
        info:        'border-blue-900/50 bg-blue-950/50 text-blue-400',
        muted:       'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { badgeVariants }
