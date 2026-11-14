import type { ResearchState, ResearchTerminalState } from './contracts'

const transition = <const T extends ResearchState>(...states: T[]): readonly T[] => Object.freeze(states)

export const RESEARCH_STATE_TRANSITIONS: Readonly<Record<ResearchState, readonly ResearchState[]>> = Object.freeze({
  'draft': transition('planned', 'cancelled', 'expired'),
  'planned': transition('read-approval', 'cancelled', 'expired'),
  'read-approval': transition('running', 'cancelled', 'expired'),
  'running': transition('verdict', 'failed', 'cancelled', 'expired'),
  'verdict': transition('evidence-candidate', 'failed', 'cancelled', 'expired'),
  'evidence-candidate': transition('completed', 'failed', 'cancelled', 'expired'),
  'completed': transition(),
  'failed': transition(),
  'cancelled': transition(),
  'expired': transition(),
})

export const RESEARCH_TERMINAL_STATES: readonly ResearchTerminalState[] = Object.freeze(['completed', 'failed', 'cancelled', 'expired'])

export const RESEARCH_STATE_ERROR_CODES = {
  INVALID_TRANSITION: 'RESEARCH_INVALID_STATE_TRANSITION',
} as const

export class ResearchStateError extends Error {
  readonly code = RESEARCH_STATE_ERROR_CODES.INVALID_TRANSITION
  readonly from: ResearchState
  readonly to: ResearchState

  constructor(from: ResearchState, to: ResearchState) {
    super(`cannot transition research from ${from} to ${to}`)
    this.name = 'ResearchStateError'
    this.from = from
    this.to = to
  }
}

export function canTransitionResearchState(from: ResearchState, to: ResearchState): boolean {
  return RESEARCH_STATE_TRANSITIONS[from].includes(to)
}

export function assertResearchTransition(from: ResearchState, to: ResearchState): void {
  if (!canTransitionResearchState(from, to)) throw new ResearchStateError(from, to)
}

export function isResearchTerminalState(state: ResearchState): state is ResearchTerminalState {
  return RESEARCH_TERMINAL_STATES.includes(state as ResearchTerminalState)
}
