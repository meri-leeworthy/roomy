import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import { CliSessionData } from '../../auth/stores.js';
import { Command } from 'commander';
import chalk from 'chalk';
import { RoomyAccount, Space } from '../../jazz/schema.js';
import { Account } from 'jazz-tools';

export const joinSpaceCommand = new Command('join-space')
  .description('Join a space')
  .option('-s, --space <space>', 'Space ID')
  .option('-i, --invite <invite>', 'Invite ID')
  .option('-w, --worker <handle>', 'Use Jazz Server Worker')
  .action(async (options) => {
    const sessionManager = new OAuthSessionManager();
    const jazzClient = new RoomyJazzClient();

    try {
      let session: CliSessionData | null = null;
      if (options.worker) {
        console.log(chalk.yellow('🎵 Using Jazz Server Worker: ' + options.worker));

        let worker = await sessionManager.getJazzCredentials(options.worker);
        if (!worker) {
          console.error(chalk.red('❌ Jazz Server Worker not found. Please create one first.'));
          process.exit(1);
        }

        console.log(chalk.green('🎵 Using Jazz Server Worker: ' + worker.publicName));
        console.log(worker)
        session = {
          did: `jazz:${worker.accountID}`,
          handle: worker.publicName,
          passphrase: worker.accountSecret,
          jazzAccountID: worker.accountID,
          sessionType: 'jazz-only',
          jazzWorker: worker,
        }
      } else {
        session = await sessionManager.loadSession();
      }

      if (!session) {
        console.error(chalk.red('❌ Not logged in. Run: roomy login'));
        process.exit(1);
      }

      if (!session.jazzAccountID) {
        console.error(chalk.red('❌ No Jazz account ID found. Please log in again.'));
        process.exit(1);
      }

      if (!session.passphrase) {
        console.error(chalk.red('❌ No Jazz passphrase found. Please log in again.'));
        process.exit(1);
      }

      // Initialize Jazz client
      console.log(chalk.blue('🎵 Connecting to Jazz...'));
      
      await jazzClient.initialize(session.jazzAccountID, session.passphrase);

      // Get account
      const account = jazzClient.getAccount();
      if (!account) {
        console.error(chalk.red('❌ No account found. Please log in again.'));
        process.exit(1);
      }

      account.ensureLoaded({resolve: {profile: true}});

      if (!options.space) {
        console.error(chalk.red('❌ No space ID provided.'));
        process.exit(1);
      }

      // if (!options.invite) {
      //   console.error(chalk.red('❌ No invite ID provided.'));
      //   process.exit(1);
      // }

      let loadedSpace = await Space.load(options.space, {resolve: {channels: true, members: true}});

      if (!loadedSpace) {
        console.error(chalk.red('❌ Space not found.'));
        process.exit(1);
      }

      console.log(loadedSpace)

      console.log(chalk.green('🎵 Joining space: ' + options.space));
      // await account.acceptInvite(options.space, options.invite, Space)

      console.log(account)
      await account.ensureLoaded({resolve: {profile: {joinedSpaces: { $each: true}}}});
      console.log(account.profile)

      account.profile?.joinedSpaces?.push(loadedSpace as any);
      console.log(account.profile?.joinedSpaces)
      await account.ensureLoaded({resolve: {profile: {joinedSpaces: { $each: true}}}});

      // some kind of problem with access to the added account/profile being unauthorised
      // 


      loadedSpace.members?.push(account);
      console.log(chalk.green('✅ Joined space: ' + options.space));
      await account.waitForAllCoValuesSync();
      await jazzClient.disconnect();
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('❌ Failed to join space: ' + error));
      process.exit(1);
    }
  })