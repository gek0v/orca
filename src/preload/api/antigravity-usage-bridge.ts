import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const antigravityUsageApi = createUsageProviderApi(
  ipcRenderer,
  'antigravityUsage'
) satisfies PreloadApi['antigravityUsage']
