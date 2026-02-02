import type { Agent } from "@atproto/api";
import { createLeafClient } from "@roomy/sdk";

/**
 * Send a message to a Roomy room
 *
 * @param agent - Authenticated ATProto agent
 * @param leafUrl - Leaf server URL
 * @param leafDid - Leaf server DID for service auth
 * @param roomUlid - The room ULID to post to
 * @param text - The message text to send
 * @throws Error if message sending fails (exit code 2)
 */
export async function sendMessage(
  agent: Agent,
  leafUrl: string,
  leafDid: string,
  roomUlid: string,
  text: string
): Promise<void> {
  try {
    const leafClient = createLeafClient(agent, { leafUrl, leafDid });

    await leafClient.createMessage({
      room: roomUlid,
      text,
    });
  } catch (error) {
    throw new Error(
      `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Read all content from stdin
 *
 * @returns The trimmed stdin content
 * @throws Error if stdin is empty after trimming (exits with code 0 and warning)
 */
export async function readStdin(): Promise<string> {
  // Check if stdin is a TTY (interactive terminal)
  // If so, there's no piped input
  if (process.stdin.isTTY) {
    throw new Error("No input provided. Pipe content to stdin.");
  }

  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      const content = Buffer.concat(chunks).toString("utf-8");
      const trimmed = content.trim();

      if (!trimmed) {
        reject(new Error("Empty input. Nothing to send."));
        return;
      }

      // Warn if input is very large (> 1MB)
      const sizeInMB = content.length / (1024 * 1024);
      if (sizeInMB > 1) {
        console.error(`Warning: Large input detected (${sizeInMB.toFixed(2)}MB)`);
      }

      resolve(trimmed);
    });

    process.stdin.on("error", (error) => {
      reject(new Error(`Failed to read stdin: ${error.message}`));
    });
  });
}
