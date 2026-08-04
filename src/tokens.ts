/**
 * Token estimation without a tokenizer dependency.
 *
 * This is deliberately an estimate. Every open-weight family tokenizes
 * differently, and shipping a real tokenizer per model is a lot of weight to
 * carry for a number that only needs to be directionally right. What matters
 * for a loadout is "this tool schema costs about as much as your whole system
 * prompt" — that conclusion survives a 10-15% error bar.
 *
 * Swap in a real tokenizer per model family before showing users a hard
 * context-remaining number they might trust literally.
 */

const WORD = /[A-Za-z0-9']+|[^\sA-Za-z0-9']/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const pieces = text.match(WORD);
  if (!pieces) return 0;
  let total = 0;
  for (const p of pieces) {
    if (/^[A-Za-z']+$/.test(p)) {
      // Common short words are one token; longer words split on subwords at
      // roughly four characters a piece.
      total += p.length <= 4 ? 1 : Math.ceil(p.length / 4);
    } else if (/^[0-9]+$/.test(p)) {
      // Digits tokenize far denser than letters in most BPE vocabularies.
      total += Math.max(1, Math.ceil(p.length / 2));
    } else {
      total += 1;
    }
  }
  return total;
}

export function estimateMessageTokens(parts: string[]): number {
  // ~4 tokens of role/delimiter overhead per message in chat templates.
  return parts.reduce((sum, p) => sum + estimateTokens(p) + 4, 0);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

/** A text meter, because the whole premise is that this stat should be felt. */
export function meter(ratio: number, width = 24): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}
