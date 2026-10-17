import { config } from '../config/index.js';

/**
 * GoogleAuth — exchanges a stored refresh token for a short-lived access
 * token. Both GmailService and CalendarService use this; caching the token
 * for its lifetime avoids hitting the token endpoint on every API call.
 *
 * Setup: create an OAuth2 client in Google Cloud Console, run the standard
 * authorization-code flow once (out of band, e.g. via Google's OAuth
 * Playground) with scopes:
 *   https://www.googleapis.com/auth/gmail.modify
 *   https://www.googleapis.com/auth/calendar
 * and put the resulting refresh token in GOOGLE_REFRESH_TOKEN.
 */
class GoogleAuth {
  constructor() {
    this._cachedToken = null;
    this._expiresAt = 0;
  }

  isConfigured() {
    return Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
  }

  async getAccessToken() {
    if (!this.isConfigured()) {
      throw new Error(
        'GoogleAuth: missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN. ' +
          'Google Gmail/Calendar features require these — see README setup section.'
      );
    }
    if (this._cachedToken && Date.now() < this._expiresAt - 30_000) {
      return this._cachedToken;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: config.google.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GoogleAuth: token refresh failed ${res.status} - ${errText}`);
    }

    const data = await res.json();
    this._cachedToken = data.access_token;
    this._expiresAt = Date.now() + data.expires_in * 1000;
    return this._cachedToken;
  }
}

export const googleAuth = new GoogleAuth();
