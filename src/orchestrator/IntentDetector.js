/**
 * Deterministic memory intent detection.
 *
 * Explicit verbs are required for memory mutations. Ambiguous language is
 * treated as ordinary conversation so a casual sentence cannot delete data.
 */
export const Intent = {
  REMEMBER: 'remember',
  FORGET: 'forget',
  RECALL: 'recall',
  CONVERSATION: 'conversation',
};

function categoryFrom(text) {
  const value = String(text ?? '').toLowerCase();
  for (const category of ['person', 'project', 'preference', 'rule', 'decision', 'task']) {
    if (new RegExp('\b' + category + '(?:s)?\b').test(value)) return category;
  }
  return 'fact';
}

function cleanSubject(text) {
  return String(text ?? '')
    .replace(/^(?:that|this|it|about|to)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim()
    .slice(0, 500) || null;
}

export class IntentDetector {
  async detect(message) {
    const text = String(message ?? '').trim();
    if (!text) return { intent: Intent.CONVERSATION, category: null, subject: null };

    // Recall is checked before remember because "what do you remember" contains
    // the word remember but is a read operation, not a write.
    if (/^(?:what do you remember|what have i told you|what do you know about|recall(?: my)?|show (?:my )?memories)\b/i.test(text)) {
      const subject = text
        .replace(/^(?:what do you remember|what have i told you|what do you know about|recall(?: my)?|show (?:my )?memories)\s*/i, '');
      return { intent: Intent.RECALL, category: categoryFrom(subject), subject: cleanSubject(subject) };
    }

    const forget = text.match(/^(?:please\s+)?(?:forget|erase|remove from memory|delete from memory)(?:\s+(?:that|this|about))?\s*(.*)$/i);
    if (forget) {
      const subject = cleanSubject(forget[1]);
      // Never turn a broad "forget everything" into a destructive wipe.
      if (!subject || /^(?:everything|all|all memories)$/i.test(subject)) {
        return { intent: Intent.CONVERSATION, category: null, subject: null };
      }
      return { intent: Intent.FORGET, category: categoryFrom(subject), subject };
    }

    const remember = text.match(/^(?:please\s+)?(?:remember|note|save)(?:\s+(?:that|this))?\s+(.+)$/i);
    if (remember) {
      const subject = cleanSubject(remember[1]);
      return { intent: Intent.REMEMBER, category: categoryFrom(subject), subject };
    }

    return { intent: Intent.CONVERSATION, category: null, subject: null };
  }
}
