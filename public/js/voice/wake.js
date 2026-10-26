// wake.js — wake-phrase matching and the voice command state machine. Pure logic, unit-tested in Node.
// Voice does NOT get its own command architecture: a finished command is handed to `onCommand`, and the
// companion posts it to the same /api/chat entry point the text UI uses — so permissions, approvals,
// per-domain autonomy, missions, journaling and the kill switch all apply identically.

export const DEFAULT_GREETINGS = ['hey', 'hi', 'ok', 'okay', 'hay', 'a'];
export const DEFAULT_NAMES = ['xoft'];
export const RISKY = /\b(delete|remove|erase|wipe|format|deploy|publish|send|uninstall|shutdown|shut down|restart|kill|drop|overwrite|purchase|buy|pay|transfer)\b/i;
const CONFIRM = /^(yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed)\b/i;
const CANCEL = /^(no|nope|cancel|stop|abort|never mind|nevermind)\b/i;

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[a.length][b.length];
}
const clean = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
// Word-level normalisation for MATCHING only. The command text itself keeps the speaker's original words, case and inner
// punctuation, so file names and identifiers ("browser.js", "SocialPulse") survive intact.
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const tidy = (t) => String(t ?? '').replace(/^[\s,.:;!?-]+|[\s,;:!?-]+$/g, '').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();

/**
 * Finds "<greeting> <name>" (name fuzzy-matched, since recognisers hear "xoft" as "soft"/"zoft"/"xoff") near the START of the
 * utterance and returns whatever follows as the command. A bare "xoft" is ignored unless allowBareName — in an always-on
 * pipeline, requiring the greeting keeps ordinary conversation from triggering it.
 */
export function matchWake(transcript, { greetings = DEFAULT_GREETINGS, names = DEFAULT_NAMES, maxEdit = 1, allowBareName = false, maxLeadWords = 2 } = {}) {
  const raw = String(transcript ?? '').trim().split(/\s+/).filter(Boolean);
  const words = raw.map(norm);
  const isName = (w) => w.length > 0 && names.some((n) => lev(w, n) <= (n.length <= 4 ? Math.min(maxEdit, 1) : maxEdit));
  for (let i = 0; i < Math.min(words.length, maxLeadWords + 1); i++) {
    if (isName(words[i])) {
      const greeted = i > 0 && greetings.includes(words[i - 1]);
      if (greeted || (allowBareName && i === 0)) return { matched: true, command: tidy(raw.slice(i + 1).join(' ')), phrase: words.slice(Math.max(0, i - 1), i + 1).join(' ') };
    }
  }
  return { matched: false, command: '', phrase: null };
}

/**
 * VoicePipeline states: idle → wake_listening → awaiting_command → (confirming) → submitting → idle
 * Only text that follows a matched wake phrase ever leaves this object; non-wake speech is discarded unseen.
 */
export class VoicePipeline {
  constructor({ activationWindowMs = 8000, confirmWindowMs = 8000, conversationWindowMs = 45000, conversationMode = false, recognitionGraceMs = 2500, minCommandChars = 2, wake = {}, onState = () => {}, onWake = () => {}, onCommand = () => {}, onNeedConfirm = () => {}, onTimeout = () => {}, onCancel = () => {}, wantRecognizer = () => {} } = {}) {
    Object.assign(this, { activationWindowMs, confirmWindowMs, conversationWindowMs, conversationMode, recognitionGraceMs, minCommandChars, wake, onState, onWake, onCommand, onNeedConfirm, onTimeout, onCancel, wantRecognizer });
    this.state = 'idle'; this._deadline = 0; this._pending = null; this._recognitionDeadline = 0; this._conversationUntil = 0;
  }

  _set(s) { if (this.state !== s) { this.state = s; this.onState(s); } }

  /** Stop recording at VAD end but keep recognition state briefly: STT completes asynchronously after MediaRecorder stops. */
  vad(event) {
    if (event === 'start' && this.state === 'idle') { this._recognitionDeadline = 0; this._set('wake_listening'); this.wantRecognizer(true); }
    if (event === 'end' && this.state === 'wake_listening') {
      this._recognitionDeadline = Date.now() + this.recognitionGraceMs;
      this.wantRecognizer(false);
    }
  }

  transcript(text, isFinal, now = Date.now()) {
    if (this.state === 'wake_listening') {
      const m = matchWake(text, this.wake);
      if (!m.matched) {
        if (isFinal && this.conversationMode && now < this._conversationUntil) {
          this._recognitionDeadline = 0;
          const command = tidy(text);
          if (command.length >= this.minCommandChars) return this._got(command, now);
        }
        if (isFinal && this._recognitionDeadline > 0) { this._recognitionDeadline = 0; this._set('idle'); }
        return;
      }
      if (!isFinal) return;
      this._recognitionDeadline = 0;
      if (this.conversationMode) this._conversationUntil = now + this.conversationWindowMs;
      this.onWake(m.phrase);
      if (m.command.length >= this.minCommandChars) return this._got(m.command, now);
      this._deadline = now + this.activationWindowMs; this._set('awaiting_command'); return;
    }
    if (this.state === 'awaiting_command' && isFinal) {
      const m = matchWake(text, this.wake); const t = (m.matched ? m.command : tidy(text));
      if (t.length >= this.minCommandChars) return this._got(t, now);
      return;
    }
    if (this.state === 'confirming' && isFinal) {
      const t = clean(text);
      if (CONFIRM.test(t)) return this.confirm();
      if (CANCEL.test(t)) return this.cancel('spoken cancel');
    }
  }

  _got(command, now) {
    if (RISKY.test(command)) { this._pending = command; this._deadline = now + this.confirmWindowMs; this._set('confirming'); this.onNeedConfirm(command); return; }
    this._submit(command);
  }

  _submit(command) { this._pending = null; this._set('submitting'); this.wantRecognizer(false); this.onCommand({ text: command, source: 'voice' }); }

  /** UI tap or spoken "yes" for a risky command. Never auto-confirmed; times out to cancel. */
  confirm() { if (this.state === 'confirming' && this._pending) this._submit(this._pending); }
  cancel(reason = 'cancelled') { if (this._pending || this.state !== 'idle') { this._pending = null; this.wantRecognizer(false); this._set('idle'); this.onCancel(reason); } }

  /** Call only after XOFT's spoken reply finishes, so the assistant does not capture its own voice. */
  done() {
    if (this.state === 'submitting') {
      if (this.conversationMode) this._conversationUntil = Date.now() + this.conversationWindowMs;
      this._set('idle');
    }
  }

  tick(now = Date.now()) {
    if ((this.state === 'awaiting_command' || this.state === 'confirming') && now >= this._deadline) {
      const was = this.state; this._pending = null; this.wantRecognizer(false); this._set('idle'); (was === 'confirming' ? this.onCancel : this.onTimeout)(was === 'confirming' ? 'confirmation timed out' : 'no command heard');
    }
    if (this.state === 'wake_listening' && this._recognitionDeadline > 0 && now >= this._recognitionDeadline) {
      this._recognitionDeadline = 0;
      this._set('idle');
    }
  }
}
