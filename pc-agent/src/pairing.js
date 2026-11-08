const { CoreClient } = require('./coreClient');
const { loadPairing, savePairing } = require('./config');

async function ensurePaired(config) {
  const client = new CoreClient(config.coreUrl, config.apiKey, config.deviceToken);
  let pairing = loadPairing();

  if (!pairing) {
    console.log(`Registering with xoft-core at ${config.coreUrl} as "${config.deviceName}"...`);
    const device = await client.registerDevice(config.deviceName, 'desktop');
    pairing = { deviceId: device.id };
    savePairing(pairing);
    console.log(`Registered. Device id: ${device.id}`);
  }

  const device = await client.getDevice(pairing.deviceId);
  if (device.trust !== 'trusted') {
    console.log('\nThis device is registered but NOT yet trusted.');
    console.log('From wherever xoft-core runs, a human must explicitly approve it:');
    console.log(`  curl -X POST ${config.coreUrl}/api/devices/${pairing.deviceId}/trust\n`);
    console.log('That command\'s response includes a one-time "deviceToken" — copy it into');
    console.log('this agent\'s config.json as "deviceToken" (or set XOFT_DEVICE_TOKEN) and');
    console.log('restart the agent. It will then use a token scoped to just this device');
    console.log('instead of the shared admin key. It is shown exactly once and cannot be');
    console.log('retrieved again — if lost, revoke and re-trust the device for a new one.\n');
    console.log('Waiting for trust... (checking every 5s, Ctrl+C to stop)');
    await waitUntilTrusted(client, pairing.deviceId);
    console.log('Device trusted. Continuing startup.');
    if (!config.deviceToken) {
      console.log('NOTE: still running with the shared admin key — add the deviceToken above and restart when convenient.');
    }
  }

  return pairing.deviceId;
}

function waitUntilTrusted(client, deviceId) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const device = await client.getDevice(deviceId);
        if (device.trust === 'trusted') {
          clearInterval(interval);
          resolve();
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 5000);
  });
}

module.exports = { ensurePaired };
