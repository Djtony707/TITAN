import http from 'node:http';

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send?.({ bound: this.address() }));
  return listen.apply(this, args);
};
await import('../src/index.ts');
