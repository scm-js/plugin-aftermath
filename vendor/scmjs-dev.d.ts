/**
 * The part of the scmjs.dev plugin's `scmjs-dev.account` service Aftermath uses (plugin-scmjs-dev `contract.d.ts`):
 * where its server is and the caller's session, for the cast's calls. Types only.
 */
export interface ScmjsAccountService {
  /** The server every call goes to, without a trailing slash. */
  serverUrl(): string;
  /** `{ Authorization: "Bearer …" }`, or `{}` for a guest. */
  headers(): Record<string, string>;
  /** Called on every change of state (sign-in, sign-out, a refresh); returns the unsubscribe. */
  onChange(listener: (state: unknown) => void): () => void;
  /** The server answered with the account's balance: the status bar follows. */
  noteBalance(balanceUsd: number): void;
}
