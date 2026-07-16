// Byte-capped FIFO of output chunks. Whole oldest chunks are evicted when the
// cap is exceeded — VT escape sequences may be split across chunk boundaries
// either way, and xterm.js tolerates a mid-sequence start on replay.
export class RingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly capBytes: number) {}

  push(b: Buffer): void {
    this.chunks.push(b);
    this.bytes += b.length;
    while (this.bytes > this.capBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.length;
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
