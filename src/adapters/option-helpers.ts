/** A single-character option name gets one dash (`-v`), anything longer gets two (`--verbose`). */
export function dashPrefix(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}
