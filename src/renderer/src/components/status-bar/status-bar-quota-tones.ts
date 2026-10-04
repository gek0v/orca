import { USAGE_URGENT_PERCENT, USAGE_WARNING_PERCENT } from './tooltip'

// Why: maps consumption levels to design system status tokens for vivid color coding.
export function getQuotaTextColorClass(usedPercent: number): string {
  if (usedPercent >= USAGE_URGENT_PERCENT) {
    return 'text-destructive'
  }
  if (usedPercent >= USAGE_WARNING_PERCENT) {
    return 'text-status-warning'
  }
  return 'text-status-success'
}

export function getQuotaBarColorClass(usedPercent: number): string {
  if (usedPercent >= USAGE_URGENT_PERCENT) {
    return 'bg-destructive'
  }
  if (usedPercent >= USAGE_WARNING_PERCENT) {
    return 'bg-status-warning'
  }
  return 'bg-status-success'
}
