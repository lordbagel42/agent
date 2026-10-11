/** CPython `shlex.quote`, `shlex.join` and POSIX `shlex.split` (no comments). */

const unsafe = /[^\w@%+=:,./-]/;

export function quote(value: string): string {
  if (value === "") return "''";
  // Like Python's re.ASCII pattern, JavaScript's \w excludes non-ASCII letters.
  if (!unsafe.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const join = (argv: readonly string[]) => argv.map(quote).join(" ");

export class ShlexError extends Error {}

export function split(input: string): string[] {
  const whitespace = " \t\r\n";
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let state: " " | "a" | "'" | '"' = " ";
  for (let index = 0; index < input.length; index++) {
    const character = input[index] as string;
    if (state === "'") {
      if (character === "'") state = "a";
      else token += character;
      continue;
    }
    if (state === '"') {
      if (character === '"') state = "a";
      else if (character === "\\") {
        index++;
        if (index >= input.length) throw new ShlexError("No escaped character");
        const next = input[index] as string;
        // POSIX mode keeps the backslash unless it escapes a quote or itself.
        token += next === '"' || next === "\\" ? next : `\\${next}`;
      } else token += character;
      continue;
    }
    if (whitespace.includes(character)) {
      if (state === "a") {
        tokens.push(token);
        token = "";
        quoted = false;
        state = " ";
      }
      continue;
    }
    state = "a";
    if (character === "'" || character === '"') {
      quoted = true;
      state = character;
    } else if (character === "\\") {
      index++;
      if (index >= input.length) throw new ShlexError("No escaped character");
      token += input[index];
    } else token += character;
  }
  if (state === "'" || state === '"')
    throw new ShlexError("No closing quotation");
  if (state === "a" && (token !== "" || quoted)) tokens.push(token);
  return tokens;
}
