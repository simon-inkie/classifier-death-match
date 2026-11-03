// What the space bar does. Pure, so it can be tested in Node.
// Space starts a match, pauses it, or resumes it. It never restarts one (that is the Restart
// button), and it does nothing on the results screen, so a stray press cannot wipe a match.
export function spaceAction({ running, paused, results }) {
  if (results) return 'none';
  if (!running) return 'start';
  return paused ? 'resume' : 'pause';
}
