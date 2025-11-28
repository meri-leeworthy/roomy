import { CodecType } from "scale-ts";
import type { eventCodec, eventVariantCodec } from "./encoding";

type DecodedEventPayload = ReturnType<(typeof eventCodec)["dec"]>;
type EventKind = DecodedEventPayload["variant"]["kind"];

export type EventType<TVariant extends EventKind | undefined = undefined> =
  TVariant extends undefined
    ? DecodedEventPayload
    : Omit<DecodedEventPayload, "variant"> & {
        variant: Extract<DecodedEventPayload["variant"], { kind: TVariant }>;
      };

export type StreamEvent = CodecType<typeof eventCodec>;
export type StreamEventVariants = CodecType<typeof eventVariantCodec>;
export type StreamEventVariantStr = StreamEventVariants["kind"];
export type StreamEventVariant<K extends StreamEventVariantStr> = Extract<
  StreamEventVariants,
  { kind: K }
>["data"];

export type StreamHashId = string & { __brand: "streamHashId" };

export type Ulid = string & { __brand: "ulid" };

export type StreamIndex = number & { __brand: "streamIndex" };

export interface EncodedStreamEvent {
  idx: StreamIndex;
  user: string;
  payload: ArrayBuffer;
}
