export const USAGE_WARNING_PERCENT = 60
export const USAGE_URGENT_PERCENT = 80

// Why: maps consumption levels to design system status tokens for vivid color coding.
// Invalid or non-finite values fall through to destructive so missing limits don't masquerade as healthy.
export function getQuotaTextColorClass(usedPercent: number): string {
  if (!Number.isFinite(usedPercent) || usedPercent >= USAGE_URGENT_PERCENT) {
    return 'text-destructive'
  }
  if (usedPercent >= USAGE_WARNING_PERCENT) {
    return 'text-status-warning'
  }
  return 'text-status-success'
}

export function getQuotaBarColorClass(usedPercent: number): string {
  if (!Number.isFinite(usedPercent) || usedPercent >= USAGE_URGENT_PERCENT) {
    return 'bg-destructive'
  }
  if (usedPercent >= USAGE_WARNING_PERCENT) {
    return 'bg-status-warning'
  }
  return 'bg-status-success'
}
