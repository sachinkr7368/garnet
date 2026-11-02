/// The constant (last `::` segment) at a word, or null when the word is not a class/module name.
export function constantName(word: string | undefined): string | null {
  const last = word?.split("::").pop();
  return last && /^[A-Z]\w*$/.test(last) ? last : null;
}

/// Regex (valid in both Rust `regex` and JS) for Ruby lines that subclass, include, extend or prepend `name`.
export function implementationPattern(name: string): string {
  const ref = `([\\w:]*::)?${name}([^\\w:]|$)`;
  return `^\\s*(class\\s+[\\w:]+\\s*<\\s*${ref}|(include|extend|prepend)(\\s+|\\s*\\()(.*[\\s,(])?${ref})`;
}
