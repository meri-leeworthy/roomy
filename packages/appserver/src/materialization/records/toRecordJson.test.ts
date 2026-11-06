/**
 * The lexicons against the records the fold actually produces.
 *
 * `docs/plans/record-migration.md` §4 P2. Two questions, asked of every record
 * rather than of a chosen one:
 *
 *  - **Does it validate?** `@atproto/lexicon` reads the same files
 *    `scripts/publish-lexicons.ts` publishes, so the check is against the
 *    published shape, not a copy of it.
 *  - **Does it carry anything the lexicon does not declare?** The lexicon
 *    validator does not reject an undeclared key — a field the lexicon drops
 *    would validate, and every reader would then drop it — so a record is
 *    walked against the declared properties as well.
 *
 * The corpus supplies the records for everything a space reaches through its
 * log. The kinds whose records the corpus's final fold does not hold — a ban
 * that was lifted, a call that ended, a role that was deleted — get one sample
 * body each, so a lexicon cannot pass by never being asked.
 */

import { describe, expect, test } from "bun:test";
import { Lexicons, jsonToLex, type LexiconDoc } from "@atproto/lexicon";

import { readLexicon } from "../../../scripts/publish-lexicons.ts";
import { feedRows } from "../../streams/recordChanges.ts";
import { CORPUS_STREAM, buildCorpus } from "./corpus.ts";
import { foldChanges, type FoldedRecord } from "./foldChanges.ts";
import { RECORD_KINDS, type RecordKind } from "./recordKinds.ts";
import { toRecordJson } from "./toRecordJson.ts";

const KINDS = Object.keys(RECORD_KINDS) as RecordKind[];

/** Every collection the fold emits, as a lexicon the validator can read. */
const LEXICONS = new Lexicons(
  KINDS.map(
    (kind) =>
      readLexicon(RECORD_KINDS[kind].collection) as unknown as LexiconDoc,
  ),
);

const KIND_BY_COLLECTION: Readonly<Record<string, RecordKind>> =
  Object.fromEntries(KINDS.map((kind) => [RECORD_KINDS[kind].collection, kind]));

/** The property map of a lexicon's record definition. */
interface PropDef {
  readonly type: string;
  readonly properties?: Readonly<Record<string, PropDef>>;
  readonly items?: PropDef;
}

function recordDefinition(kind: RecordKind): {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, PropDef>>;
} {
  const doc = readLexicon(RECORD_KINDS[kind].collection) as unknown as LexiconDoc;
  const main = doc.defs.main as {
    record: { required?: string[]; properties: Record<string, PropDef> };
  };
  return { required: main.record.required ?? [], properties: main.record.properties };
}

const DECLARED: Readonly<Record<RecordKind, Readonly<Record<string, PropDef>>>> =
  Object.fromEntries(KINDS.map((kind) => [kind, recordDefinition(kind).properties])) as Record<
    RecordKind,
    Readonly<Record<string, PropDef>>
  >;

/**
 * Every key in a value that the property map it is checked against lacks.
 *
 * An `unknown` field is open by design — the walk stops there — and so is any
 * non-object type: `bytes` carries its own `{"$bytes": …}` envelope, which is
 * the encoding, not a field.
 */
function undeclaredFields(
  value: unknown,
  def: PropDef | undefined,
  path: string,
): string[] {
  if (def === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      undeclaredFields(item, def.items, `${path}/${index}`),
    );
  }
  if (value === null || typeof value !== "object") return [];
  if (def.type !== "object") return [];

  const properties = def.properties ?? {};
  const found: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    // `$type` belongs to the record envelope; no lexicon declares it.
    if (key === "$type") continue;
    const property = properties[key];
    if (property === undefined) {
      found.push(`${path}/${key}`);
      continue;
    }
    found.push(...undeclaredFields(item, property, `${path}/${key}`));
  }
  return found;
}

/** The kind a collection belongs to, for a fold whose rows are checked. */
function kindOf(collection: string): RecordKind {
  const kind = KIND_BY_COLLECTION[collection];
  if (kind === undefined) {
    throw new Error(`no record kind declares ${collection}`);
  }
  return kind;
}

/** Assert a record validates and carries nothing its lexicon does not declare. */
function expectRecord(kind: RecordKind, record: unknown): void {
  const collection = RECORD_KINDS[kind].collection;
  expect(() =>
    LEXICONS.assertValidRecord(collection, jsonToLex(record as never)),
  ).not.toThrow();
  expect(
    undeclaredFields(record, { type: "object", properties: DECLARED[kind] }, collection),
  ).toEqual([]);
}

