/** Server-side contract entrypoint. Keep the canonical schemas in shared/context so
 * route, adapter, and non-server consumers validate the same wire shape. */
export * from '@/shared/context/contracts'
export * from '@/shared/context/refs'
export * from '@/shared/context/hash'
