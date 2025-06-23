import { Command } from 'commander';

export const channelsCommand = new Command('channels')
  .description('List channels in a space')
  .requiredOption('-s, --space <space>', 'Space name or ID')
  .action(async (options) => {
    console.log('🚧 Channels command - Coming soon!');
    console.log('Options:', options);
  });