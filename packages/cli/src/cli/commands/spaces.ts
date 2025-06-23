import { Command } from 'commander';

export const spacesCommand = new Command('spaces')
  .description('List joined spaces')
  .action(async () => {
    console.log('🚧 Spaces command - Coming soon!');
  });