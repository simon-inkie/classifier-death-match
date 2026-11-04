// What the space bar does. Pure, so it can be tested in Node.
// Space starts a match, pauses it, or resumes it. It never restarts one (that is the Restart
// button), and it does nothing on the results screen, so a stray press cannot wipe a match.
// During the winner celebration it only skips ahead to the results.
export function spaceAction({ running, paused, results, celebrating = false }) {
  if (celebrating) return 'skip';
  if (results) return 'none';
  if (!running) return 'start';
  return paused ? 'resume' : 'pause';
}
