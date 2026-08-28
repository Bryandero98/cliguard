import { dirname, resolve } from "path";

/**
 * Captures whatever instance a target file's own top-level code
 * constructs from `packageName` - even when the target never exports
 * that instance anywhere `module.exports` reaches. Many real CLIs build
 * their Commander/CAC instance inside a function that only runs when
 * something actually calls it (or just never bother exporting it, since
 * they have no reason to) - `findCommand`/`findCac` alone only ever
 * catch the minority that do.
 *
 * How: Node caches a CommonJS module by its resolved absolute path.
 * Resolving `packageName` from the *target file's own directory* (not
 * this package's - a different copy, per commander.adapter.ts's
 * `looksLikeCommand` doc) and mutating the exact object at that cached
 * path means the target's own later `require(packageName)` - resolving
 * to the same path - returns this already-patched object. There's no
 * way for the target to tell the difference: `new Command()` still
 * returns a real `Command` (the patch is a construct-trapping `Proxy`
 * around the real class, transparent to `instanceof` and to every
 * static/instance member), it's just also recorded here as a side
 * effect.
 *
 * Only reaches CommonJS construction - a direct `new ClassExport()`, or
 * a named factory function that closes over the real class and returns
 * `new ClassExport()` internally (commander's `createCommand`, cac's
 * `cac()` - patching only the class export wouldn't catch these, since
 * the factory's own closure still points at the *original* class, not
 * whatever we later put in `moduleExports[classExportName]`). A target
 * that's genuine ESM, reaching the framework via a static `import`
 * rather than `require`, isn't reachable this way - Node's ESM module
 * cache is separate and not patchable from CommonJS. That's a real,
 * documented limit, not a bug: commander and cac both ship CJS-only, so
 * even an ESM target almost always reaches them through interop's own
 * require() underneath - the case this can't reach is the rare one.
 */
export function captureConstructions(
  packageName: string,
  entryPath: string,
  classExportName: string,
  factoryExportNames: readonly string[],
): unknown[] {
  const captured: unknown[] = [];

  let moduleExports: Record<string, unknown>;
  try {
    const targetDir = dirname(resolve(process.cwd(), entryPath));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolving/patching the target's own copy of a CJS package, not a static dependency of this file
    const resolvedPath = require.resolve(packageName, { paths: [targetDir] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    moduleExports = require(resolvedPath) as Record<string, unknown>;
  } catch {
    // The target doesn't have this package resolvable from its own
    // location at all - nothing to patch, nothing to capture. The
    // caller's existing "no instance found" error already covers this.
    return captured;
  }

  const record = (instance: unknown): void => {
    if (instance && typeof instance === "object") captured.push(instance);
  };

  const RealClass = moduleExports[classExportName];
  if (typeof RealClass === "function") {
    moduleExports[classExportName] = new Proxy(RealClass as new (...args: unknown[]) => object, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(
          target as new (...a: unknown[]) => object,
          args,
          newTarget as new (...a: unknown[]) => object,
        );
        record(instance);
        return instance;
      },
    });
  }

  for (const factoryName of factoryExportNames) {
    const realFactory = moduleExports[factoryName];
    if (typeof realFactory === "function") {
      moduleExports[factoryName] = (...args: unknown[]): unknown => {
        const instance = (realFactory as (...a: unknown[]) => unknown)(...args);
        record(instance);
        return instance;
      };
    }
  }

  return captured;
}
