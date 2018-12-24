import { configure, create } from '@raynode/nx-logger'
import { transport } from '@raynode/nx-logger-debug'

configure({
  namespace: ['heise-feed'],
  transport,
})

export * from '@raynode/nx-logger'
export const log = create()
export { transport }