/** The record a lexicon describes, with the two fields every record carries. */
function enveloped(
  kind: RecordKind,
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    $type: RECORD_KINDS[kind].collection,
    ...body,
    createdAt: "2023-11-14T22:13:20.000Z",
  };
}

/**
 * One body per kind: the record as a repo holds it.
 *
 * The nulls and the fold's own field names are not here — a record has no null,
 * and `toRecordJson` is what turns a folded body into one of these. The corpus
 * covers that direction; these cover every lexicon having a record to accept.
 */
const SAMPLES: Readonly<Record<RecordKind, Readonly<Record<string, unknown>>>> = {
  message: {
    room: "01M6R8PSB8Z9391DFQBJ77P3A2",
    author: "did:plc:sample-user",
    content: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from("hello").toString("base64") },
    },
    extensions: {},
  },
  reaction: {
    target: "01M6R8PSB8J7T2Q034X2X2ECG9",
    user: "did:plc:sample-user",
    reaction: "👍",
    bridged: true,
  },
  room: {
    kind: "space.roomy.channel",
    name: "general",
    defaultAccess: "readwrite",
    // A soft-deleted room stays in the set, marked.
    deleted: true,
    parent: "01M6R8PSB8Z9391DFQBJ77P3A2",
  },
  spaceInfo: {
    name: "Sample space",
    avatar: "atblob://did:plc:sample-user/bafkreisample",
    description: "A space",
    allowPublicJoin: false,
  },
  spaceSidebar: {
    categories: [
      {
        id: "01M6R8PSB9NVYWRYFSMAK7WWGE",
        name: "General",
        children: ["01M6R8PSB8Z9391DFQBJ77P3A2"],
      },
    ],
  },
  membership: { user: "did:plc:sample-user", can: "admin" },
  ban: { user: "did:plc:sample-user" },
  invite: { token: "invite-token", createdBy: "did:plc:sample-user" },
  role: { name: "Moderator", description: "keeps the peace" },
  roleGrant: { user: "did:plc:sample-user", role: "01M6R8PSB8W6J0T07VK4R4G55C" },
  roomPermission: {
    role: "01M6R8PSB8W6J0T07VK4R4G55C",
    room: "01M6R8PSB8Z9391DFQBJ77P3A2",
    permission: "read",
  },
  federationRequest: {
    federatingSpace: "did:web:origin.example",
    requestedBy: "did:plc:sample-user",
    status: "active",
    decidedBy: "did:plc:sample-admin",
  },
  federationGrant: {
    federatingSpace: "did:web:receiving.example",
    origin: [{ room: "01M6R8PSB8Z9391DFQBJ77P3A2", permission: "read" }],
    receiver: [
      {
        room: "01M6R8PSB8Z9391DFQBJ77P3A2",
        permission: "read",
        grantee: "did:web:receiving.example",
        granteeKind: "members",
      },
    ],
  },
  profile: { displayName: "Sample User", description: "a person" },
  calendarLink: {
    groupSlug: "sample-group",
    tenantId: "tenant-1",
    apiUrl: "https://calendar.example",
  },
  voiceCall: {
    room: "01M6R8PSB8Z9391DFQBJ77P3A2",
    source: "user",
    startedAt: 1_700_000_000_000,
    joined: "did:plc:sample-user",
  },
};

/** One folded record of a kind, as the fold would hand it over. */
function foldedOf(
  kind: RecordKind,
  record: Readonly<Record<string, unknown>>,
  rkey = "self",
): FoldedRecord {
  return {
    repo: "did:plc:sample-space",
    collection: RECORD_KINDS[kind].collection,
    rkey,
    record,
    orderStamp: "01HF7YAT000000000000000001",
    ops: 1,
  };
}

/**
 * The corpus, through the adapter, the feed, and the fold — no DB, because the
 * rows are what the fold reads and `feedRows` is the encoding they get.
 */
function corpusFold(): FoldedRecord[] {
  const { entries } = buildCorpus({ recordProducingOnly: true });
  return foldChanges(entries.flatMap((entry) => feedRows(entry, CORPUS_STREAM)));
}

describe("the lexicons", () => {
  test("there is one per collection the fold emits", () => {
    expect([...LEXICONS.docs.values()].map((doc) => doc.id).sort()).toEqual(
      KINDS.map((kind) => RECORD_KINDS[kind].collection).sort(),
    );
  });

  test("each accepts a record of its kind", () => {
    for (const kind of KINDS) expectRecord(kind, enveloped(kind, SAMPLES[kind]));
  });
});

