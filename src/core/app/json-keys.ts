/** Detect duplicate decoded keys after Fastify's real JSON parser validated the syntax. */
export function duplicateJsonKey(source: string): boolean {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (/\s/.test(source[next] ?? '') && next < source.length) next++;
      const keys = stack.at(-1);
      if (source[next] === ':' && keys) {
        const key = JSON.parse(source.slice(start, i + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return false;
}
