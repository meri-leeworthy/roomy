import { describe, expect, test } from "bun:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import type { DidDocument } from "@atproto/identity";
import { createServiceJwt } from "@atproto/xrpc-server";
import { createServiceAuthVerifier } from "./index.ts";

const AUDIENCE = "did:web:bridge.example";
const ISSUER = "did:plc:issuer";
const USER = "did:plc:user";

const keypair = await Secp256k1Keypair.create();
const multibase = keypair.did().replace("did:key:", "");
const didDoc = {
	id: ISSUER,
	verificationMethod: [
		{
			id: `${ISSUER}#atproto`,
			type: "Multikey",
			controller: ISSUER,
			publicKeyMultibase: multibase,
		},
	],
} as unknown as DidDocument;

function verifierFor(docs: Record<string, DidDocument | null>) {
	const resolved: string[] = [];
	const verify = createServiceAuthVerifier({
		audience: AUDIENCE,
		resolveDid: async (did) => {
			resolved.push(did);
			return docs[did] ?? null;
		},
	});
	return { verify, resolved };
}

function withAuth(jwt: string): Request {
	return new Request("http://localhost/info", {
		headers: { authorization: `Bearer ${jwt}` },
	});
}

async function mintToken(
	overrides: {
		aud?: string;
		iss?: string;
		exp?: number;
	} = {},
): Promise<string> {
	return createServiceJwt({
		iss: overrides.iss ?? ISSUER,
		aud: overrides.aud ?? AUDIENCE,
		lxm: null,
		exp: overrides.exp,
		keypair,
	});
}

/**
 * `createServiceJwt` has no `sub` parameter, but PDS-issued service tokens
 * carry one. Sign the claims directly to cover that shape.
 */
async function mintTokenWithSub(sub: string): Promise<string> {
	const header = Buffer.from(
		JSON.stringify({ alg: "ES256K", typ: "JWT" }),
	).toString("base64url");
	const claims = Buffer.from(
		JSON.stringify({
			iss: ISSUER,
			aud: AUDIENCE,
			sub,
			exp: Math.floor(Date.now() / 1000) + 60,
		}),
	).toString("base64url");
	const unsigned = `${header}.${claims}`;
	const signature = await keypair.sign(new TextEncoder().encode(unsigned));
	return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

describe("createServiceAuthVerifier", () => {
	test("returns null for a request with no Authorization header", async () => {
		const { verify, resolved } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(new Request("http://localhost/info"));
		expect(result).toEqual({ did: null });
		expect(resolved).toEqual([]);
	});

	test("returns null for a non-Bearer Authorization header", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(
			new Request("http://localhost/info", {
				headers: { authorization: "Basic dXNlcjpwYXNz" },
			}),
		);
		expect(result).toEqual({ did: null });
	});

	test("accepts a token with the right audience and no sub (iss is the caller)", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(withAuth(await mintToken()));
		expect(result).toEqual({ did: ISSUER });
	});

	test("prefers sub over iss (PDS-issued service token names the user)", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(withAuth(await mintTokenWithSub(USER)));
		expect(result).toEqual({ did: USER });
	});

	test("rejects a token addressed to another service", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(
			withAuth(await mintToken({ aud: "did:web:other.example" })),
		);
		expect(result).toEqual({ did: null });
	});

	test("rejects an expired token", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		const result = await verify(
			withAuth(await mintToken({ exp: Math.floor(Date.now() / 1000) - 60 })),
		);
		expect(result).toEqual({ did: null });
	});

	test("rejects a token whose issuer cannot be resolved", async () => {
		const { verify, resolved } = verifierFor({});
		const result = await verify(withAuth(await mintToken()));
		expect(result).toEqual({ did: null });
		expect(resolved).toEqual([ISSUER]);
	});

	test("rejects a token signed by a key absent from the issuer document", async () => {
		const other = await Secp256k1Keypair.create();
		const jwt = await createServiceJwt({
			iss: ISSUER,
			aud: AUDIENCE,
			lxm: null,
			keypair: other,
		});
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		expect(await verify(withAuth(jwt))).toEqual({ did: null });
	});

	test("retries resolution with forceRefresh after a signature mismatch", async () => {
		const calls: boolean[] = [];
		const verify = createServiceAuthVerifier({
			audience: AUDIENCE,
			resolveDid: async (_did, forceRefresh) => {
				calls.push(forceRefresh);
				return didDoc;
			},
		});
		const other = await Secp256k1Keypair.create();
		const jwt = await createServiceJwt({
			iss: ISSUER,
			aud: AUDIENCE,
			lxm: null,
			keypair: other,
		});
		expect(await verify(withAuth(jwt))).toEqual({ did: null });
		expect(calls).toEqual([false, true]);
	});

	test("garbage in the Bearer header is unauthenticated, not an error", async () => {
		const { verify } = verifierFor({ [ISSUER]: didDoc });
		expect(await verify(withAuth("not-a-jwt"))).toEqual({ did: null });
	});
});
