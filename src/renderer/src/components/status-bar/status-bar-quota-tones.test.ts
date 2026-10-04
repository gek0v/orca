import { describe, expect, it } from 'vitest'
import { getQuotaBarColorClass, getQuotaTextColorClass } from './status-bar-quota-tones'

describe('status-bar-quota-tones', () => {
  it('returns success tokens when consumption is healthy (<60%)', () => {
    expect(getQuotaTextColorClass(0)).toBe('text-status-success')
    expect(getQuotaTextColorClass(15)).toBe('text-status-success')
    expect(getQuotaTextColorClass(59)).toBe('text-status-success')
    expect(getQuotaBarColorClass(0)).toBe('bg-status-success')
    expect(getQuotaBarColorClass(15)).toBe('bg-status-success')
    expect(getQuotaBarColorClass(59)).toBe('bg-status-success')
  })

  it('returns warning tokens when consumption is elevated (60%-79%)', () => {
    expect(getQuotaTextColorClass(60)).toBe('text-status-warning')
    expect(getQuotaTextColorClass(65)).toBe('text-status-warning')
    expect(getQuotaTextColorClass(79)).toBe('text-status-warning')
    expect(getQuotaBarColorClass(60)).toBe('bg-status-warning')
    expect(getQuotaBarColorClass(65)).toBe('bg-status-warning')
    expect(getQuotaBarColorClass(79)).toBe('bg-status-warning')
  })

  it('returns destructive tokens when quota is urgent or exhausted (>=80%)', () => {
    expect(getQuotaTextColorClass(80)).toBe('text-destructive')
    expect(getQuotaTextColorClass(85)).toBe('text-destructive')
    expect(getQuotaTextColorClass(100)).toBe('text-destructive')
    expect(getQuotaBarColorClass(80)).toBe('bg-destructive')
    expect(getQuotaBarColorClass(85)).toBe('bg-destructive')
    expect(getQuotaBarColorClass(100)).toBe('bg-destructive')
  })
})
