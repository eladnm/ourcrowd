/**
 * Minimal flag parsing for the CLI entry points:
 *   --days 7   --limit 10   --since 30   --dry-run
 */
export interface CliArgs {
  days?: number;
  limit?: number;
  /** Only classify mentions published within this many days. */
  since?: number;
  dryRun: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, yes: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--days': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) args.days = parsed;
        i++;
        break;
      }
      case '--limit': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) args.limit = parsed;
        i++;
        break;
      }
      case '--since': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) args.since = parsed;
        i++;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
    }
  }
  return args;
}
