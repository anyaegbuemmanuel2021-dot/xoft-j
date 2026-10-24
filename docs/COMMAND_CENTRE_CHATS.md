# Command Centre Chat Sessions

XOFT's Command Centre keeps recent conversations in browser storage so switching views or reloading the page does not immediately discard the visible chat history.

## Expected behavior
- The active conversation is restored when the Command Centre mounts.
- Starting a new conversation creates a separate session.
- Selecting a saved session loads its messages without mixing them into another session.
- Conversation titles are derived from the first useful user message and can be shown in the session list.
- Empty or malformed saved entries are ignored rather than crashing the Command Centre.

## Privacy and storage
This browser-side history is local to the browser profile and device. It is not a substitute for server-side backups; clearing site storage or using a private browsing session can remove it. Do not store API keys or other secrets in chat messages.

## Troubleshooting
If history appears stale, reload the app after the latest service worker activates. If the browser has blocked local storage, the chat may work for the current page but not persist between sessions.