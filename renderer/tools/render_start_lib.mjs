function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function resolveRenderStart(args, fps) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid fps: ${fps}`);
  const hasStart = hasOwn(args, "start");
  const hasStartFrame = hasOwn(args, "startFrame");
  if (hasStart && hasStartFrame) {
    throw new Error("Use either --start or --startFrame, not both");
  }
  if (hasStartFrame) {
    const startFrame = Number(args.startFrame);
    if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
      throw new Error(`Invalid startFrame: ${args.startFrame}`);
    }
    return { startFrame, start: startFrame / fps };
  }
  if (hasStart) {
    const start = Number(args.start);
    if (!Number.isFinite(start) || start < 0) throw new Error(`Invalid start: ${args.start}`);
    return { startFrame: null, start };
  }
  return { startFrame: 0, start: 0 };
}
