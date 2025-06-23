import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RoomyOAuthClient } from '../../auth/oauth-client.js';
import { SessionManager } from '../../auth/session-manager.js';
import { Agent } from '@atproto/api';

export const loginCommand = new Command('login')
  .description('Login to Roomy using AT Protocol')
  .option('-h, --handle <handle>', 'AT Protocol handle (e.g., user.bsky.social)')
  .action(async (options: { handle?: string }) => {
    const sessionManager = new SessionManager();
    
    try {
      // Check for existing session
      const existingSession = await sessionManager.loadSession();
      if (existingSession) {
        const { useExisting } = await inquirer.prompt([{
          type: 'confirm',
          name: 'useExisting',
          message: `Already logged in as ${existingSession.handle}. Continue with this account?`,
          default: true
        }]);
        
        if (useExisting) {
          console.log(chalk.green(`✅ Using existing session for ${existingSession.handle}`));
          return;
        }
      }

      // Get handle from user
      let handle = options.handle;
      if (!handle) {
        const answers = await inquirer.prompt([{
          type: 'input',
          name: 'handle',
          message: 'Enter your AT Protocol handle:',
          validate: (input: string) => {
            if (!input.trim()) return 'Handle is required';
            if (!input.includes('.')) return 'Handle must be a domain (e.g., user.bsky.social)';
            return true;
          }
        }]);
        handle = answers.handle;
      }

      console.log(chalk.blue('🔐 Starting OAuth flow...'));
      
      // Initialize OAuth client and start flow
      const oauthClient = new RoomyOAuthClient();
      const session = await oauthClient.authorize(handle!);
      
      // Get Jazz passphrase from keyserver
      console.log(chalk.blue('🎵 Getting Jazz credentials...'));
      const agent = new Agent(session);
      
      let passphrase: string;
      try {
        const passphraseResponse = await agent.call(
          'chat.roomy.v1.passphrase',
          undefined,
          undefined,
          {
            headers: {
              'atproto-proxy': 'did:web:jazz.keyserver.roomy.chat#roomy_keyserver',
            },
          }
        );
        passphrase = passphraseResponse.data;
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to get Jazz passphrase, continuing without it'));
        passphrase = '';
      }
      
      // Save session
      await sessionManager.saveSession({
        did: session.did,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        handle: handle!,
        expiresAt: session.expiresAt,
        passphrase
      });
      
      console.log(chalk.green(`✅ Successfully logged in as ${handle}`));
      console.log(chalk.gray('You can now send messages using: roomy send'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Login failed: ${(error as Error).message}`));
      process.exit(1);
    }
  });