import { StateStore } from './state-store.js'
export class ReplayStore {
  constructor(private readonly state: StateStore) {}
  accept(nonce: string, expiresAt: number, now: number): boolean { return this.state.useNonce(nonce, expiresAt, now) }
}
