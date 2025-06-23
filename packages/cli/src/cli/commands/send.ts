import { Command } from 'commander';

export const sendCommand = new Command('send')
  .description('Send a message to a Roomy channel')
  .option('-s, --space <space>', 'Space name or ID')
  .option('-c, --channel <channel>', 'Channel name or ID')
  .option('-m, --message <message>', 'Message content')
  .option('-t, --thread <thread>', 'Thread ID (optional)')
  .option('-r, --reply <messageId>', 'Reply to message ID (optional)')
  .action(async (options) => {
    console.log('🚧 Send command - Coming soon!');
    console.log('Options:', options);
  });