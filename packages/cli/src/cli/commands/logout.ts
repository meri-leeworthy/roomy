import { Command } from 'commander';
import chalk from 'chalk';
import { SessionManager } from '../../auth/session-manager.js';

export const logoutCommand = new Command('logout')
  .description('Logout from Roomy')
  .action(async () => {
    const sessionManager = new SessionManager();
    
    try {
      const session = await sessionManager.loadSession();
      if (!session) {
        console.log(chalk.yellow('⚠️  No active session found'));
        return;
      }
      
      await sessionManager.clearSession();
      console.log(chalk.green('✅ Successfully logged out'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Logout failed: ${(error as Error).message}`));
      process.exit(1);
    }
  });