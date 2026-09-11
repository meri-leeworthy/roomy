import * as fs from "node:fs";
import type { Agent } from "@atproto/api";
import { uploadBlob } from "@roomy-space/sdk";

/** The JSON wire form of an ATProto blob ref as stored in profile records. */
interface BlobJson {
  $type: string;
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface ProfileOptions {
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  /** Path to an image file to set as the profile avatar (png/jpeg, ≤1MB). */
  avatarPath?: string;
  /** Path to an image file to set as the profile banner (png/jpeg, ≤1MB). */
  bannerPath?: string;
}

/**
 * Set (or update) the caller's Roomy profile by writing the
 * `space.roomy.user.profile/self` record on their PDS.
 */
export async function setProfile(
  agent: Agent,
  opts: ProfileOptions,
): Promise<void> {
  const record: Record<string, unknown> = {
    $type: "space.roomy.user.profile",
  };
  if (opts.displayName) record.displayName = opts.displayName;
  if (opts.description) record.description = opts.description;
  if (opts.pronouns) record.pronouns = opts.pronouns;
  if (opts.website) record.website = opts.website;

  if (opts.avatarPath) {
    record.avatar = (await uploadBlobFile(agent, opts.avatarPath, "avatar")).blob;
  }
  if (opts.bannerPath) {
    record.banner = (await uploadBlobFile(agent, opts.bannerPath, "banner")).blob;
  }

  await agent.com.atproto.repo.putRecord(
    {
      collection: "space.roomy.user.profile",
      repo: agent.assertDid,
      rkey: "self",
      record,
    },
    {
      headers: {
        "atproto-proxy": `${agent.assertDid}#atproto_pds`,
      },
    },
  );
}

/** Upload a local image as a blob to the user's PDS and return its ref. */
async function uploadBlobFile(
  agent: Agent,
  path: string,
  field: string,
): Promise<{ blob: BlobJson }> {
  const bytes = fs.readFileSync(path);
  if (bytes.length === 0) throw new Error(`${field} file is empty: ${path}`);
  if (bytes.length > 1000000) {
    throw new Error(
      `${field} file exceeds the 1MB profile-image limit (${bytes.length} bytes): ${path}`,
    );
  }
  // Buffer may back onto a pooled ArrayBuffer — copy the exact range so the
  // upload never sends pooled bytes outside this file.
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const { blob } = await uploadBlob(agent, exact);
  return { blob };
}
