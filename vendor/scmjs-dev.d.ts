/**
 * The part of the scmjs.dev plugin's `scmjs-dev.account` service Aftermath uses (plugin-scmjs-dev `contract.d.ts`):
 * where its server is and the caller's session, for the cast's calls. Types only.
 */
export interface ScmjsAccountService {
  /** \`guest\`: no session in this browser; \`trial\` or \`account\`: one the server knows. */
  state(): { kind: "guest" | "trial" | "account" };
  /** The server every call goes to, without a trailing slash. */
  serverUrl(): string;
  /** `{ Authorization: "Bearer …" }`, or `{}` for a guest. */
  headers(): Record<string, string>;
  /** Called on every change of state (sign-in, sign-out, a refresh); returns the unsubscribe. */
  onChange(listener: (state: unknown) => void): () => void;
  /** The server answered with the account's balance: the status bar follows. */
  noteBalance(balanceUsd: number): void;
}

/**
 * The scmjs.dev plugin's `scmjs-dev.replays` service (plugin-scmjs-dev `contract.d.ts`, from 1.41.0): a replay's link
 * for Share, without Aftermath talking to the server. Types only.
 */
export interface ScmjsReplaysService {
  /** Where a replay stands, asked without sending it. */
  status(replay: ReplayFile): Promise<ReplayStatus>;
  /**
   * Its link, `https://scmjs.dev/replay/<token>`: signs in first when nobody is (in `provider`'s window, opened at once,
   * so call it from the press), keeps the replay when the account does not have it, makes the link when it has none.
   * Rejects with the sentence to show as the message, and `code` `"aborted"` when the sign-in window was closed.
   */
  link(replay: ReplayFile, provider?: string): Promise<string>;
  /** A sign-in or a sign-out; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface ReplayFile {
  bytes: Uint8Array;
  fileName: string;
}

export type ReplayStatus =
  | { state: "signed-out"; providers: { id: string; name: string }[] }
  | { state: "not-kept" }
  | { state: "kept"; link: string | null }
  | { state: "unavailable"; reason: string };