describe("the corpus, as records", () => {
  test("every folded record validates against its collection's lexicon", () => {
    const folded = corpusFold();
    expect(folded.length).toBeGreaterThan(0);

    const flagged: string[] = [];
    for (const record of folded) {
      const json = toRecordJson(record);
      if (!json.ok) {
        flagged.push(`${record.collection}/${record.rkey}`);
        continue;
      }
      expectRecord(kindOf(record.collection), json.record);
    }

    // The one grant the corpus holds is a patch, not the record's grant set —
    // and it is the only folded record the record model cannot state.
    expect(flagged).toEqual([
      `${RECORD_KINDS.federationGrant.collection}/did:web:adapter-fixture.example`,
    ]);
  });

  test("no record carries a field its lexicon does not declare", () => {
    for (const record of corpusFold()) {
      const json = toRecordJson(record);
      if (!json.ok) continue;
      expect(
        undeclaredFields(
          json.record,
          { type: "object", properties: DECLARED[kindOf(record.collection)] },
          record.collection,
        ),
      ).toEqual([]);
    }
  });

  test("createdAt is the ordering stamp's time, not the clock", () => {
    for (const record of corpusFold()) {
      const json = toRecordJson(record);
      if (!json.ok) continue;
      // The corpus stamps every entry with one receipt, so every record made
      // from it carries that instant — not the clock this test runs at.
      expect(json.record["createdAt"]).toBe("2023-11-14T22:13:20.000Z");
    }
  });
});

describe("records the record model cannot state", () => {
  test("a folded grant is flagged rather than bent into a record", () => {
    const json = toRecordJson(
      foldedOf("federationGrant", {
        scope: "receiver",
        room: "01M6R8PSB8Z9391DFQBJ77P3A2",
        grantee: "did:web:receiving.example",
        granteeKind: "members",
        permission: "read",
      }),
    );
    expect(json.ok).toBe(false);
    if (json.ok) return;
    expect(json.reason).toContain("grant patch");
  });

  test("a profile avatar and a bridged handle have no field in the record", () => {
    for (const field of ["avatar", "handle"] as const) {
      const json = toRecordJson(
        foldedOf("profile", {
          name: "Sample User",
          [field]:
            field === "avatar" ? "atblob://did:plc:sample-user/bafkreisample" : "someone",
        }),
      );
      expect(json.ok).toBe(false);
      if (json.ok) continue;
      expect(json.reason).toContain(field);
    }
  });

  test("a profile's name and description do map onto the record", () => {
    const json = toRecordJson(
      foldedOf("profile", { name: "Sample User", description: "a person" }),
    );
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.record["displayName"]).toBe("Sample User");
    expect(json.record["description"]).toBe("a person");
    expect(json.record["name"]).toBeUndefined();
  });

  test("a membership the fold began at an admin grant still names its member", () => {
    const json = toRecordJson(
      foldedOf("membership", { can: "admin" }, "did:plc:sample-user"),
    );
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.record["user"]).toBe("did:plc:sample-user");
  });
});

describe("the checks bite", () => {
  test("a lexicon that drops a field is caught", () => {
    const doc = readLexicon(
      RECORD_KINDS.reaction.collection,
    ) as unknown as LexiconDoc;
    const main = doc.defs.main as {
      record: { properties: Record<string, PropDef> };
    };
    const record = enveloped("reaction", SAMPLES.reaction);

    // An optional field removed from the lexicon: the validator accepts the
    // record anyway, which is why the walk exists.
    delete main.record.properties["bridged"];
    expect(() =>
      new Lexicons([doc]).assertValidRecord(
        RECORD_KINDS.reaction.collection,
        jsonToLex(record as never),
      ),
    ).not.toThrow();
    expect(
      undeclaredFields(
        record,
        { type: "object", properties: main.record.properties },
        RECORD_KINDS.reaction.collection,
      ),
    ).toEqual([`${RECORD_KINDS.reaction.collection}/bridged`]);

    // A required field removed is invisible to the validator too: `required`
    // is only enforced for a property the lexicon still declares.
    delete main.record.properties["target"];
    expect(() =>
      new Lexicons([doc]).assertValidRecord(
        RECORD_KINDS.reaction.collection,
        jsonToLex(record as never),
      ),
    ).not.toThrow();
    expect(
      undeclaredFields(
        record,
        { type: "object", properties: main.record.properties },
        RECORD_KINDS.reaction.collection,
      ).sort(),
    ).toEqual([
      `${RECORD_KINDS.reaction.collection}/bridged`,
      `${RECORD_KINDS.reaction.collection}/target`,
    ]);

    // What the validator does catch is a field of the wrong shape.
    expect(() =>
      new Lexicons([readLexicon(RECORD_KINDS.reaction.collection) as unknown as LexiconDoc]).assertValidRecord(
        RECORD_KINDS.reaction.collection,
        jsonToLex({ ...record, bridged: "yes" } as never),
      ),
    ).toThrow();
  });
});
