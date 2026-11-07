// Claim the automatic voice-start attempt once per page load.
// A module-scoped claim intentionally resets on a full reload, so each app
// opening can start voice again while in-page rerenders do not restart it.
let claimed = false;

export function claimAutoVoiceStart() {
  if (claimed) return false;
  claimed = true;
  return true;
}
