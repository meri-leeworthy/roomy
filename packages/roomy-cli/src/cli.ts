#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { getOrInitAuth } from "./auth.js";
import { loadRoomMap, getOrCreateRoomForSession } from "./rooms.js";
import { sendMessage, readStdin } from "./send.js";

const program = new Command();

program
  .name("roomy-cli")
  .description("CLI tool for Roomy - enables remote-controllable agents via Claude Code integration")
  .version("0.1.0");

program
  .command("send")
  .description("Send message from stdin to a room")
  .requiredOption("--claude-session <id>", "Claude Code session ID")
  .action(async (options) => {
    try {
      const config = loadConfig();

      // Authenticate
      const agent = await getOrInitAuth(config);

      // Load room map
      const roomMap = await loadRoomMap(config.roomMapFile);

      // Get or create room for this session
      const roomUlid = await getOrCreateRoomForSession(
        agent,
        config.spaceDid,
        options.claudeSession,
        roomMap,
        config.roomMapFile
      );

      // Read stdin
      const stdin = await readStdin();

      // Send message
      await sendMessage(agent, config.leafUrl, config.leafDid, roomUlid, stdin);

      console.error(`Message sent to room ${roomUlid}`);
      process.exit(0);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);

      // Exit with appropriate code
      if (error instanceof Error) {
        if (error.message.includes("Authentication") || error.message.includes("credentials")) {
          process.exit(1);
        } else if (error.message.includes("No input") || error.message.includes("Empty input")) {
          process.exit(0); // Clean exit for empty input
        } else if (error.message.includes("Invalid input")) {
          process.exit(3);
        }
      }

      process.exit(2); // Default to network/operation error
    }
  });

// Parse arguments
program.parseAsync(process.argv).catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(2);
});
