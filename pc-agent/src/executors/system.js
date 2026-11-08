const os = require('os');

/** capability: 'system', action: 'read_system_info' — spec section 9. Cross-platform via Node's os module; no shelling out needed for this one. */
async function readSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg(); // [1m, 5m, 15m] — meaningful on Windows only from Node 20+, still returns [0,0,0] gracefully otherwise
  const nets = os.networkInterfaces();
  const activeNetworks = Object.entries(nets)
    .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => !a.internal).map((a) => ({ name, address: a.address, family: a.family })));

  return {
    success: true,
    data: {
      platform: os.platform(),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      cpuCount: os.cpus().length,
      memory: { totalBytes: totalMem, freeBytes: freeMem, usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100) },
      loadAverage: load,
      network: activeNetworks,
    },
    verification: { verified: true, evidence: { source: 'os.* (live read at execution time)' } },
  };
}

module.exports = { readSystemInfo };
