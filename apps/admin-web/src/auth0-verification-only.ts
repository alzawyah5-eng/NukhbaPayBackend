import { inspect } from 'node:util';
import { Auth0Login, type Auth0Configuration } from './auth0.js';

const failed = () => new Error('Auth0 verification-only acceptance failed');
export type VerificationOutcome = Readonly<{ verified: boolean; sessionCreated: false }>;

/** One transaction; no repository, enrollment, audit writer or real session port exists. */
export class Auth0VerificationOnly {
  readonly #login;
  #started = false;
  #consumed = false;
  #closed = false;
  #verified = false;
  constructor(config: Auth0Configuration, dependencies: { fetch?: typeof fetch; now?: () => Date } = {}) {
    // This callback is reached only after the existing complete ID/access verification.
    this.#login = new Auth0Login(config, { ...dependencies,
      actors: { establish: async () => {
        if (!this.#closed) this.#verified = true;
        return { allowed: false as const, reason: 'VERIFICATION_ONLY', execution: 'NOT_AUTHORIZED' as const };
      } },
      sessions: { create: async () => { throw failed(); }, rotate: async () => { throw failed(); },
        revoke: async () => { throw failed(); } },
    });
  }
  toJSON(): string { return '[Auth0VerificationOnly: internal]'; }
  [inspect.custom](): string { return this.toJSON(); }
  begin(): { location: string; cookie: string } {
    if (this.#started || this.#consumed) throw failed();
    this.#started = true;
    return this.#login.begin();
  }
  async complete(rawUrl: string, transactionId: string | undefined): Promise<VerificationOutcome> {
    if (!this.#started || this.#consumed) return Object.freeze({ verified: false, sessionCreated: false });
    this.#consumed = true;
    try { await this.#login.complete(rawUrl, transactionId); }
    catch { /* Expected even for verified tokens: actor establishment always denies. */ }
    finally { this.#login.close(); }
    return Object.freeze({ verified: this.#verified && !this.#closed, sessionCreated: false });
  }
  close(): void { this.#closed = true; this.#consumed = true; this.#login.close(); }
}
