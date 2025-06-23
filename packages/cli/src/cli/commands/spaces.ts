import { Command } from 'commander';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';

export const spacesCommand = new Command('spaces')
  .description('List joined spaces')
  .action(async () => {
    const sessionManager = new OAuthSessionManager();
    
    try {
      // Check authentication
      const session = await sessionManager.loadSession();
      if (!session) {
        console.error(chalk.red('❌ Not logged in. Run: roomy login'));
        process.exit(1);
      }

      if (!session.passphrase) {
        console.error(chalk.red('❌ No Jazz passphrase found. Please log in again.'));
        process.exit(1);
      }

      // Initialize Jazz client
      console.log(chalk.blue('🎵 Loading spaces...'));
      const jazzClient = new RoomyJazzClient();
      await jazzClient.initialize(session.passphrase);

      // Get spaces
      const spaces = await jazzClient.loadSpaces();
      
      if (spaces.length === 0) {
        console.log(chalk.yellow('📭 No spaces found. Join a space first on https://roomy.space'));
        return;
      }

      console.log(chalk.green(`\n📌 Your spaces (${spaces.length}):`));
      console.log(chalk.gray('─'.repeat(50)));
      
      for (const space of spaces) {
        const memberCount = space.members?.length || 0;
        const channelCount = space.channels?.length || 0;
        
        console.log(`${chalk.cyan('●')} ${chalk.bold(space.name)}`);
        console.log(`  ${chalk.gray('ID:')} ${space.id}`);
        console.log(`  ${chalk.gray('Members:')} ${memberCount}`);
        console.log(`  ${chalk.gray('Channels:')} ${channelCount}`);
        if (space.description) {
          console.log(`  ${chalk.gray('Description:')} ${space.description}`);
        }
        console.log('');
      }

      // Disconnect
      await jazzClient.disconnect();
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to load spaces: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });