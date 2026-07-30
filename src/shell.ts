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
 * Deliberately conservative in one direction only: a pattern we fail to
 * recognize means the command proceeds, which is the behavior that already
 * existed. A path we flag is merely *checked* — it is blocked only if another
 * agent actually holds a claim on it.
 */

/** Commands whose last argument is the file they create or overwrite. */
const LAST_ARG_WRITERS = new Set(['mv', 'cp', 'install', 'ln', 'truncate', 'touch']);

/** Commands where every non-flag argument is a target. */
const ALL_ARG_WRITERS = new Set(['rm', 'unlink', 'shred']);

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
export function shellWriteTargets(command: string): string[] {
  const targets: string[] = [];

  for (const match of command.matchAll(REDIRECT)) {
    const target = match[1];
    if (target) targets.push(normalize(unquote(target)));
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
      const last = args.filter((arg) => !isFlag(arg)).at(-1);
      if (last) targets.push(normalize(last));
      continue;
    }

    if (ALL_ARG_WRITERS.has(program)) {
      for (const arg of args) if (!isFlag(arg)) targets.push(normalize(arg));
      continue;
    }

    if (LAST_ARG_WRITERS.has(program)) {
      const positional = args.filter((arg) => !isFlag(arg));
      const last = positional.at(-1);
      // `mv a b` writes b; `touch a` writes a. Either way it is the last one.
      if (last) targets.push(normalize(last));
      continue;
    }
  }

  // Order-preserving dedupe: the same file named twice is still one check.
  return [...new Set(targets.filter((target) => target.length > 0))];
}
