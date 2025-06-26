import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import type { MessageOptions } from '../../types/index.js';
import { CliSessionData } from '../../auth/stores.js';

export const sendCommand = new Command('send')
  .description('Send a message to a Roomy channel')
  .option('-s, --space <space>', 'Space name or ID')
  .option('-c, --channel <channel>', 'Channel name or ID')
  .option('-m, --message <message>', 'Message content')
  .option('-t, --thread <thread>', 'Thread ID (optional)')
  .option('-r, --reply <messageId>', 'Reply to message ID (optional)')
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
      // Check authentication
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


      const account = await jazzClient.getAccount();
      await account?.ensureLoaded({resolve: {profile: {joinedSpaces: { $each: true}}}});

      console.log("profile", account?.profile)

      // Get or select space
      let spaceId = "space" in options ? options.space : null;
      let selectedSpace;
      if (!spaceId) {
        const spaces = await jazzClient.loadSpaces();

        if (!spaces) {
          console.error(chalk.red('❌ No spaces found. Join a space first on https://roomy.space'));
          process.exit(1);
        }

        if (spaces.length === 0) {
          console.error(chalk.red('❌ No spaces found. Join a space first on https://roomy.space'));
          process.exit(1);
        }

        const { chosenSpace } = await inquirer.prompt([{
          type: 'list',
          name: 'chosenSpace',
          message: 'Select a space:',
          choices: spaces?.map(space => ({
            name: `${space?.name} (${space?.members?.length || 0} members)`,
            value: space
          }))
        }]);
        selectedSpace = chosenSpace;
        spaceId = selectedSpace.id;
      } else {
        // Find space by name or ID
        const spaces = await jazzClient.loadSpaces();
        selectedSpace = spaces?.find(s => s?.id === spaceId || s?.name === spaceId);
        if (!selectedSpace) {
          console.error(chalk.red(`❌ Space "${spaceId}" not found.`));
          process.exit(1);
        }
      }

      // Get or select channel
      let channelId = options.channel;
      let selectedChannel;
      if (!channelId) {
        const channels = await jazzClient.loadChannels(spaceId);

        if (!channels) {
          console.error(chalk.red('❌ No channels found in this space.'));
          process.exit(1);
        }

        if (channels.length === 0) {
          console.error(chalk.red('❌ No channels found in this space.'));
          process.exit(1);
        }

        const { chosenChannel } = await inquirer.prompt([{
          type: 'list',
          name: 'chosenChannel',
          message: 'Select a channel:',
          choices: channels.map(channel => ({
            name: `#${channel.name}`,
            value: channel
          }))
        }]);
        selectedChannel = chosenChannel;
        channelId = selectedChannel.id;
      } else {
        // Find channel by name or ID
        const channels = await jazzClient.loadChannels(spaceId);
        selectedChannel = channels.find(c => c.id === channelId || c.name === channelId);
        if (!selectedChannel) {
          console.error(chalk.red(`❌ Channel "${channelId}" not found.`));
          process.exit(1);
        }
      }

      // // Get message content
      let message = options.message;
      if (!message) {
        const { messageContent } = await inquirer.prompt([{
          type: 'input',
          name: 'messageContent',
          message: 'Enter your message:',
          validate: (input: string) => {
            if (!input.trim()) return 'Message cannot be empty';
            return true;
          }
        }]);
        message = messageContent;
      }

      // Prepare message options
      const messageOptions: MessageOptions = {};
      if (options.thread) messageOptions.threadId = options.thread;
      if (options.reply) messageOptions.replyTo = options.reply;

      // Send message
      console.log(chalk.blue('📨 Sending message...'));
      await jazzClient.sendMessage(spaceId, channelId, message, messageOptions);

      console.log(chalk.green(`✅ Message sent to #${selectedChannel.name} in ${selectedSpace.name}!`));
      await jazzClient.getAccount()?.waitForAllCoValuesSync();
      // Disconnect
      await jazzClient.disconnect();
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });