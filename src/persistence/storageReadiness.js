import path from 'node:path';

export function isPathWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Check Linux mountinfo for a non-root filesystem mounted at or above target.
 * Merely setting an environment variable must never be treated as proof that a
 * persistent disk is attached. mountInfo is injectable for deterministic tests.
 */
export function isOnMountedFilesystem(target, mountInfo) {
  if (typeof mountInfo !== 'string' || !target) return false;
  const candidate = path.resolve(target);
  return mountInfo.split('\n').some((line) => {
    const fields = line.split(' ');
    const rawMountPoint = fields[4];
    if (!rawMountPoint) return false;
    const mountPoint = rawMountPoint
      .replace(/\\040/g, ' ')
      .replace(/\\011/g, '\t')
      .replace(/\\134/g, '\\');
    const resolvedMount = path.resolve(mountPoint);
    // Ignore the root filesystem: it is ephemeral in the container.
    return resolvedMount !== path.parse(resolvedMount).root && isPathWithin(resolvedMount, candidate);
  });
}
