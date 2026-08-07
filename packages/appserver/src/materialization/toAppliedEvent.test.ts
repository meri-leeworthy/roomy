import { describe, expect, test } from "bun:test";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import { toAppliedEvent } from "./toAppliedEvent.ts";

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");
const MENTIONED = "did:plc:mentioned-user";

function decoded(event: Event, idx: number): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user: USER };
}

/** Build a createMessage event with a rich-text body in the decoded `{ buf }` form. */
function richTextMessageEvent(blocks: unknown[]): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: newUlid(),
    body: {
      mimeType: "application/vnd.roomy.richtext+json",
      data: {
        buf: new TextEncoder().encode(
          JSON.stringify({
            $type: "space.roomy.richtext.document",
            blocks,
          }),
        ),
      },
    },
    extensions: {},
  } as unknown as Event;
}

/** Build a createMessage event with a legacy markdown body + mentions sidecar. */
function legacyMessageEvent(mentions: string[]): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: newUlid(),
    body: {
      mimeType: "text/markdown",
      data: { buf: new TextEncoder().encode("hello @user") },
    },
    extensions: {
      "space.roomy.extension.mentions.v0": { mentions },
    },
  } as unknown as Event;
}

describe("toAppliedEvent — mentions extraction", () => {
  test("new-format body: mentions come from #didMention facets", () => {
    const event = richTextMessageEvent([
      {
        $type: "space.roomy.richtext.blocks#text",
        text: `hi ${MENTIONED}`,
        facets: [
          {
            index: { byteStart: 3, byteEnd: 3 + MENTIONED.length },
            features: [
              { $type: "space.roomy.richtext.facet#didMention", did: MENTIONED },
            ],
          },
        ],
      },
    ]);

    const applied = toAppliedEvent(decoded(event, 1), STREAM);
    expect(applied.details?.mentions).toEqual([MENTIONED]);
  });

  test("legacy body without the sidecar: mentions is undefined", () => {
    const event = {
      $type: "space.roomy.message.createMessage.v0",
      id: newUlid(),
      room: newUlid(),
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode("hello") },
      },
      extensions: {},
    } as unknown as Event;

    const applied = toAppliedEvent(decoded(event, 1), STREAM);
    expect(applied.details?.mentions).toBeUndefined();
  });

});
