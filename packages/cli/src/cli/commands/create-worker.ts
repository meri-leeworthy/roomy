import { createWorkerAccount } from 'jazz-run/createWorkerAccount';
import { Command } from 'commander';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import { RoomyAccount } from '../../jazz/schema.js';

export const createWorkerCommand = new Command('create-worker')
  .description('Create a worker account')
  .option('-n, --name <name>', 'Name of the worker account')
  .action(async (options: { name?: string }) => {
    const name = options.name || 'jazz-test';
    const sessionManager = new OAuthSessionManager();
    const jazzClient = new RoomyJazzClient();

    try {
      const account = await createWorkerAccount({
        name: name,
        peer: `wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com`,
      });

      // Store the worker in the session manager
      await sessionManager.addJazzWorker(
        account.accountID,
        name,
        account.agentSecret
      );

      await jazzClient.initialize(account.accountID, account.agentSecret, true);

      const jazzAccount = jazzClient.getAccount();
      console.log(jazzAccount);

      jazzAccount?.castAs(RoomyAccount);

      if (jazzAccount?.profile) {
        jazzAccount.profile.name = name;
      }

      await jazzAccount?.waitForAllCoValuesSync();

      console.log(
        chalk.green(`✅ Created and stored Jazz Server Worker: ${name}`)
      );
      console.log(chalk.gray(`Account ID: ${account.accountID}`));
      console.log(chalk.gray('You can now send messages using: roomy send'));
      process.exit(0);
    } catch (error) {
      console.error(
        chalk.red(`❌ Failed to create worker: ${(error as Error).message}`)
      );
      process.exit(1);
    }
  });
