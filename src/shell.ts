/**
 * Finding the files a shell command would write.
 *
 * Claim enforcement covered the structured edit tools (Write, Edit,
 * apply_patch) but not the shell, so `echo x > server/api.ts` walked straight
 * through a claim the design promises is *enforced*, not advised. An agent
 * does not have to be malicious to take that path — being told "you are
 * blocked, do not work around it" and then finding an unblocked route is
 * exactly the situation this closes.
 *
 * Deliberately conservative: a pattern we recognize yields exact paths, while
 * unresolved or unrecognized mutation syntax marks the analysis incomplete so
 * the hook checks the whole workspace. A path is blocked only if another agent
 * actually holds a claim on it.
 */

/** Commands whose last argument is the file they create or overwrite. */
const LAST_ARG_WRITERS = new Set(['mv', 'cp', 'install', 'ln', 'truncate', 'touch']);

/** Commands where every non-flag argument is a target. */
const ALL_ARG_WRITERS = new Set(['rm', 'unlink', 'shred']);

/** Programs whose ordinary form does not mutate the filesystem. */
const READ_ONLY_PROGRAMS = new Set([
  'cat', 'echo', 'printf', 'pwd', 'ls', 'rg', 'grep', 'head', 'tail', 'wc',
  'cut', 'sort', 'uniq', 'tr', 'which', 'type', 'true', 'false', 'test', '[',
]);

export interface ShellWriteAnalysis {
  targets: string[];
  /** False means the hook must conservatively check the whole workspace. */
  complete: boolean;
}

/**
 * `>` and `>>`, with an optional file descriptor, not `>&`. Also catches the
 * redirect in `cat > file <<'EOF'`, which is the usual way an agent writes a
 * whole file from a shell.
 */
const REDIRECT = /(?<![>&])>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;

const TOKEN = /"[^"]*"|'[^']*'|\S+/g;

function unquote(token: string): string {
  const match = /^"(.*)"$|^'(.*)'$/s.exec(token);
  return match ? (match[1] ?? match[2] ?? token) : token;
}

/** Strips a leading ./ so the daemon compares the same string a glob would. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '');
}

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

/** Each segment runs one program: split on the operators that end a command. */
function segmentsOf(command: string): string[] {
  return command
    .split(/\|\||&&|[;\n|]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function programOf(argv: string[]): string {
  // Skip leading VAR=value assignments and common prefixes so `sudo sed -i`
  // and `LC_ALL=C sed -i` are still recognized as sed.
  let index = 0;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? '')) index += 1;
  if (argv[index] === 'sudo' || argv[index] === 'command' || argv[index] === 'env') index += 1;
  const program = argv[index] ?? '';
  const slash = program.lastIndexOf('/');
  return slash === -1 ? program : program.slice(slash + 1);
}

/** Every path this command line would create, overwrite, or delete. */
export function analyzeShellCommand(command: string): ShellWriteAnalysis {
  const targets: string[] = [];
  let complete = !/[`$][({A-Za-z_]/.test(command);

  for (const match of command.matchAll(REDIRECT)) {
    const target = match[1];
    if (target) {
      const unquoted = normalize(unquote(target));
      if (/[$`]/.test(unquoted)) complete = false;
      else targets.push(unquoted);
    }
  }

  for (const segment of segmentsOf(command)) {
    const tokens = segment.match(TOKEN) ?? [];
    const argv = tokens.map(unquote);
    const program = programOf(argv);
    // Everything after the program name, minus redirections, which the pass
    // above already collected.
    const start = argv.indexOf(tokens.map(unquote).find((t) => t.endsWith(program)) ?? program) + 1;
    const args = argv.slice(start).filter((arg) => !/^\d?>>?$/.test(arg));

    if (program === 'tee') {
      for (const arg of args) if (!isFlag(arg)) targets.push(normalize(arg));
      continue;
    }

    if (program === 'dd') {
      for (const arg of args) {
        if (arg.startsWith('of=')) targets.push(normalize(arg.slice(3)));
      }
      continue;
    }

    if (program === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
      const iIndex = args.findIndex((arg) => arg === '-i' || arg.startsWith('-i'));
      const afterI = args.slice(iIndex + 1);
      if (args[iIndex] === '-i' && afterI[0] === '') afterI.shift();
      const positional = afterI.filter((arg) => !isFlag(arg));
      for (const file of positional.slice(1)) targets.push(normalize(file));
      continue;
    }

    if (ALL_ARG_WRITERS.has(program)) {
      for (const arg of args) if (!isFlag(arg)) targets.push(normalize(arg));
      continue;
    }

    if (LAST_ARG_WRITERS.has(program)) {
      const positional = args.filter((arg) => !isFlag(arg));
      const targetDirIndex = args.findIndex((arg) => arg === '-t' || arg === '--target-directory');
      const equalsTarget = args.find((arg) => arg.startsWith('--target-directory='));
      const compactTarget = args.find((arg) => arg.startsWith('-t') && arg.length > 2);
      const last = targetDirIndex >= 0
        ? args[targetDirIndex + 1]
        : equalsTarget?.slice(equalsTarget.indexOf('=') + 1) ?? compactTarget?.slice(2) ?? positional.at(-1);
      // `mv a b` writes b; `touch a` writes a. Either way it is the last one.
      if (last) targets.push(normalize(last));
      continue;
    }

    if (program === 'git') {
      const subcommand = args.find((arg) => !isFlag(arg));
      if (!subcommand || !new Set(['status', 'diff', 'log', 'show', 'grep', 'rev-parse', 'branch']).has(subcommand)) {
        complete = false;
      }
      continue;
    }

    if (!READ_ONLY_PROGRAMS.has(program) && program !== '') complete = false;
  }

  // Order-preserving dedupe: the same file named twice is still one check.
  return { targets: [...new Set(targets.filter((target) => target.length > 0))], complete };
}

export function shellWriteTargets(command: string): string[] {
  return analyzeShellCommand(command).targets;
}
