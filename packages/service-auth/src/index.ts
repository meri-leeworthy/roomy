/**
 * ATProto service-auth JWT verification.
 *
 * The one verifier used by every Roomy service that accepts a
 * `com.atproto.server.getServiceAuth` token: the appserver's session verifier
 * and the Discord bridge's REST API. Keeping it in one place means a change to
 * what counts as a valid token (audience, expiry, signing key retry) cannot
 * land in one service and miss another.
 *
 * A token is accepted only when its signature verifies against the `#atproto`
 * signing key in its issuer's DID document and its `aud` names this service.
 * The caller identity is `sub` when present (a PDS-issued service token names
 * the user in `sub` and the PDS in `iss`), else `iss`.
 *
 * Verification is fail-closed: absent, expired, wrongly-addressed, or
 * unverifiable tokens all produce `{ did: null }`. Callers decide what a null
 * DID may do; none may read data.
 */

import { type DidDocument, getKey, IdResolver } from "@atproto/identity";
import { verifyJwt } from "@atproto/xrpc-server";

/** The caller identity a request resolves to, or `null` when unauthenticated. */
export interface ServiceAuthResult {
	did: string | null;
}

/** Resolves a DID document; `forceRefresh` retries after a signature mismatch. */
export type DidDocumentResolver = (
	did: string,
	forceRefresh: boolean,
) => Promise<DidDocument | null>;

export interface ServiceAuthVerifierOptions {
	/** The DID this service is addressed as — the `aud` a token must carry. */
	audience: string;
	/**
	 * DID-document resolver. Defaults to a process-wide `IdResolver` with its
	 * standard cache; a service that already owns a resolver (and its cache
	 * policy) should pass it so documents are fetched once per process.
	 */
	resolveDid?: DidDocumentResolver;
}

export type ServiceAuthVerifier = (
	req: Request,
) => Promise<ServiceAuthResult>;

let defaultResolver: IdResolver | undefined;

function resolveDidByDefault(
	did: string,
	forceRefresh: boolean,
): Promise<DidDocument | null> {
	defaultResolver ??= new IdResolver({
		plcUrl: process.env.PLC_DIRECTORY_URL ?? "https://plc.directory",
	});
	return defaultResolver.did.resolve(did, forceRefresh);
}

/**
 * Build a verifier for tokens addressed to `audience`.
 *
 * The returned function reads the `Authorization: Bearer` header. It never
 * throws: a resolution or signature failure is an unauthenticated request.
 */
export function createServiceAuthVerifier(
	options: ServiceAuthVerifierOptions,
): ServiceAuthVerifier {
	const resolveDid = options.resolveDid ?? resolveDidByDefault;

	return async (req) => {
		const authHeader = req.headers.get("authorization");
		if (!authHeader?.startsWith("Bearer ")) return { did: null };
		const jwt = authHeader.slice("Bearer ".length);

		try {
			const payload = await verifyJwt(
				jwt,
				options.audience,
				null,
				async (iss, forceRefresh) => {
					// `iss` may name a service fragment (`did:...:x#svc`); the
					// document and signing key belong to the DID itself.
					const fragmentAt = iss.indexOf("#");
					const did = fragmentAt === -1 ? iss : iss.slice(0, fragmentAt);
					const didDoc = await resolveDid(did, forceRefresh);
					if (!didDoc) {
						throw new Error(`Could not resolve DID: ${did}`);
					}
					const didKey = getKey(didDoc);
					if (!didKey) {
						throw new Error("No ATProto signing key in DID document");
					}
					return didKey;
				},
			);

			const userDid =
				"sub" in payload && typeof payload.sub === "string"
					? payload.sub
					: payload.iss;
			return { did: userDid };
		} catch {
			return { did: null };
		}
	};
}
