/**
 * Minimal flag parsing for the CLI entry points:
 *   --days 7   --limit 10   --since 30   --dry-run
 *   --relabel  --relabel-all  --relabel-before <iso-date>
 */
export interface CliArgs {
  days?: number;
  limit?: number;
  /** Only classify mentions published within this many days. */
  since?: number;
  /**
   * Clear existing labels before classifying, so mentions decided under an
   * older prompt are reconsidered. Scoped to companies carrying sector/ticker
   * context unless --relabel-all is given.
   */
  relabel: boolean;
  relabelAll: boolean;
  /** Only relabel mentions classified before this ISO timestamp. */
  relabelBefore?: string;
  dryRun: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, yes: false, relabel: false, relabelAll: false };

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
      case '--relabel':
        args.relabel = true;
        break;
      case '--relabel-all':
        args.relabel = true;
        args.relabelAll = true;
        break;
      case '--relabel-before': {
        if (value && !Number.isNaN(Date.parse(value))) args.relabelBefore = value;
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
