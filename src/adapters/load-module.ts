import { existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

/**
 * A genuine dynamic `import()`, immune to TypeScript's own rewriting.
 * This project builds with `module: "commonjs"` (required for the CLI's
 * own require()-based entrypoint), and under that setting tsc rewrites a
 * literal `import()` expression into `Promise.resolve().then(() =>
 * require(...))` - so a plain `import(absolutePath)` would compile to
 * `require()` in disguise, never a real ESM load, no matter how the
 * source reads. That silently breaks on any target file that's genuine
 * ESM with no synchronous CommonJS-compatible form (e.g. one with a
 * top-level `await`) on any Node version that doesn't support requiring
 * an ESM graph. Constructing the function from a string hides the
 * `import()` call from tsc's static analysis, so this is Node's actual
 * dynamic import at runtime.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

export interface LoadAttempt {
  /** `undefined` when this attempt threw - see `error` instead. */
  readonly moduleExports: unknown;
  /** Set only when this particular attempt threw. */
  readonly error: unknown;
}

export interface LoadResult {
  readonly viaImport: LoadAttempt;
  readonly viaRequire: LoadAttempt;
}

/**
 * Loads `entryPath` (resolved against the caller's cwd, not this file's
 * own location) via a real dynamic import() AND require(), always both -
 * never short-circuiting on the first one that merely doesn't throw.
 * A framework instance can end up reachable through only one of the two
 * (e.g. an interop wrapper shifting where a named export lands), so an
 * adapter needs both attempts' exports to search, not just whichever
 * loaded first. Shared by every adapter - none of this is
 * framework-specific; finding the actual Command/CAC/etc. instance
 * inside either attempt's exports is each adapter's own job.
 */
export async function loadModule(entryPath: string): Promise<LoadResult> {
  const absolutePath = resolve(process.cwd(), entryPath);

  // Checked up front so a caller can tell "the file doesn't exist" apart
  // from "it exists but doesn't export what we're looking for" - both
  // import() and require() otherwise fail the same opaque way for a
  // missing file. Exact-path only, by design: entryPath is documented as
  // a path to a specific entry file, not a resolvable module specifier,
  // so this never has to account for extension-less or directory-index
  // resolution.
  if (!existsSync(absolutePath)) {
    throw new Error(`cliguard: no such file: "${absolutePath}".`);
  }

  // Dynamic import() requires a file:// URL for an absolute filesystem
  // path on Windows - a raw "C:\foo\bar.js" parses as a URL with scheme
  // "c:" and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL is a
  // no-op in effect on POSIX (still produces a valid file:// URL there).
  const fileUrl = pathToFileURL(absolutePath).href;

  const viaImport = await attempt(() => dynamicImport(fileUrl));
  const viaRequire = await attempt(
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate second attempt for entry points that aren't import()-able
    () => Promise.resolve(require(absolutePath) as unknown),
  );

  return { viaImport, viaRequire };
}

async function attempt(load: () => Promise<unknown>): Promise<LoadAttempt> {
  try {
    return { moduleExports: await load(), error: undefined };
  } catch (error) {
    return { moduleExports: undefined, error };
  }
}
