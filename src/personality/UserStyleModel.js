import fs from 'node:fs';
import { JsonStore } from '../persistence/JsonStore.js';
import path from 'node:path';

const MAX_SAMPLES = 50;
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/**
 * UserStyleModel — spec section 5. Learns from the user's actual messages
 * how they communicate (sentence length, emoji use, exclamation frequency,
 * casual-marker density) via real computed statistics over recent samples —
 * not a personality clone, just enough signal for XOFT to match register
 * without imitating typos or grammar mistakes.
 */
export class UserStyleModel {
  constructor({ dataDir = './data', sqliteStore = null }) {
    this._store = new JsonStore({ dataDir, fileName: 'user_style.json', kvKey: 'user_style', defaultValue: { samples: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  recordSample(text) {
    if (!text || text.length < 3) return; // too short to carry signal
    const data = this._load();
    data.samples.push({ text, ts: new Date().toISOString() });
    if (data.samples.length > MAX_SAMPLES) data.samples.shift();
    this._save(data);
  }

  /** @returns {object} computed stats over stored samples — empty defaults if none yet */
  stats() {
    const samples = this._load().samples;
    if (samples.length === 0) {
      return { sampleCount: 0, avgWordCount: null, emojiRate: null, exclamationRate: null, casualMarkerRate: null };
    }

    const casualMarkers = /\b(lol|lmao|gonna|wanna|yeah|nah|bro|hey|kinda|sorta|tbh|ngl)\b/gi;
    let totalWords = 0, emojiCount = 0, exclamationCount = 0, casualCount = 0;

    for (const s of samples) {
      totalWords += s.text.trim().split(/\s+/).length;
      emojiCount += (s.text.match(EMOJI_REGEX) ?? []).length;
      exclamationCount += (s.text.match(/!/g) ?? []).length;
      casualCount += (s.text.match(casualMarkers) ?? []).length;
    }

    return {
      sampleCount: samples.length,
      avgWordCount: Math.round(totalWords / samples.length),
      emojiRate: Number((emojiCount / samples.length).toFixed(2)),
      exclamationRate: Number((exclamationCount / samples.length).toFixed(2)),
      casualMarkerRate: Number((casualCount / samples.length).toFixed(2)),
    };
  }

  /** Plain-text summary for injecting into a system prompt. */
  describeForPrompt() {
    const s = this.stats();
    if (s.sampleCount < 5) return ''; // not enough signal yet — say nothing rather than guess
    const parts = [];
    parts.push(s.avgWordCount < 8 ? 'tends to write short messages' : s.avgWordCount > 25 ? 'tends to write longer, detailed messages' : 'writes medium-length messages');
    if (s.emojiRate > 0.3) parts.push('uses emoji sometimes');
    if (s.casualMarkerRate > 0.3) parts.push('writes casually');
    else if (s.casualMarkerRate < 0.05 && s.sampleCount >= 10) parts.push('writes fairly formally');
    return `USER STYLE (match register, don't copy verbatim): the user ${parts.join(', ')}.`;
  }
}
