import { issueTicket } from "../xrpc/auth.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const getConnectionTicketHandler: ProcedureHandler<
  Record<string, unknown>,
  { ticket: string }
> = async (_params: QueryParams, auth: AuthCtx) => {
  if (auth.did === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  return { ticket: issueTicket(auth.did) };
};
