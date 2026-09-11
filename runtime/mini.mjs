// Parser for the frozen mini-notation subset composer.mjs emits.
//
// Grammar, measured across 600 consecutive scenes and unable to grow without failing
// export.test.mjs:
//   <a b c>   alternation, one element per cycle
//   [x y z]   equal subdivision of the enclosing span
//   [a,b,c]   stack; every element spans the whole slot
//   ~         rest, produces no event
//   integer   a value
//
// Strudel is the authority on what these mean; runtime/mini.test.mjs proves we agree.

// Split on `sep` at bracket depth 0 only.
function splitTop(src, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of src) {
    if (ch === '[' || ch === '<') depth++;
    else if (ch === ']' || ch === '>') depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseNode(src, begin, end, out) {
  const node = src.trim();
  if (node === '' || node === '~') return;

  if (node.startsWith('[') && node.endsWith(']')) {
    const inner = node.slice(1, -1);

    const stacked = splitTop(inner, ',');
    if (stacked.length > 1) {
      for (const part of stacked) parseNode(part, begin, end, out);
      return;
    }

    const steps = splitTop(inner, ' ');
    const width = (end - begin) / steps.length;
    steps.forEach((step, i) => parseNode(step, begin + i * width, begin + (i + 1) * width, out));
    return;
  }

  out.push({ value: Number(node), begin, end });
}

export function parseCycle(pattern, cycle) {
  const out = [];
  let src = String(pattern).trim();

  if (src.startsWith('<') && src.endsWith('>')) {
    const options = splitTop(src.slice(1, -1), ' ');
    const i = ((cycle % options.length) + options.length) % options.length;
    src = options[i];
  }

  parseNode(src, cycle, cycle + 1, out);
  return out;
}
