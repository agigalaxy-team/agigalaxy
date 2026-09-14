// Windows does not deliver POSIX SIGTERM to a Node child. This test-only IPC
// adapter invokes the same registered handler; never loaded by production.
process.on('message', message => {
  if (message === 'stop-fixture') {
    process.emit('SIGTERM');
    process.disconnect();
  }
});
