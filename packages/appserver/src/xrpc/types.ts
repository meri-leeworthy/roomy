import type { Type } from "arktype";

export interface AuthCtx {
  did: string | null;
}

export interface Frame {
  header: FrameHeader;
  body: Record<string, unknown>;
}

export interface FrameHeader {
  op: 1 | -1;
  t: string;
}

export type QueryParams = Record<string, string | string[] | undefined>;

export type QueryHandler<
  TParams extends QueryParams = QueryParams,
  TResult = unknown,
> = (params: TParams, auth: AuthCtx) => Promise<TResult>;

export type SubscriptionHandler<TParams extends QueryParams = QueryParams> = (
  params: TParams,
  auth: AuthCtx,
  signal: AbortSignal,
) => AsyncIterable<Frame>;

export interface QueryDef {
  kind: "query";
  handler: QueryHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
  /** Arktype schema for incoming query-string params. Rejects on parse failure. */
  paramsSchema?: Type<any, any>;
  /** Arktype schema for outgoing JSON response. Throws (500) on parse failure. */
  outputSchema?: Type<any, any>;
}

export type ProcedureHandler<
  TBody = Record<string, unknown>,
  TResult = unknown,
> = (params: QueryParams, auth: AuthCtx, body: TBody) => Promise<TResult>;

export interface ProcedureDef {
  kind: "procedure";
  handler: ProcedureHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
  /** Arktype schema for incoming JSON body. Rejects on parse failure. */
  inputSchema?: Type<any, any>;
  /** Arktype schema for outgoing JSON response. Throws (500) on parse failure.
   * If omitted, the handler is expected to return void/undefined and the
   * response short-circuits to 200 with no body (b57ad1ca behaviour). */
  outputSchema?: Type<any, any>;
}

export interface SubscriptionDef {
  kind: "subscription";
  handler: SubscriptionHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

// ─── Sync (multiplexed WebSocket) ──────────────────────────────────────

/** Client → Server message types (JSON text frames). */
export type ClientMessage =
  | { type: "sub"; topic: "space" | "room" | "mentions"; id: string }
  | { type: "unsub"; topic: "space" | "room" | "mentions"; id: string }
  | { type: "sub"; topic: "stream"; id: string; cursor: number }
  | { type: "unsub"; topic: "stream"; id: string }
  | { type: "cursor"; seq: number }
  | {
      type: "voice_state";
      roomId: string;
      muted: boolean;
      deafened: boolean;
    };

/**
 * What a sync connection was carrying when it closed. Read once, by the
 * router's close path, so the disconnect record names the space(s) the
 * dropped socket was serving — a close code alone cannot say which.
 */
export interface SyncCloseSnapshot {
  /** Topic keys (`space:<did>`, `room:<id>`, `mentions:<did>`) subscribed at close. */
  topics: readonly string[];
  /** Stream DIDs subscribed at close. */
  streams: readonly string[];
}

/**
 * Abstraction over a single WS connection, passed to the SyncHandler.
 * Never touches the raw Bun WebSocket directly.
 */
export interface SyncSocket {
  /** Send a CBOR frame to the client. */
  send(frame: Frame): void;
  /** Register handler for incoming client messages (sub/unsub/cursor). */
  onMessage(handler: (msg: ClientMessage) => void): void;
  /** Register handler for when the connection closes. */
  onClose(handler: () => void): void;
  /**
   * Register the close-time snapshot of what this connection was carrying.
   * The router reads it while closing, before the connection's state is torn
   * down, so the close record can name the space that lost its socket.
   */
  onCloseSnapshot(handler: () => SyncCloseSnapshot): void;
  /** Check if connection is still open. */
  readonly isOpen: boolean;
  /** Authenticated DID of the connected user. */
  readonly did: string;
}

export interface SyncDef {
  kind: "sync";
  handler: SyncHandler;
}

/** Called once when a sync WS connection opens. Manages topic subscriptions. */
export type SyncHandler = (socket: SyncSocket) => void;

export type RouteDef = QueryDef | ProcedureDef | SubscriptionDef | SyncDef;
